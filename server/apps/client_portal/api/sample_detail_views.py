"""Per-sample pipeline detail for the customer portal.

Sample-kit orders (RTG products the customer paid for on the portal)
live outside the custom-formulation project surface — there's no
Proposal, no spec sheet, no label design. The pipeline the customer
follows is the fulfilment journey on our side:

    Ordered
        │  payment.created_at
        ▼
    Payment confirmed
        │  payment.approved_at (finance signs off)
        ▼
    Preparing
        │  TrialBatch created + PSP MO created (status draft/scheduled)
        ▼
    In production
        │  PSP MO status = in_progress
        ▼
    Ready
        │  PSP MO status = completed

The PSP MO chain is the source of truth for the last three stages.
We call ``PspClient.get_manufacturing_order_chain`` (soft-fail) and
project the root MO's status onto customer-friendly labels. PSP
soft-failures (integration off, unreachable) leave the tail stages
in ``future`` — the customer still sees the pipeline, just without
the last-mile status.

Ownership is a simple check: the payment's ``customer_id`` must sit
in the union of Customer ids the account can read through (same
mechanism the rest of the portal uses so dupe-email rows don't lock
a legitimate customer out).
"""

from __future__ import annotations

from typing import Any

from django.shortcuts import get_object_or_404
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.pipeline_copy import (
    PHASE_CURRENT_NOTE as _PHASE_CURRENT_NOTE,
    PHASE_CURRENT_TITLE as _PHASE_CURRENT_TITLE,
    PHASE_TO_REACHED_STAGE as _PHASE_TO_REACHED_STAGE,
    phase_key as _phase_key,
)
from apps.payments.constants import PaymentKind, PaymentStatus
from apps.payments.models import Payment
from apps.trial_batches.models import TrialBatch


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: Any) -> str | None:
    return dt.isoformat() if dt else None


def _decimal_str(value: Any) -> str | None:
    if value is None:
        return None
    return format(value, "f")


def _formulation_display(formulation: Any) -> str:
    """Human name the customer recognises — rtg_display_name is the
    marketing string ("Ultimate Fat Burner Drink"); code / name are
    the internal labels. Prefer the marketing one, fall back."""

    if formulation is None:
        return "Sample kit"
    display = (
        getattr(formulation, "rtg_display_name", "")
        or getattr(formulation, "name", "")
        or getattr(formulation, "code", "")
        or ""
    ).strip()
    return display or "Sample kit"


# PSP MO statuses mapped to which pipeline stage they satisfy.
# ``draft`` / ``scheduled`` — the MO exists but production hasn't
# started. That satisfies "Preparing" (we've booked the run) but not
# "In production". ``in_progress`` satisfies through "In production".
# ``completed`` satisfies all the way to "Ready". ``cancelled`` is
# the terminal-bad state — the pipeline collapses to a cancellation
# notice on the FE (out of scope for this v1; treated as "future"
# from Preparing onwards so no false "in production" chip lights).
#
# Used as a fallback only — the PSP OrderWizard snapshot's ``phase``
# is the primary signal (see ``_reached_stage_from_snapshot``). MO
# status is what we've always had; snapshot is the richer view we
# added when the customer asked for the actual "which internal step
# are we on right now" detail.
_MO_STATUS_TO_REACHED_STAGE: dict[str, str] = {
    "draft": "preparing",
    "scheduled": "preparing",
    "in_progress": "in_production",
    "completed": "ready",
}


def _build_pipeline(
    *,
    payment: Payment,
    trial_batch: TrialBatch | None,
    mo_chain: list[dict] | None,
    snapshot: dict | None,
) -> list[dict]:
    """Five customer-facing stages, always in this order.

    Priority of signals for the production stages (Preparing → In
    production → Ready):

      1. PSP ``OrderWizard`` snapshot phase (richest — carries the
         actual "which internal step" tag PSP operators see).
      2. PSP MO chain root status (coarser — only 4 buckets, but
         works when snapshot fetch soft-fails).
      3. Nothing on PSP yet → everything from Preparing onwards is
         ``future`` and the customer sees "waiting on us".

    Voided payments short-circuit the whole thing: Payment confirmed
    is marked ``skipped`` (struck through) and every downstream
    stage is ``future`` — there's nothing being made and never
    will be until finance re-issues the payment.
    """

    # 1. Ordered — always done (the customer clicked pay).
    # 2. Payment confirmed — done iff payment.status = APPROVED,
    #    skipped iff voided (a cancelled payment isn't "waiting").
    payment_approved = payment.status == PaymentStatus.APPROVED
    payment_voided = payment.status == PaymentStatus.VOIDED

    # Snapshot phase wins over MO status when available.
    phase_key = _phase_key(snapshot)
    reached_from_phase = _PHASE_TO_REACHED_STAGE.get(phase_key)

    mo_root = _root_mo(mo_chain) if mo_chain else None
    mo_status = (mo_root.get("status") if mo_root else "") or ""
    reached_from_mo = _MO_STATUS_TO_REACHED_STAGE.get(mo_status)

    reached = reached_from_phase or reached_from_mo

    # Note copy for the current stage — prefer the customer-facing
    # phase note (specific to the wizard step), fall back to a
    # coarse "we're on it" line.
    current_stage_note = _PHASE_CURRENT_NOTE.get(phase_key, "")

    stages: list[dict] = [
        {
            "key": "ordered",
            "label": "Ordered",
            "state": "done",
            "completed_at": _iso(payment.created_at),
            "note": None,
        },
    ]

    if payment_voided:
        # Voided payment — no production is happening, no production
        # will happen. Payment stage renders as ``skipped`` (struck
        # through) so the customer sees the payment step was reached
        # then cancelled, not "still waiting on finance".
        stages.append(
            {
                "key": "payment_confirmed",
                "label": "Payment cancelled",
                "state": "skipped",
                "completed_at": None,
                "note": "This sample payment was voided — no batch will be produced against it.",
            }
        )
        for key, label in (
            ("preparing", "Preparing"),
            ("in_production", "In production"),
            ("ready", "Ready"),
        ):
            stages.append(
                {
                    "key": key,
                    "label": label,
                    "state": "future",
                    "completed_at": None,
                    "note": None,
                }
            )
        return stages

    stages.append(
        {
            "key": "payment_confirmed",
            "label": "Payment confirmed",
            "state": "done" if payment_approved else "current",
            "completed_at": _iso(payment.approved_at) if payment_approved else None,
            "note": None
            if payment_approved
            else "Our finance team is reviewing your payment.",
        }
    )

    if not payment_approved:
        # Payment still under review — everything after is future.
        for key, label in (
            ("preparing", "Preparing"),
            ("in_production", "In production"),
            ("ready", "Ready"),
        ):
            stages.append(
                {
                    "key": key,
                    "label": label,
                    "state": "future",
                    "completed_at": None,
                    "note": None,
                }
            )
        return stages

    # Preparing — done when we've kicked production planning past
    # "Preparing" (reached in_production or ready). Otherwise this
    # is the current stage; use the phase's specific copy.
    preparing_done = reached in ("in_production", "ready")
    preparing_state = "done" if preparing_done else "current"
    preparing_note = (
        None
        if preparing_done
        else (
            current_stage_note
            if reached_from_phase is None or reached_from_phase == "preparing"
            else "Our lab is preparing your sample batch."
        )
    )
    stages.append(
        {
            "key": "preparing",
            "label": "Preparing",
            "state": preparing_state,
            "completed_at": _iso(trial_batch.updated_at)
            if preparing_done and trial_batch
            else None,
            "note": preparing_note,
        }
    )

    # In production — done when we've reached "ready".
    in_production_done = reached == "ready"
    in_production_state = _state_for(
        payment_approved=True,
        previous_done=preparing_done,
        this_done=in_production_done,
    )
    in_production_note = (
        current_stage_note
        if in_production_state == "current"
        and reached_from_phase in ("in_production",)
        else (
            "Your sample is being manufactured."
            if in_production_state == "current"
            else None
        )
    )
    stages.append(
        {
            "key": "in_production",
            "label": "In production",
            "state": in_production_state,
            "completed_at": None,
            "note": in_production_note,
        }
    )

    # Ready — done when PSP marks the sample dispatched / delivered.
    # ``in_production`` bucket covers closeout / final_release too,
    # so "ready" here means "customer can receive it".
    ready_done = phase_key in ("dispatched", "delivered")
    ready_state = _state_for(
        payment_approved=True,
        previous_done=in_production_done,
        this_done=ready_done,
    )
    ready_note = (
        current_stage_note
        if ready_state == "current" and reached_from_phase == "ready"
        else (
            "We'll be in touch to arrange delivery."
            if ready_state == "current"
            else None
        )
    )
    stages.append(
        {
            "key": "ready",
            "label": "Ready",
            "state": ready_state,
            "completed_at": None,
            "note": ready_note,
        }
    )

    return stages


def _state_for(
    *, payment_approved: bool, previous_done: bool, this_done: bool
) -> str:
    if not payment_approved or not previous_done:
        return "future"
    if this_done:
        return "done"
    return "current"


def _root_mo(chain: list[dict]) -> dict | None:
    """The finished-product MO — the ``is_root`` row PSP flags. Empty
    chain / no-root falls through as None so the pipeline treats the
    MO status as absent."""

    for row in chain:
        if row.get("is_root"):
            return row
    return chain[0] if chain else None


def _build_next_action(
    *,
    payment: Payment,
    mo_chain: list[dict] | None,
    snapshot: dict | None,
) -> dict | None:
    """"Current status" callout at the top of the sample detail.

    Copy comes from the ``_PHASE_CURRENT_TITLE`` / ``_PHASE_CURRENT_NOTE``
    tables above — NEVER from PSP's ``next_action.title`` /
    ``next_action.detail``. PSP writes those for operators
    ("Open MO MO00051 to finish bookings and signatures") which
    make no sense to a customer who can't open MOs. We use only
    the phase key (a coarse, safe atom) to pick our own copy.

    Priority:

    1. Payment still under review — finance-facing copy.
    2. PSP snapshot's phase → look up customer-safe title + note.
    3. PSP MO chain fallback (draft / in_progress / completed).
    4. Nothing on PSP yet — generic "we'll start soon".
    """

    if payment.status == PaymentStatus.VOIDED:
        return {
            "kind": "cancelled",
            "title": "Sample payment cancelled",
            "description": (
                "This payment was voided — no sample batch will be produced. "
                "If you'd like to place the order again, we'll issue a fresh "
                "payment request."
            ),
        }
    if payment.status != PaymentStatus.APPROVED:
        return {
            "kind": "waiting_finance",
            "title": "Waiting for finance",
            "description": "Our team usually confirms sample payments the same working day.",
        }

    phase_key = _phase_key(snapshot)
    if phase_key and phase_key in _PHASE_CURRENT_TITLE:
        return {
            "kind": f"psp:{phase_key}",
            "title": _PHASE_CURRENT_TITLE[phase_key],
            "description": _PHASE_CURRENT_NOTE.get(
                phase_key,
                "Your sample is moving through our production pipeline.",
            ),
        }

    # Fallback: no snapshot from PSP (or a phase we don't map) —
    # use the MO chain if we have it, else generic queued copy.
    mo_root = _root_mo(mo_chain) if mo_chain else None
    mo_status = (mo_root.get("status") if mo_root else "") or ""

    if mo_status == "completed":
        return {
            "kind": "ready",
            "title": "Your sample is ready",
            "description": "We'll email you to confirm delivery details.",
        }
    if mo_status == "in_progress":
        return {
            "kind": "in_production",
            "title": "In production",
            "description": "Your sample is being made in our lab right now.",
        }
    if mo_status in ("draft", "scheduled"):
        return {
            "kind": "preparing",
            "title": "Preparing your sample",
            "description": "Our lab has your order in the queue.",
        }
    return {
        "kind": "queued",
        "title": "Sample confirmed",
        "description": "We'll start preparing your sample shortly.",
    }


def _mo_chain_or_none(payment: Payment, trial_batch: TrialBatch | None) -> list[dict] | None:
    """Fetch the PSP MO chain for the sample's linked trial batch.
    Silent-degradation: PSP off / decryption failed / unreachable ⇒
    None. The pipeline still renders, tail stages sit in ``future``."""

    if trial_batch is None:
        return None
    mo_uuid = getattr(trial_batch, "psp_manufacturing_order_uuid", None)
    if not mo_uuid:
        return None

    # Local import to keep the PSP client out of the hot import path
    # for portal requests that don't need it (payment not yet
    # approved, trial batch not yet created).
    from apps.psp.services import get_psp_manufacturing_order_chain

    try:
        payload = get_psp_manufacturing_order_chain(
            organization=payment.organization, mo_uuid=mo_uuid
        )
    except Exception:
        # get_psp_manufacturing_order_chain is expected to soft-degrade
        # to None; belt-and-braces against a mis-behaving future patch.
        return None
    if not isinstance(payload, dict):
        return None
    chain = payload.get("chain")
    return chain if isinstance(chain, list) else None


def _co_snapshot_or_none(payment: Payment) -> dict | None:
    """Fetch PSP's OrderWizard snapshot for the sample's CO.

    The CO's ``uuid`` on PSP was planted from the sample payment id
    at sync time (``NpdSync.upsert_sample_from_npd``), so we look up
    by ``payment.id``.

    Same silent-degrade posture as the MO chain fetch — the pipeline
    falls back to MO-status-only when this is None."""

    from apps.psp.services import get_psp_customer_order_snapshot

    try:
        payload = get_psp_customer_order_snapshot(
            organization=payment.organization, co_uuid=payment.id
        )
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    snapshot = payload.get("snapshot")
    return snapshot if isinstance(snapshot, dict) else None


# ---------------------------------------------------------------------------
# View
# ---------------------------------------------------------------------------


class PortalSampleDetailView(PortalAPIView):
    """``GET /api/portal/samples/<payment_id>/`` — pipeline + status
    for one sample the customer paid for."""

    def get(self, request: Request, payment_id) -> Response:
        from apps.client_portal.queries import customer_ids_for_account

        customer_ids = customer_ids_for_account(request.user)
        # Ownership: the payment must be a sample kit (kind=FINAL +
        # formulation.project_type=ready_to_go — same discriminator
        # the activity feed uses) that belongs to one of the account's
        # Customer ids. A leaked uuid to a non-owner surfaces as 404.
        payment = get_object_or_404(
            Payment.objects.select_related("formulation", "organization"),
            id=payment_id,
            kind=PaymentKind.FINAL,
            formulation__project_type="ready_to_go",
            customer_id__in=customer_ids,
        )

        # Trial batch is optional — the sample may still be in the
        # /samples fulfilment queue on R&D (payment approved, no batch
        # created yet). We surface the "Preparing" stage as future in
        # that case so the customer sees nothing has started yet.
        trial_batch = (
            TrialBatch.objects.filter(source_payment_id=payment.id)
            .select_related("formulation_version__formulation")
            .order_by("-created_at")
            .first()
        )

        mo_chain = _mo_chain_or_none(payment, trial_batch)
        # PSP CO snapshot is the richest source — carries the actual
        # OrderWizard phase + operator's next-action copy so the
        # customer sees the same specificity the PSP /projects page
        # shows ("Need MO creation", "Awaiting ingredients", etc.).
        # Only fires when payment is approved (before that PSP has
        # nothing on this order).
        snapshot = (
            _co_snapshot_or_none(payment)
            if payment.status == PaymentStatus.APPROVED
            else None
        )

        # Final Product Release documents attached to PSP's root MO.
        # Empty until the release ceremony completes on PSP; on
        # completion the customer sees CoA, BMR, micro report, label
        # proof + retain-sample record. Silent-degrade posture — a
        # PSP outage or unresolved CO returns [] rather than blocking
        # the whole detail page.
        release_documents = (
            _release_documents_or_empty(payment)
            if payment.status == PaymentStatus.APPROVED
            else []
        )

        # Dispatch-confirmation snapshot — what the coordinator filled
        # + what the operator captured at truck arrival. ``None`` until
        # PSP has a picked_up shipment; the FE hides the card for that
        # case. Same APPROVED gate as release_documents so unpaid
        # samples don't leak downstream operational data.
        dispatch = (
            _dispatch_or_none(payment)
            if payment.status == PaymentStatus.APPROVED
            else None
        )

        return Response(
            {
                "sample": {
                    "id": str(payment.id),
                    "code": (getattr(payment.formulation, "code", "") or ""),
                    "name": _formulation_display(payment.formulation),
                    "amount": _decimal_str(payment.amount),
                    "currency": payment.currency or "GBP",
                    "ordered_at": _iso(payment.created_at),
                    "updated_at": _iso(payment.updated_at),
                    "status_key": payment.status,
                },
                "pipeline": _build_pipeline(
                    payment=payment,
                    trial_batch=trial_batch,
                    mo_chain=mo_chain,
                    snapshot=snapshot,
                ),
                "next_action": _build_next_action(
                    payment=payment,
                    mo_chain=mo_chain,
                    snapshot=snapshot,
                ),
                "release_documents": release_documents,
                "dispatch": dispatch,
            }
        )


def _dispatch_or_none(payment: Payment) -> dict | None:
    """Fetch the PSP dispatch snapshot for this payment's CO.

    Silent-degrade contract: PSP off / unreachable / no CO / no
    ``picked_up`` shipment yet → ``None``. The portal FE renders the
    Dispatch card only when the value is a non-null dict.
    """

    from apps.psp.services import get_psp_dispatch_for_payment

    try:
        return get_psp_dispatch_for_payment(payment=payment)
    except Exception:
        return None


def _release_documents_or_empty(payment: Payment) -> list[dict]:
    """Fetch Final Release doc metadata from PSP for this payment's CO.

    Silent-degrade contract mirrors ``_mo_chain_or_none`` /
    ``_co_snapshot_or_none``: PSP off / unreachable / no CO / release
    ceremony not done → ``[]``. The portal FE renders the section only
    when the list is non-empty."""

    from apps.psp.services import list_psp_release_documents_for_payment

    try:
        rows = list_psp_release_documents_for_payment(payment=payment)
    except Exception:
        return []

    return rows if isinstance(rows, list) else []


class PortalSampleReleaseDocumentView(PortalAPIView):
    """``GET /api/portal/samples/<payment_id>/release-documents/<file_uuid>/``
    — proxy-download one Final Release document for a customer.

    Ownership: same check as :class:`PortalSampleDetailView` — the
    payment must be a sample kit (kind=FINAL + RTG formulation) that
    belongs to one of the account's Customer ids. File bytes come
    from PSP (source of truth); NPD is a pass-through with the
    ownership guard bolted on here so a leaked file uuid can't be
    downloaded by an unrelated account.

    Content-Type + Content-Disposition flow through from PSP so PDFs
    render inline in the portal iframe and non-PDFs download normally.
    """

    def get(self, request: Request, payment_id, file_uuid) -> Response:
        from apps.client_portal.queries import customer_ids_for_account
        from apps.psp.services import fetch_psp_release_document_for_payment
        from django.http import HttpResponse

        customer_ids = customer_ids_for_account(request.user)
        payment = get_object_or_404(
            Payment.objects.select_related("formulation", "organization"),
            id=payment_id,
            kind=PaymentKind.FINAL,
            formulation__project_type="ready_to_go",
            customer_id__in=customer_ids,
        )

        result = fetch_psp_release_document_for_payment(
            payment=payment, file_uuid=file_uuid
        )
        if result is None:
            raise NotFound("release_document_not_found")

        body, mime, filename = result

        # Inline for PDFs (portal iframe preview), download for
        # everything else. Filename passes through so the browser
        # save-as suggestion matches what PSP recorded.
        disposition = (
            "inline" if (mime or "").lower().startswith("application/pdf")
            else "attachment"
        )
        response = HttpResponse(body, content_type=mime)
        response["Content-Disposition"] = (
            f'{disposition}; filename="{filename}"'
        )
        response["Cache-Control"] = "no-store, no-cache, must-revalidate"
        return response


class PortalSampleDispatchConfirmView(PortalAPIView):
    """``POST /api/portal/samples/<payment_id>/dispatch/confirm-delivery/``
    — customer confirms receipt of their sample.

    Body: ``{"recipient_signatory": "Alex Baker",
              "delivery_notes": "Arrived intact" }``

    Ownership: same account → customer id union guard as the sample
    detail view. The confirmation flows through NPD → PSP; on the
    PSP side ``delivered_by_id`` stays nil (portal customers aren't
    PSP users) and ``recipient_signatory`` carries the identity.

    Responses:
      * 200 — ``{"dispatch": {...updated snapshot}}``
      * 400 — missing signatory
      * 404 — no picked-up shipment / unknown CO
      * 409 — already delivered (idempotency guard)
      * 502 — PSP unreachable / off
    """

    def post(self, request: Request, payment_id) -> Response:
        from apps.client_portal.queries import customer_ids_for_account
        from apps.psp.services import (
            confirm_psp_dispatch_delivery_for_payment,
        )

        customer_ids = customer_ids_for_account(request.user)
        payment = get_object_or_404(
            Payment.objects.select_related(
                "formulation", "organization", "customer"
            ),
            id=payment_id,
            kind=PaymentKind.FINAL,
            formulation__project_type="ready_to_go",
            customer_id__in=customer_ids,
        )

        signatory = (request.data.get("recipient_signatory") or "").strip()
        if not signatory:
            # Fall back to the customer's saved profile name — the
            # portal UI pre-fills the modal with this but we
            # double-check server-side so a stripped payload can't
            # slip through.
            signatory = (getattr(payment.customer, "name", "") or "").strip()
        if not signatory:
            return Response(
                {"detail": "recipient_signatory_required"}, status=400
            )

        notes = (request.data.get("delivery_notes") or "").strip()

        result = confirm_psp_dispatch_delivery_for_payment(
            payment=payment,
            recipient_signatory=signatory,
            delivery_notes=notes,
        )
        if result is None:
            return Response(
                {"detail": "confirmation_failed"}, status=502
            )
        return Response(result, status=200)


class PortalSampleDispatchPhotoView(PortalAPIView):
    """``GET /api/portal/samples/<payment_id>/dispatch/photos/<file_uuid>/``
    — proxy-download one truck-arrival photo for a customer.

    Ownership: identical check to :class:`PortalSampleReleaseDocumentView`
    (payment must be an RTG sample kit owned by one of the account's
    Customer ids). Bytes flow through from PSP; the guard here stops
    a leaked file uuid from downloading for an unrelated account.

    Photos are always image/* — always render inline in the portal
    dispatch card thumbnails / lightbox.
    """

    def get(self, request: Request, payment_id, file_uuid) -> Response:
        from apps.client_portal.queries import customer_ids_for_account
        from apps.psp.services import fetch_psp_dispatch_photo_for_payment
        from django.http import HttpResponse

        customer_ids = customer_ids_for_account(request.user)
        payment = get_object_or_404(
            Payment.objects.select_related("formulation", "organization"),
            id=payment_id,
            kind=PaymentKind.FINAL,
            formulation__project_type="ready_to_go",
            customer_id__in=customer_ids,
        )

        result = fetch_psp_dispatch_photo_for_payment(
            payment=payment, file_uuid=file_uuid
        )
        if result is None:
            raise NotFound("dispatch_photo_not_found")

        body, mime, filename = result

        response = HttpResponse(body, content_type=mime)
        response["Content-Disposition"] = (
            f'inline; filename="{filename}"'
        )
        # Photos are content-addressed by file uuid (re-upload → new
        # uuid → new URL). Same immutable cache policy as release
        # documents so opening + closing the card doesn't re-round-trip.
        response["Cache-Control"] = "private, max-age=86400, immutable"
        return response
