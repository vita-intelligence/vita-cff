"""Shared "which customer-facing lifecycle stage is this project in?"
resolver + label registry.

Two portal surfaces need the same answer:

* :mod:`apps.client_portal.api.dashboard_views` — the vita-cff-side
  ``/portal/products`` grid (NPD portal) that already used a rich
  lifecycle walk.
* :mod:`apps.client_portal.api.activity_views` — the web-site-side
  ``/en-GB/portal`` activity feed which previously only mapped the
  raw ``Formulation.project_status`` (5 states) and missed every
  proposal / spec / label-design signal, so the customer saw
  "In development" for weeks even after they'd already been asked
  to sign a proposal or approve a label.

Extracted here so the two surfaces speak the same language — same
stage keys, same labels, same tones — and so future stages only need
to be added in one place.
"""

from __future__ import annotations

from apps.formulations.models import Formulation, ProjectStatus
from apps.label_design.constants import LabelDesignStatus
from apps.label_design.models import LabelDesign
from apps.proposals.models import Proposal
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)


#: Customer-facing copy for every ``stage_key`` :func:`resolve_stage`
#: can emit, plus the CFF-only pre-project stages that
#: :func:`apps.client_portal.api.dashboard_views._cff_product_cards_for_customer`
#: (and the activity feed's ``_collect_cffs``) tag onto un-triaged
#: submissions.
STAGE_LABELS: dict[str, str] = {
    "proposal_pending": "Awaiting your proposal signature",
    "draft_spec_pending": "Awaiting draft specification signature",
    "in_development": "In development",
    "pilot": "Trial batch phase",
    "final_spec_pending": "Final specification ready to sign",
    "approved_awaiting_payment": "Approved — awaiting payment",
    "label_path_pending": "Label design — choose path",
    "label_preferences_pending": "Label design — your brief needed",
    "label_in_progress": "Label design — in progress",
    "label_review": "Label design — internal review",
    "label_customer_approval": "Label design — your approval needed",
    "label_approved": "Label approved · ready for production",
    "on_hold": "On hold",
    "unknown": "In progress",
    # Pre-project stages for un-converted CFFs — used by the
    # dashboard's CFF-card path, and by the activity feed's
    # ``_collect_cffs``. These stages don't exist on Formulation
    # rows.
    "cff_under_review": "Under review",
    "cff_rejected": "Not proceeding",
    # RTG orders — the short-lived state between "customer hit
    # submit" and "staff hit Send".
    "cff_awaiting_proposal": "Awaiting proposal",
}


#: Tone + needs_attention triple the activity feed uses to render
#: each stage. Kept in sync with the NPD dashboard's ``STAGE_TONE``
#: (:file:`client/app/[locale]/portal/products/page.tsx`) so the two
#: portals feel like one product.
#:
#: ``attention`` — customer-blocking (sign a proposal, approve a
#:                label, etc). Orange chip on both portals.
#: ``in_progress`` — waiting on us / in flight. Neutral chip.
#: ``success`` — terminal-good.
#: ``danger`` — something went wrong (rejected / on hold).
#: ``muted`` — informational only.
STAGE_TONES: dict[str, tuple[str, bool]] = {
    "proposal_pending": ("attention", True),
    "draft_spec_pending": ("attention", True),
    "in_development": ("in_progress", False),
    "pilot": ("in_progress", False),
    "final_spec_pending": ("attention", True),
    "approved_awaiting_payment": ("attention", True),
    "label_path_pending": ("attention", True),
    "label_preferences_pending": ("attention", True),
    "label_in_progress": ("in_progress", False),
    "label_review": ("in_progress", False),
    "label_customer_approval": ("attention", True),
    "label_approved": ("success", False),
    "on_hold": ("danger", False),
    "unknown": ("in_progress", False),
    "cff_under_review": ("in_progress", False),
    "cff_rejected": ("danger", False),
    "cff_awaiting_proposal": ("in_progress", False),
}


def resolve_stage(
    *,
    formulation: Formulation,
    proposals: list[Proposal],
    sheets: list[SpecificationSheet],
    label_design: LabelDesign | None,
) -> tuple[str, str | None]:
    """Pick the single most-current stage for a project.

    Returns ``(stage_key, action_url_or_none)``. Walks the lifecycle
    in reverse (label design → final spec → trial → proposal) so the
    most advanced state wins — a project with a customer-signed
    proposal AND a sent final spec reads as "final spec pending",
    not "proposal pending".
    """

    if label_design is not None:
        status = label_design.status
        if status == LabelDesignStatus.LABEL_APPROVED:
            return ("label_approved", None)
        if status == LabelDesignStatus.CUSTOMER_APPROVAL:
            return (
                "label_customer_approval",
                f"/portal/label-designs/{label_design.id}/approve",
            )
        if status in (
            LabelDesignStatus.SCIENTIST_REVIEW,
            LabelDesignStatus.DIRECTOR_REVIEW,
        ):
            return ("label_review", f"/portal/label-designs/{label_design.id}")
        if status == LabelDesignStatus.DESIGN_IN_PROGRESS:
            return ("label_in_progress", f"/portal/label-designs/{label_design.id}")
        if status == LabelDesignStatus.DESIGN_PREFERENCES_PENDING:
            return (
                "label_preferences_pending",
                f"/portal/label-designs/{label_design.id}/preferences",
            )
        if status == LabelDesignStatus.LABEL_PATH_PENDING:
            return (
                "label_path_pending",
                f"/portal/label-designs/{label_design.id}/choose-path",
            )
        if status == LabelDesignStatus.PAYMENT_PENDING:
            return ("approved_awaiting_payment", f"/portal/label-designs/{label_design.id}")
        if status == LabelDesignStatus.ON_HOLD:
            return ("on_hold", f"/portal/label-designs/{label_design.id}")

    # No label design row yet. Walk the spec/project lifecycle.
    sent_final = next(
        (
            s
            for s in sheets
            if s.document_kind == SpecificationDocumentKind.FINAL
            and s.status == SpecificationStatus.SENT
            and s.customer_signed_at is None
        ),
        None,
    )
    if sent_final is not None:
        return ("final_spec_pending", f"/portal/specs/{sent_final.id}")

    if formulation.project_status == ProjectStatus.PILOT:
        return ("pilot", None)
    if formulation.project_status == ProjectStatus.IN_DEVELOPMENT:
        return ("in_development", None)

    # Anything before in_development → there's still a proposal or
    # draft spec waiting on the customer.
    sent_draft = next(
        (
            s
            for s in sheets
            if s.document_kind == SpecificationDocumentKind.DRAFT
            and s.status == SpecificationStatus.SENT
            and s.customer_signed_at is None
        ),
        None,
    )
    if sent_draft is not None:
        return ("draft_spec_pending", f"/portal/specs/{sent_draft.id}")

    sent_proposal = next(
        (p for p in proposals if p.status == "sent"), None
    )
    if sent_proposal is not None:
        return ("proposal_pending", f"/portal/proposals/{sent_proposal.id}/sign")

    return ("unknown", None)


__all__ = [
    "STAGE_LABELS",
    "STAGE_TONES",
    "resolve_stage",
]
