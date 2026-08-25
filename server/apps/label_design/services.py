"""State machine + bootstrap services for label-design workflow.

Every status flip on :class:`LabelDesign` MUST go through
:func:`transition_status`. The validator refuses any (from, to) pair
not declared in :data:`apps.label_design.constants.ALLOWED_TRANSITIONS`,
writes a :class:`LabelDesignTransition` row, and records an audit log
entry — all inside a single ``transaction.atomic`` block so the
status, audit row, and side effects either all land or all roll back.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.utils import timezone

from apps.audit.services import record as record_audit
from apps.label_design.constants import (
    ALLOWED_TRANSITIONS,
    MAX_CUSTOMER_REJECTIONS_BEFORE_HOLD,
    LabelDesignStatus,
)
from apps.label_design.models import LabelDesign, LabelDesignTransition


class InvalidStatusTransition(Exception):
    """Raised when a caller asks for a (from, to) pair not in the
    workflow graph. Surfaces a 400 in the API layer with a stable
    ``api_code`` for the frontend to translate.
    """

    api_code = "label_design.invalid_status_transition"


class CustomerRejectionLimitReached(Exception):
    """Internal signal — the customer just exceeded the rejection
    threshold. The transition service catches this and routes the
    workflow into ``ON_HOLD`` instead of bouncing back to design.
    """

    api_code = "label_design.customer_rejection_limit"


@transaction.atomic
def transition_status(
    label_design: LabelDesign,
    *,
    to_status: str,
    actor: Any = None,
    actor_client: Any = None,
    notes: str = "",
    metadata: dict[str, Any] | None = None,
) -> LabelDesign:
    """Move ``label_design`` to ``to_status`` and stamp the audit row.

    Exactly one of ``actor`` / ``actor_client`` should be set —
    staff-driven transitions pass ``actor`` (User), portal-driven
    transitions pass ``actor_client`` (ClientAccount). The system
    bootstrap pathway (signal on spec customer-sign) passes neither
    and the row reads as "system".

    Returns the persisted ``label_design`` instance, refreshed from
    the DB so the caller sees the new status.
    """

    if to_status == label_design.status:
        # No-op — keeps history clean of accidental re-clicks. The
        # caller still gets a returned instance so the API surface is
        # idempotent.
        return label_design

    allowed = ALLOWED_TRANSITIONS.get(label_design.status, frozenset())
    if to_status not in allowed:
        raise InvalidStatusTransition(
            f"{label_design.status} -> {to_status} is not an allowed transition"
        )

    previous_status = label_design.status

    # Customer-rejection bookkeeping. The CUSTOMER_APPROVAL ->
    # DESIGN_IN_PROGRESS edge is the rejection path; we bump the
    # counter BEFORE the transition lands so the auto-hold can
    # divert ``to_status`` if the threshold is crossed.
    routed_to_status = to_status
    rejection_bump = (
        previous_status == LabelDesignStatus.CUSTOMER_APPROVAL
        and to_status == LabelDesignStatus.DESIGN_IN_PROGRESS
        and actor_client is not None
    )
    update_fields = ["status", "updated_at"]
    if rejection_bump:
        label_design.rejection_count = label_design.rejection_count + 1
        update_fields.append("rejection_count")
        if label_design.rejection_count >= MAX_CUSTOMER_REJECTIONS_BEFORE_HOLD:
            routed_to_status = LabelDesignStatus.ON_HOLD

    # Reset the rejection counter the moment the customer approves —
    # the next cycle starts fresh.
    if (
        previous_status == LabelDesignStatus.CUSTOMER_APPROVAL
        and to_status == LabelDesignStatus.LABEL_APPROVED
        and label_design.rejection_count > 0
    ):
        label_design.rejection_count = 0
        update_fields.append("rejection_count")

    label_design.status = routed_to_status
    label_design.save(update_fields=update_fields)

    LabelDesignTransition.objects.create(
        label_design=label_design,
        from_status=previous_status,
        to_status=routed_to_status,
        actor=actor if actor is not None and not _is_anonymous(actor) else None,
        actor_client_account=actor_client,
        notes=(notes or "").strip(),
        metadata=metadata or {},
    )

    record_audit(
        organization=label_design.organization,
        actor=actor if actor is not None and not _is_anonymous(actor) else None,
        action="label_design.status_transition",
        target=label_design,
        before={"status": previous_status},
        after={
            "status": routed_to_status,
            "requested": to_status,
            "rejection_count": label_design.rejection_count,
        },
    )

    label_design.refresh_from_db()
    return label_design


def bootstrap_for_spec(spec_sheet) -> LabelDesign | None:
    """Create-or-return the :class:`LabelDesign` for the formulation
    that ``spec_sheet`` belongs to.

    Exactly one LabelDesign per formulation — enforced by the DB
    constraint installed in migration 0005. Revised spec sheets on
    the same project reuse the existing row rather than spawning a
    second label workflow. Labels are per-product; a spec revision
    on the same product doesn't change the artwork surface.

    Filters out draft-kind specs: only a customer-signed **final**
    spec authorises production, which is what unlocks the label
    workflow. Signed drafts are the customer accepting the proposal,
    not the finished-product spec.

    Returns the row (new or existing) so the signal can log
    helpfully, or ``None`` if the spec is not eligible (draft kind,
    project not yet approved, or no formulation attached).
    """

    from apps.formulations.models import ProjectStatus
    from apps.specifications.models import SpecificationDocumentKind

    formulation = getattr(
        getattr(spec_sheet, "formulation_version", None), "formulation", None
    )
    if formulation is None:
        return None
    if formulation.project_status != ProjectStatus.APPROVED:
        return None

    # Only final specs kick off the label workflow. Draft signatures
    # are the customer signing the PROPOSAL — that phase doesn't own
    # any label artwork.
    if getattr(spec_sheet, "document_kind", None) != SpecificationDocumentKind.FINAL:
        return None

    existing = LabelDesign.objects.filter(formulation=formulation).first()
    if existing is not None:
        # Keep the existing row's spec pointer — it's an audit anchor
        # to the spec that originally triggered the bootstrap. Later
        # revisions ARE the same product for label purposes.
        return existing

    # Skip the PAYMENT_PENDING stage when the customer already paid
    # 100% up-front (``proposal.deposit_percent = 100``) — there's
    # no final payment owed, so the label workflow starts directly
    # at LABEL_PATH_PENDING. Same logic as the deposit-side skip:
    # a 0% edge means no gate applies.
    from decimal import Decimal
    from apps.proposals.models import ProposalLine, ProposalStatus

    accepted_line = (
        ProposalLine.objects.filter(
            formulation_version__formulation=formulation,
            proposal__status=ProposalStatus.ACCEPTED.value,
        )
        .select_related("proposal")
        .order_by("-proposal__updated_at")
        .first()
    )
    skip_payment_stage = False
    if accepted_line and accepted_line.proposal.deposit_percent is not None:
        try:
            skip_payment_stage = (
                Decimal(accepted_line.proposal.deposit_percent) >= Decimal("100")
            )
        except Exception:  # noqa: BLE001
            skip_payment_stage = False

    initial_status = (
        LabelDesignStatus.LABEL_PATH_PENDING
        if skip_payment_stage
        else LabelDesignStatus.PAYMENT_PENDING
    )

    label_design = LabelDesign.objects.create(
        organization=formulation.organization,
        formulation=formulation,
        specification_sheet=spec_sheet,
        status=initial_status,
    )

    # First transition row is system-authored: actor + actor_client
    # are both NULL, and the from_status is blank to indicate "new".
    LabelDesignTransition.objects.create(
        label_design=label_design,
        from_status="",
        to_status=initial_status,
        actor=None,
        actor_client_account=None,
        notes=(
            "bootstrap on customer spec sign — deposit was 100%, "
            "skipping payment stage"
            if skip_payment_stage
            else "bootstrap on customer spec sign"
        ),
        metadata={
            "trigger": "spec_customer_signed",
            "spec_sheet_id": str(spec_sheet.pk),
            "skip_payment_stage": skip_payment_stage,
        },
        created_at=timezone.now(),
    )
    record_audit(
        organization=formulation.organization,
        actor=None,
        action="label_design.bootstrap",
        target=label_design,
        before=None,
        after={
            "status": initial_status,
            "spec_sheet_id": str(spec_sheet.pk),
            "skip_payment_stage": skip_payment_stage,
        },
    )

    # If the FINAL payment for this formulation is already approved
    # (bootstrap raced the payment approval, or the label workflow
    # is being back-filled after the fact), advance PAYMENT_PENDING
    # → LABEL_PATH_PENDING right away so the customer isn't stuck
    # staring at "Awaiting final payment" for a paid project.
    advance_label_if_final_paid(formulation)
    return label_design


def advance_label_if_final_paid(formulation) -> None:
    """Auto-advance a label workflow past ``PAYMENT_PENDING`` when the
    FINAL payment for the formulation is already approved.

    Called from two places:

    * :func:`bootstrap_for_spec` after the row is created, so a label
      bootstrapped after the FINAL was approved isn't stuck at the
      payment gate.
    * :func:`apps.payments.services.approve_payment` when a FINAL
      payment lands, so a label bootstrapped before payment approval
      moves forward the moment finance clicks approve.

    Idempotent: no-op when the label is past ``PAYMENT_PENDING`` OR
    when no approved FINAL payment exists yet. Silent on any
    transition error — never blocks the payment or bootstrap.
    """

    from apps.payments.constants import PaymentKind, PaymentStatus
    from apps.payments.models import Payment

    label_design = LabelDesign.objects.filter(formulation=formulation).first()
    if label_design is None:
        return
    if label_design.status != LabelDesignStatus.PAYMENT_PENDING:
        return

    has_approved_final = Payment.objects.filter(
        formulation=formulation,
        kind=PaymentKind.FINAL,
        status=PaymentStatus.APPROVED,
    ).exists()
    if not has_approved_final:
        return

    try:
        transition_status(
            label_design,
            to_status=LabelDesignStatus.LABEL_PATH_PENDING,
            notes="FINAL payment approved — payment gate cleared",
            metadata={"trigger": "final_payment_approved"},
        )
    except InvalidStatusTransition:  # pragma: no cover — belt + braces
        pass


def advance_label_after_design_fee_paid(formulation) -> None:
    """Advance a label workflow past ``DESIGN_FEE_PENDING`` when the
    ``LABEL_DESIGN`` payment for the formulation lands as APPROVED.

    Called from :func:`apps.payments.services.approve_payment` on
    every LABEL_DESIGN approval. Idempotent no-op when the label
    isn't in ``DESIGN_FEE_PENDING`` or no matching label workflow
    exists.
    """

    label_design = LabelDesign.objects.filter(formulation=formulation).first()
    if label_design is None:
        return
    if label_design.status != LabelDesignStatus.DESIGN_FEE_PENDING:
        return

    try:
        transition_status(
            label_design,
            to_status=LabelDesignStatus.DESIGN_PREFERENCES_PENDING,
            notes="LABEL_DESIGN fee approved — brief step unlocked",
            metadata={"trigger": "label_design_fee_approved"},
        )
    except InvalidStatusTransition:  # pragma: no cover — belt + braces
        pass


def bootstrap_for_formulation(
    formulation, *, spec_sheet=None
) -> LabelDesign | None:
    """Backwards-compatible shim around :func:`bootstrap_for_spec`.

    Older callers (tests, ad-hoc shells, a no-longer-fired
    formulation signal) pass a project + maybe a spec. Route them
    to the per-spec path so the new uniqueness rule is honoured.
    When no spec is known, locate the latest customer-signed
    spec for the project — that mirrors the original behaviour
    where the formulation signal hunted for it itself.
    """

    if spec_sheet is None:
        spec_sheet = _find_signed_spec_sheet(formulation)
    if spec_sheet is None:
        return None
    return bootstrap_for_spec(spec_sheet)


def _find_signed_spec_sheet(formulation):
    """Locate the most-recent customer-signed final spec sheet for
    ``formulation``, if one exists. Lifted from the old formulation
    signal so the back-compat shim above can reuse it.
    """

    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
        SpecificationStatus,
    )

    final_accepted = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation,
            customer_signed_at__isnull=False,
            document_kind=SpecificationDocumentKind.FINAL,
            status=SpecificationStatus.ACCEPTED,
        )
        .order_by("-customer_signed_at")
        .first()
    )
    if final_accepted is not None:
        return final_accepted
    return (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation,
            customer_signed_at__isnull=False,
        )
        .order_by("-customer_signed_at")
        .first()
    )


def _is_anonymous(actor: Any) -> bool:
    """Treat Django's ``AnonymousUser`` as no actor.

    The audit record helper accepts None; passing AnonymousUser would
    blow up on the FK assignment.
    """
    is_anon = getattr(actor, "is_anonymous", False)
    return bool(is_anon)
