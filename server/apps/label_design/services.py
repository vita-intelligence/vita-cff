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


def bootstrap_for_formulation(formulation, *, spec_sheet=None) -> LabelDesign | None:
    """Create a :class:`LabelDesign` for ``formulation`` if one does
    not already exist.

    Called by the signal in :mod:`apps.label_design.signals` when a
    Formulation flips to ``APPROVED``. Idempotent — duplicates are
    impossible thanks to the OneToOne FK, but we still guard with
    ``get_or_create`` so the post_save can fire on every save without
    raising.

    Returns the row (whether new or existing) so the signal can log
    helpfully, or ``None`` if the formulation is not eligible.
    """

    # Only bootstrap when the project is genuinely APPROVED. The
    # caller should already have checked, but defence-in-depth keeps
    # the API safe for any direct service-layer caller.
    from apps.formulations.models import ProjectStatus

    if formulation.project_status != ProjectStatus.APPROVED:
        return None

    existing = LabelDesign.objects.filter(formulation=formulation).first()
    if existing is not None:
        return existing

    label_design = LabelDesign.objects.create(
        organization=formulation.organization,
        formulation=formulation,
        specification_sheet=spec_sheet,
        status=LabelDesignStatus.PAYMENT_PENDING,
    )

    # First transition row is system-authored: actor + actor_client
    # are both NULL, and the from_status is blank to indicate "new".
    LabelDesignTransition.objects.create(
        label_design=label_design,
        from_status="",
        to_status=LabelDesignStatus.PAYMENT_PENDING,
        actor=None,
        actor_client_account=None,
        notes="bootstrap on project approval",
        metadata={"trigger": "formulation_status_approved"},
        created_at=timezone.now(),
    )
    record_audit(
        organization=formulation.organization,
        actor=None,
        action="label_design.bootstrap",
        target=label_design,
        before=None,
        after={"status": LabelDesignStatus.PAYMENT_PENDING},
    )
    return label_design


def _is_anonymous(actor: Any) -> bool:
    """Treat Django's ``AnonymousUser`` as no actor.

    The audit record helper accepts None; passing AnonymousUser would
    blow up on the FK assignment.
    """
    is_anon = getattr(actor, "is_anonymous", False)
    return bool(is_anon)
