"""Customer-portal dashboard aggregator.

One endpoint, one round-trip, two payloads:

* ``actions`` — every "thing the customer needs to do right now"
  surfaced across proposals, spec sheets, and label designs. Sorted
  by urgency (1 highest) then by ``created_at`` ascending so the
  oldest pending action surfaces first.
* ``products`` — one entry per project the customer can see, with a
  human-readable stage label so the customer can answer "where are
  my products?" without drilling into each surface.

Implementation notes:

* Ownership pivots on ``Proposal.customer_id`` (the same join the
  proposal + label-design portal views use). A customer without a
  proposal has no products visible — by design.
* The label-design lifecycle drives most of the action queue; we
  pull straight from ``LabelDesign`` rows attached to the customer's
  projects.
* We deliberately do NOT include CFFs in the action queue. CFFs are
  intake-side requests where the customer is waiting on US, not the
  other way around — they belong in the "drill-down" surface only.
"""

from __future__ import annotations

from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import (
    customer_proposals_for_formulations,
    formulation_ids_for_customer,
)
from apps.formulations.models import Formulation, ProjectStatus
from apps.label_design.constants import LabelDesignPath, LabelDesignStatus
from apps.label_design.models import LabelDesign
from apps.proposals.models import Proposal
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)


URGENCY_HIGH = 1
URGENCY_MEDIUM = 2
URGENCY_LOW = 3


# ---------------------------------------------------------------------------
# Action queue
# ---------------------------------------------------------------------------


def _build_actions(customer_id) -> list[dict]:
    """Every "needs your attention" item across the customer's projects.

    Each action has a stable ``kind`` so the FE can route the
    icon / treatment; ``url`` is the deep-link the customer clicks.
    """

    actions: list[dict] = []

    # 1) Proposals at ``status=sent`` — customer must sign or reject.
    sent_proposals = (
        Proposal.objects.filter(customer_id=customer_id, status="sent")
        .select_related("formulation_version__formulation")
        .order_by("updated_at")
    )
    for proposal in sent_proposals:
        formulation = proposal.formulation_version.formulation
        actions.append(
            {
                "kind": "sign_proposal",
                "urgency": URGENCY_HIGH,
                "title": "Sign your proposal",
                "subtitle": (
                    f"Proposal {proposal.code} for {formulation.name or 'your product'}"
                ),
                "url": f"/portal/proposals/{proposal.id}/sign",
                "product_code": formulation.code,
                "product_name": formulation.name,
                "reference_code": proposal.code,
                "created_at": proposal.updated_at.isoformat(),
            }
        )

    # 2) FINAL spec sheets at ``status=sent`` — customer must sign to
    #    authorise production. Highest urgency because this is the
    #    moment the project advances to APPROVED.
    #    Customer-project scope includes every formulation reached
    #    via a proposal line, not just the proposal's anchor — see
    #    :mod:`apps.client_portal.queries`.
    customer_formulation_ids = formulation_ids_for_customer(customer_id)
    final_sheets = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation_id__in=customer_formulation_ids,
            document_kind=SpecificationDocumentKind.FINAL,
            status=SpecificationStatus.SENT,
            customer_signed_at__isnull=True,
        )
        .select_related("formulation_version__formulation")
        .order_by("updated_at")
    )
    for sheet in final_sheets:
        formulation = sheet.formulation_version.formulation
        actions.append(
            {
                "kind": "sign_final_spec",
                "urgency": URGENCY_HIGH,
                "title": "Authorise production — final specification",
                "subtitle": (
                    f"{formulation.name or sheet.code} · "
                    "your trial passed — sign the final spec to start production"
                ),
                "url": f"/portal/specs/{sheet.id}",
                "product_code": formulation.code,
                "product_name": formulation.name,
                "reference_code": sheet.code,
                "created_at": sheet.updated_at.isoformat(),
            }
        )

    # 3) Label-design rows the customer is gating on. Multi-spec
    #    projects can produce several rows in one queue; the spec
    #    code suffix on each subtitle lets the customer tell which
    #    artwork an action belongs to without opening the page.
    #    Scope shared with the final-spec block above.
    label_designs = (
        LabelDesign.objects.filter(
            formulation_id__in=customer_formulation_ids,
        )
        .select_related("formulation", "specification_sheet")
        .order_by("updated_at")
    )
    for ld in label_designs:
        spec_code = (
            ld.specification_sheet.code if ld.specification_sheet else ""
        )
        spec_suffix = f" · {spec_code}" if spec_code else ""
        common = {
            "product_code": (
                f"{ld.formulation.code}{spec_suffix}"
                if spec_code
                else ld.formulation.code
            ),
            "product_name": ld.formulation.name,
            "reference_code": spec_code or ld.formulation.code,
            "created_at": ld.updated_at.isoformat(),
        }
        if ld.status == LabelDesignStatus.LABEL_PATH_PENDING:
            actions.append(
                {
                    "kind": "label_choose_path",
                    "urgency": URGENCY_MEDIUM,
                    "title": "Choose how the label will be designed",
                    "subtitle": (
                        f"{ld.formulation.name or ld.formulation.code} · "
                        "pick whether Vita designs it for you or you "
                        "design it yourself"
                    ),
                    "url": f"/portal/label-designs/{ld.id}/choose-path",
                    **common,
                }
            )
        elif ld.status == LabelDesignStatus.DESIGN_PREFERENCES_PENDING:
            actions.append(
                {
                    "kind": "label_preferences",
                    "urgency": URGENCY_MEDIUM,
                    "title": "Tell us what your label should look like",
                    "subtitle": (
                        f"{ld.formulation.name or ld.formulation.code} · "
                        "share brand colours, style, and inspirational examples"
                    ),
                    "url": f"/portal/label-designs/{ld.id}/preferences",
                    **common,
                }
            )
        elif (
            ld.status == LabelDesignStatus.DESIGN_IN_PROGRESS
            and ld.design_path == LabelDesignPath.DESIGN_BY_CUSTOMER
        ):
            actions.append(
                {
                    "kind": "label_upload",
                    "urgency": URGENCY_MEDIUM,
                    "title": "Upload your finished label artwork",
                    "subtitle": (
                        f"{ld.formulation.name or ld.formulation.code} · "
                        "design in your favourite tool, then upload the PDF"
                    ),
                    "url": f"/portal/label-designs/{ld.id}/upload",
                    **common,
                }
            )
        elif ld.status == LabelDesignStatus.CUSTOMER_APPROVAL:
            actions.append(
                {
                    "kind": "label_approve",
                    "urgency": URGENCY_HIGH,
                    "title": "Approve your label artwork",
                    "subtitle": (
                        f"{ld.formulation.name or ld.formulation.code} · "
                        "our team has signed off — review and sign to "
                        "release for production"
                    ),
                    "url": f"/portal/label-designs/{ld.id}/approve",
                    **common,
                }
            )

    # Sort: highest urgency first, then oldest action first.
    actions.sort(key=lambda a: (a["urgency"], a["created_at"]))
    return actions


# ---------------------------------------------------------------------------
# Product list (project-centric)
# ---------------------------------------------------------------------------


_STAGE_LABELS: dict[str, str] = {
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
}


def _resolve_stage(
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


def _build_products(customer_id) -> list[dict]:
    """One entry per project the customer can see.

    Scope = every formulation the customer owns via the shared
    helper. That includes both anchor projects (proposal pinned
    directly to the formulation_version) AND line-derived
    projects (proposals that bundle multiple specs across N
    projects). Without the line walk, multi-project proposals'
    non-anchor projects vanish from the portal list.
    """

    formulation_ids = list(formulation_ids_for_customer(customer_id))
    if not formulation_ids:
        return []

    formulations = Formulation.objects.filter(id__in=formulation_ids)

    # Per-project proposal grouping. A proposal that bundles 2
    # projects shows up under BOTH project cards. The helper
    # returns a distinct list of covering proposals; we walk each
    # and pin it to every project it covers (anchor + lines).
    proposals_by_form: dict = {}
    for p in customer_proposals_for_formulations(
        customer_id=customer_id, formulation_ids=formulation_ids
    ):
        # Anchor project — pin the proposal here.
        if p.formulation_version is not None:
            proposals_by_form.setdefault(
                p.formulation_version.formulation_id, []
            ).append(p)
        # Line-derived projects — pin the same proposal to each
        # other project it touches, dedup-aware so the anchor
        # project doesn't get pinned twice when a line happens to
        # repeat the anchor.
        seen = {
            p.formulation_version.formulation_id
            if p.formulation_version
            else None
        }
        for line in p.lines.all():
            sheet = line.specification_sheet
            if sheet is None or sheet.formulation_version is None:
                continue
            fid = sheet.formulation_version.formulation_id
            if fid in seen:
                continue
            seen.add(fid)
            proposals_by_form.setdefault(fid, []).append(p)

    sheets_by_form: dict = {}
    for s in (
        SpecificationSheet.objects.filter(
            formulation_version__formulation_id__in=formulation_ids,
        )
        .select_related("formulation_version")
        .order_by("-updated_at")
    ):
        sheets_by_form.setdefault(
            s.formulation_version.formulation_id, []
        ).append(s)

    labels_by_form: dict = {}
    for ld in LabelDesign.objects.filter(formulation_id__in=formulation_ids):
        labels_by_form[ld.formulation_id] = ld

    products: list[dict] = []
    for formulation in formulations:
        proposals = proposals_by_form.get(formulation.id, [])
        sheets = sheets_by_form.get(formulation.id, [])
        label_design = labels_by_form.get(formulation.id)
        stage_key, action_url = _resolve_stage(
            formulation=formulation,
            proposals=proposals,
            sheets=sheets,
            label_design=label_design,
        )
        anchor_proposal = proposals[0] if proposals else None
        products.append(
            {
                "id": str(formulation.id),
                "code": formulation.code,
                "name": formulation.name,
                "project_status": formulation.project_status,
                "stage_key": stage_key,
                "stage_label": _STAGE_LABELS.get(
                    stage_key, _STAGE_LABELS["unknown"]
                ),
                "next_action_url": action_url,
                "proposal_id": str(anchor_proposal.id) if anchor_proposal else None,
                "proposal_code": anchor_proposal.code if anchor_proposal else "",
                "label_design_id": str(label_design.id) if label_design else None,
                "last_updated": formulation.updated_at.isoformat(),
            }
        )
    # Most-recently-updated first.
    products.sort(key=lambda p: p["last_updated"], reverse=True)
    return products


# ---------------------------------------------------------------------------
# View
# ---------------------------------------------------------------------------


class PortalDashboardView(PortalAPIView):
    """``GET /api/portal/dashboard/`` — actions + product list."""

    def get(self, request: Request) -> Response:
        customer_id = request.user.customer_id
        return Response(
            {
                "actions": _build_actions(customer_id),
                "products": _build_products(customer_id),
            }
        )
