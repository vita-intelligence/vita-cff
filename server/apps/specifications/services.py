"""Service layer for the specifications app.

Views never touch the ORM directly; they call these functions. The
workflow:

* ``create_sheet`` — wraps a :class:`FormulationVersion` the caller
  has access to. Validates that the version belongs to the same org.
* ``update_sheet`` — patch-style metadata edits.
* ``transition_status`` — enforces a whitelist of allowed transitions
  so the UI cannot put the sheet into a malformed state.
* ``render_context`` — pure function that turns a sheet + its version
  snapshot into the view-model the frontend renders. The frontend
  does not re-parse ``snapshot_totals``; it walks the flat dict this
  function produces.
"""

from __future__ import annotations

import html
import re
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet
from django.template.loader import render_to_string
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from config.signatures import (
    SignatureImageInvalid,
    validate_signature_image,
)
from apps.catalogues.models import Catalogue, Item, PACKAGING_SLUG
from apps.formulations.constants import (
    DosageForm,
    EXCIPIENT_LABEL_ANTICAKING,
    EXCIPIENT_LABEL_DCP,
    EXCIPIENT_LABEL_GUMMY_BASE,
    EXCIPIENT_LABEL_MCC,
    EXCIPIENT_LABEL_WATER,
    EXCIPIENT_SLUG_ANTICAKING,
    EXCIPIENT_SLUG_CAPSULE_SHELL,
    EXCIPIENT_SLUG_DCP,
    EXCIPIENT_SLUG_GUMMY_BASE,
    EXCIPIENT_SLUG_MCC,
    EXCIPIENT_SLUG_WATER,
    capsule_size_by_key,
    normalize_use_as_value,
)
from apps.formulations.models import (
    FormulationLine,
    FormulationVersion,
    ProjectStatus,
    ProjectType,
)
from apps.formulations.services import (
    _maybe_advance_project_status,
    instantiate_active_label,
    set_approved_version,
)
from apps.organizations.models import Organization
from apps.specifications.constants import (
    DEFAULT_FOOD_CONTACT_STATUS,
    DEFAULT_SAFETY_LIMITS,
    DEFAULT_WEIGHT_UNIFORMITY_PCT,
    PACKAGING_PLACEHOLDER,
    SAFETY_LIMIT_ROWS,
    SECTION_SLUGS,
    VISIBILITY_SLUGS,
)
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
    SpecificationTransition,
)


class SpecificationNotFound(Exception):
    code = "specification_not_found"


class SpecificationCodeConflict(Exception):
    code = "specification_code_conflict"


class FinalSpecAlreadyExists(Exception):
    """A project may have at most one FINAL specification sheet.

    The auto-create path (triggered on trial-batch validation pass)
    short-circuits to a no-op when this would fire, so it surfaces
    only through the explicit ``create_sheet`` / ``update_sheet``
    paths — i.e. when a scientist tries to add or flip-to-final a
    second FINAL on the same project. The remediation in the UI is
    to delete the existing FINAL (only allowed when it hasn't been
    customer-signed) before creating the replacement.
    """

    code = "final_spec_already_exists"


class FinalSpecDeletionLocked(Exception):
    """A customer-signed FINAL spec cannot be deleted.

    Once the customer has signed the final document, it's the
    legally-binding production reference. Wiping it would also
    orphan the downstream :class:`apps.label_design.models.LabelDesign`
    audit chain. Scientists who need to roll back must issue a
    revision through the normal lifecycle — never delete.
    """

    code = "final_spec_deletion_locked"


class FormulationVersionNotInOrg(Exception):
    code = "formulation_version_not_in_org"


class SignatureRequired(Exception):
    """A transition that demands a drawn signature was attempted
    without one (or with a malformed image payload)."""

    code = "signature_required"


class SpecRequiresCustomer(Exception):
    """A spec sheet cannot exist (or advance) until the underlying
    formulation has a linked customer.

    Why gate here rather than let the sheet float customer-less:

    * The sheet renders per-customer prices, cover notes, and
      delivery terms — those fields belong to a real client, not a
      placeholder. Building a spec without a customer means the
      scientist is guessing at commercial terms, and the director
      is signing off on those guesses.
    * The proposal + label-design cascades downstream key off
      ``formulation.customer``; a spec that outruns customer
      assignment leaves those chains in an ambiguous state.

    Both ``create_sheet`` (block creation) and ``transition_status``
    approving toward ``APPROVED`` (block director sign-off) raise
    this. Remediation is a one-click Link Customer on the project
    workspace — the FE surfaces the same code via the warnings card.
    """

    code = "spec_requires_customer"


class MissingTransitionReason(Exception):
    """The transition needed a written reason but the payload omitted
    one.

    Applies to rejects and revert-to-draft moves — the CLAUDE.md
    compliance rule says a status change without provenance is a
    compliance bypass, so the service refuses the write and forces
    the caller to surface a reason input.
    """

    code = "missing_transition_reason"


class MissingDeliveryCapture(Exception):
    """The ``approved → sent`` transition needs delivery evidence
    (method + recipient) so we can answer "how did the customer
    receive this document?" on any downstream audit.

    Rejected as 409 with an actionable code so the FE renders the
    Send modal with method + recipient fields.
    """

    code = "missing_delivery_capture"


class InvalidStatusTransition(Exception):
    code = "invalid_status_transition"


class SpecificationReviewSlotTaken(Exception):
    """Raised when a scientist tries to send a spec sheet for director
    approval while another sheet of the same ``document_kind`` on the
    same formulation is already sitting in ``in_review``.

    The director has at most one of each kind awaiting their
    signature per project — sending a second one of the same kind
    would queue two near-identical approval requests against the
    same recipe and is almost always an accidental double-submit.
    The pending one must transition out (back to draft, or forward
    to approved) before the slot frees up. The draft and final
    slots are independent: one draft in_review + one final in_review
    is allowed.
    """

    code = "specification_review_slot_taken"


class InvalidSpecificationDocumentKind(Exception):
    """Payload carried a ``document_kind`` value outside the allowed set
    (``draft`` / ``final``). Rare in practice — the serializer's
    ChoiceField already rejects unknown strings — but the service
    defends in depth so a scripted import through the Python API
    can't write a junk value."""

    code = "invalid_specification_document_kind"


class InvalidSnapshotOverrides(Exception):
    """Submitted ``snapshot_overrides`` payload is malformed — bad
    section name, unknown key inside a section, or a value of the
    wrong type. We fail loudly rather than silently dropping bad
    keys so the scientist notices the typo before the override
    silently no-ops on render."""

    code = "invalid_snapshot_overrides"


class LiveDraftAlreadyExists(Exception):
    """A regeneratable draft spec already exists on this formulation.

    Only one live draft is allowed per formulation — subsequent draft
    creations must go through the ``regenerate_sheet`` action on the
    existing sheet so scientist-typed commercial fields
    (unit_cost / margin / cover notes / packaging picks) survive the
    version bump instead of being lost to a delete + recreate cycle.

    A draft is *not* counted as live when it is locked by a signed /
    accepted proposal — that sheet has become an immutable audit
    artefact, so a fresh draft can co-exist alongside it.
    """

    code = "live_draft_already_exists"

    def __init__(self, *, existing_sheet_id: Any):
        super().__init__("Live draft already exists")
        self.existing_sheet_id = str(existing_sheet_id)


class SheetLockedBySignedProposal(Exception):
    """The sheet's linked proposal has been accepted / customer-signed.

    Regeneration would rewrite a document the customer has already
    signed, which is fraud from a compliance standpoint and breaks
    the BRCGS / GFSI audit chain. Callers must create a new spec
    sheet against the new version (an amendment) instead.
    """

    code = "sheet_locked_by_signed_proposal"


class SheetRegenerationRequiresForce(Exception):
    """The sheet's linked proposal is ``sent`` — customer has seen the
    document but hasn't signed yet.

    Regenerating in place changes what the customer will read against
    what they were originally quoted, so we require the caller to
    re-send the request with ``force=True`` after confirming the
    intent with the operator. Non-force calls surface this as a 409
    so the FE can render the confirmation modal.
    """

    code = "sheet_regeneration_requires_force"


def resolve_linked_proposal(sheet: SpecificationSheet) -> Any | None:
    """Return the proposal that this spec sheet is attached to, or
    ``None`` when no proposal references it.

    A spec can be attached to a proposal in two distinct ways:

    1. **Legacy OneToOne** (``Proposal.specification_sheet``) — only
       the first spec picked when a proposal is created lands here.
       Preserved for backward compatibility on single-spec proposals.
    2. **Per-line FK** (``ProposalLine.specification_sheet``) — every
       additional spec bundled into a multi-spec proposal goes
       through a new line.

    Resolution order: OneToOne first (matches the "first picked"
    semantics from the create flow); otherwise the
    most-recently-updated proposal that has a line referencing
    this sheet. Every place in the codebase that asks "is this
    spec attached to a proposal?" routes through this helper so the
    Signed tab serializer, the kiosk ``has_proposal`` flag, and the
    customer-facing ``/proposal/`` iframe stay in lock-step.

    Honours the ``proposal_lines`` Prefetch that ``list_sheets``
    installs (already ordered ``-proposal__updated_at``); falls back
    to a fresh ordered query when the prefetch is absent so
    single-fetch contexts (detail page, public kiosk) still pick the
    freshest proposal correctly.
    """

    proposal = getattr(sheet, "proposal", None)
    if proposal is not None:
        return proposal

    # The prefetch from ``list_sheets`` is already ordered. When a
    # caller hasn't installed it (detail / kiosk paths), reach for
    # an explicit ordered query so the tiebreak is deterministic
    # regardless of how the lines are stored on disk.
    prefetched = getattr(sheet, "_prefetched_objects_cache", {}).get(
        "proposal_lines"
    )
    if prefetched is not None:
        lines = list(prefetched)
    else:
        lines = list(
            sheet.proposal_lines.select_related("proposal").order_by(
                "-proposal__updated_at"
            )
        )

    for line in lines:
        candidate = getattr(line, "proposal", None)
        if candidate is not None:
            return candidate
    return None


class PublicLinkNotEnabled(Exception):
    """The sheet the caller looked up by token has had its public link
    revoked or never had one issued. Surfaces as 404 — we deliberately
    do not distinguish between "never shared" and "link revoked" so a
    stale link leaks no information about what the sheet became."""

    code = "public_link_not_enabled"


class PublicLinkNotAllowedForDraft(Exception):
    """Public share links are a customer-facing preview affordance —
    only meaningful once the sheet has been promoted to FINAL. Draft-
    kind sheets are the internal working document; issuing a share URL
    on one would leak a mid-negotiation snapshot to whoever the link
    reaches. FE hides the button; this guard blocks a direct API hit."""

    code = "public_link_not_allowed_for_draft"


class PackagingItemNotAllowed(Exception):
    """The caller tried to pin a packaging slot to an item that either
    does not live in the sheet's org packaging catalogue or has the
    wrong ``packaging_type`` attribute (e.g. a label selected as the
    lid)."""

    code = "packaging_item_not_allowed"


#: Map each FK slot on :class:`SpecificationSheet` to the
#: ``packaging_type`` value the selected ``Item`` must carry in its
#: dynamic attributes. Validated at every ``set_packaging`` call so
#: the spec sheet can never accidentally render a closure where the
#: bottle should be, or vice-versa. The four types come from the
#: packaging catalogue's controlled vocabulary seeded during import.
PACKAGING_SLOT_TYPES: dict[str, str] = {
    "packaging_lid": "closure",
    "packaging_container": "material",
    "packaging_label": "label",
    "packaging_antitemper": "tamper_proof",
}


#: Allowed status moves. The spec sheet cannot jump arbitrarily; the
#: scientist walks it forward through draft → in-review → approved
#: → sent → accepted / rejected. The UI disables buttons that are
#: not in the outbound set for the current status.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    SpecificationStatus.DRAFT: frozenset({SpecificationStatus.IN_REVIEW}),
    SpecificationStatus.IN_REVIEW: frozenset(
        {SpecificationStatus.APPROVED, SpecificationStatus.DRAFT}
    ),
    SpecificationStatus.APPROVED: frozenset(
        {SpecificationStatus.SENT, SpecificationStatus.DRAFT}
    ),
    SpecificationStatus.SENT: frozenset(
        {SpecificationStatus.ACCEPTED, SpecificationStatus.REJECTED}
    ),
    SpecificationStatus.ACCEPTED: frozenset(),
    SpecificationStatus.REJECTED: frozenset({SpecificationStatus.DRAFT}),
}


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


#: Foreign-key paths that every sheet-fetching query needs to pre-fetch
#: so the render path can dereference the four packaging slots without
#: an extra round-trip per slot per sheet.
#:
#: ``proposal`` is the reverse side of ``Proposal.specification_sheet``
#: (OneToOne, related_name="proposal") — fetched here so the
#: ``linked_proposal`` field on the read serializer stays O(1) per
#: row even on the org-wide /signed list.
_SHEET_RELATED: tuple[str, ...] = (
    "formulation_version__formulation",
    # Preload the project's linked customer so
    # ``SpecificationSheetReadSerializer.get_linked_customer`` stays
    # O(1) per row — the /signed page and the workspace both list
    # sheets with the customer chip visible.
    "formulation_version__formulation__customer",
    "packaging_lid",
    "packaging_container",
    "packaging_label",
    "packaging_antitemper",
    "proposal",
)


def _annotate_review_blocker(
    queryset: QuerySet[SpecificationSheet],
) -> QuerySet[SpecificationSheet]:
    """Attach the in-review sibling sheet's id + code as annotations.

    Replaces the per-row query that
    :meth:`SpecificationSheetReadSerializer.get_review_slot_blocker`
    used to fire. Without this annotation, list serialization
    issued one ``SpecificationSheet.objects.filter(...).first()``
    per row — measured at 16 queries for a 14-row page (~52 queries
    on a 50-row page in production), with each round-trip eating
    millisecond-class DB latency.

    The two ``Subquery`` annotations resolve to the same physical
    row (Postgres dedupes the subplan), so this is one extra join
    per page regardless of page size — flat instead of N+1.

    Sheets currently *in* ``in_review`` never block themselves; the
    annotation is still produced for them but the serializer
    short-circuits before reading it.
    """

    from django.db.models import OuterRef, Subquery

    blocker_qs = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation_id=OuterRef(
                "formulation_version__formulation_id"
            ),
            document_kind=OuterRef("document_kind"),
            status=SpecificationStatus.IN_REVIEW,
        )
        .exclude(pk=OuterRef("pk"))
        .order_by("pk")
    )
    return queryset.annotate(
        _review_blocker_id=Subquery(blocker_qs.values("id")[:1]),
        _review_blocker_code=Subquery(blocker_qs.values("code")[:1]),
    )


def list_sheets(
    *,
    organization: Organization,
    formulation_id: Any | None = None,
    status: str | None = None,
    search: str | None = None,
) -> QuerySet[SpecificationSheet]:
    """List spec sheets newest-first, optionally scoped to a single
    formulation. The project workspace's Spec Sheets tab passes
    ``formulation_id`` so it only surfaces sheets hanging off this
    project's versions; the global list page omits it.

    ``status`` (e.g. ``"in_review"``) filters by lifecycle stage so
    the director's approval inbox can pull "things waiting on me"
    in one query.

    ``search`` is a case-insensitive substring match across every
    surface an operator would recognise the row by — the sheet's
    ``code``, the customer identity (kiosk-signed OR scientist-typed
    OR the FK on the formulation), and the formulation's own name.
    Kept as a single OR so a search index (postgres GIN, later) can
    replace it without changing the callers.
    """

    from django.db.models import Prefetch, Q

    from apps.proposals.models import ProposalLine

    queryset = SpecificationSheet.objects.filter(organization=organization)
    if formulation_id is not None:
        queryset = queryset.filter(
            formulation_version__formulation_id=formulation_id
        )
    if status:
        queryset = queryset.filter(status=status)
    if search:
        term = search.strip()
        if term:
            queryset = queryset.filter(
                Q(code__icontains=term)
                | Q(customer_name__icontains=term)
                | Q(customer_company__icontains=term)
                | Q(client_name__icontains=term)
                | Q(client_company__icontains=term)
                | Q(formulation_version__formulation__name__icontains=term)
                | Q(
                    formulation_version__formulation__customer__name__icontains=term
                )
                | Q(
                    formulation_version__formulation__customer__company__icontains=term
                )
            )
    return _annotate_review_blocker(
        queryset.select_related(*_SHEET_RELATED).prefetch_related(
            # ``get_linked_proposal`` checks ``proposal_lines`` when the
            # legacy OneToOne ``proposal`` link is empty — without the
            # prefetch it would fire one query per sheet on the org-wide
            # /signed list. Order by ``-updated_at`` matches the
            # resolver's "freshest proposal wins" pick.
            Prefetch(
                "proposal_lines",
                queryset=ProposalLine.objects.select_related("proposal").order_by(
                    "-proposal__updated_at"
                ),
            ),
        )
    ).order_by("-updated_at")


def get_sheet(
    *, organization: Organization, sheet_id: Any
) -> SpecificationSheet:
    sheet = (
        SpecificationSheet.objects.select_related(*_SHEET_RELATED)
        .filter(organization=organization, id=sheet_id)
        .first()
    )
    if sheet is None:
        raise SpecificationNotFound()
    return sheet


@transaction.atomic
def _existing_final_for_formulation(
    *,
    formulation_id: Any,
    exclude_pk: Any = None,
) -> SpecificationSheet | None:
    """Return the FINAL spec sheet (if any) attached to ``formulation_id``,
    walking through every formulation_version of the project.

    The "one FINAL per project" invariant lives here so the auto-create
    hook, the create-sheet path, and the update-sheet path all share
    the same view of "is there already a final?". ``exclude_pk`` lets
    the update path ignore the row currently being edited.
    """

    qs = SpecificationSheet.objects.filter(
        formulation_version__formulation_id=formulation_id,
        document_kind=SpecificationDocumentKind.FINAL,
    )
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    return qs.order_by("-created_at").first()


# ---------------------------------------------------------------------------
# Regeneration + one-draft invariant
# ---------------------------------------------------------------------------


def _proposal_lock_state(sheet: SpecificationSheet) -> str:
    """Classify the sheet's regeneration eligibility from the linked
    proposal side.

    Returns one of:

    * ``"unlinked"`` — no proposal attached; sheet is freely
      regeneratable / deletable.
    * ``"draft"`` — proposal exists but is still ``draft`` /
      ``in_review`` / ``rejected``. Nothing customer-facing has
      happened; free to regenerate.
    * ``"sent"`` — proposal is ``sent`` (or ``approved``, which is
      internally sign-off but pre-customer). Regenerate is allowed
      but requires an explicit ``force`` from the caller since the
      customer has (or is about to) receive the document.
    * ``"signed"`` — proposal is ``accepted`` OR the sheet /
      proposal carries a ``customer_signed_at`` timestamp. The sheet
      has become an immutable audit artefact; no regeneration path.
    """

    from apps.proposals.models import ProposalStatus

    if sheet.customer_signed_at is not None:
        return "signed"

    proposal = resolve_linked_proposal(sheet)
    if proposal is None:
        return "unlinked"

    if (
        proposal.status == ProposalStatus.ACCEPTED.value
        or proposal.customer_signed_at is not None
    ):
        return "signed"

    if proposal.status in (
        ProposalStatus.APPROVED.value,
        ProposalStatus.SENT.value,
    ):
        return "sent"

    # DRAFT / IN_REVIEW / REJECTED — all pre-customer states.
    return "draft"


def _live_draft_for_formulation(
    *,
    formulation_id: Any,
    exclude_pk: Any = None,
) -> SpecificationSheet | None:
    """Return the regeneratable DRAFT-kind sheet (if any) attached to
    ``formulation_id``.

    Walks every FormulationVersion on the project. A sheet counts as
    "live" for the one-draft-at-a-time invariant iff:

    * ``document_kind == DRAFT`` (FINALs are audit-locked separately),
    * its proposal lock state is not ``"signed"`` (a signed sheet
      has crossed into audit-artefact territory and no longer
      competes with a new working draft).

    ``exclude_pk`` lets the regenerate path skip the sheet currently
    being mutated so it doesn't collide with itself.
    """

    qs = SpecificationSheet.objects.filter(
        formulation_version__formulation_id=formulation_id,
        document_kind=SpecificationDocumentKind.DRAFT,
    )
    if exclude_pk is not None:
        qs = qs.exclude(pk=exclude_pk)
    for candidate in qs.order_by("-created_at"):
        if _proposal_lock_state(candidate) != "signed":
            return candidate
    return None


_MASS_UOM_TO_MG: dict[str, Decimal] = {
    "mg": Decimal("1"),
    "g": Decimal("1000"),
    "kg": Decimal("1000000"),
}
#: UoM symbols we treat as "one piece per pack" — the unit price is
#: the line's per-pack cost verbatim (typical for packaging + shells).
_UNIT_UOMS: frozenset[str] = frozenset(
    {"unit", "each", "pcs", "pack", "piece", "ea"}
)


def compute_unit_cost_for_version(
    version: FormulationVersion,
) -> Decimal | None:
    """Roll the version's snapshot lines up into a per-pack unit cost.

    Mirrors the builder's ``CostCalculator`` math one-for-one so a spec
    sheet auto-populated on create / regenerate lands with the same
    number the scientist saw on the pill: ``suggest_costs`` for every
    line's PSP uuid, then per-line ``cost = mg_per_pack ÷ mass_conv ×
    unit_cost`` for mass UoMs or ``cost = unit_cost`` for unit UoMs.

    Own-project semi-finished outputs (``Formulation.psp_finished_product_uuid``
    + every stage's ``psp_semi_finished_uuid``) are skipped — their
    material cost lives inside their producing stage's BOM, so summing
    them here would double-count. This matches ``own_project_stage``
    on the FE.

    Returns ``None`` when:

    * The formulation has no PSP integration configured (no client).
    * No line resolves to a live PSP uuid.
    * Every priceable line came back ``source == "none"``.

    A partial result (some lines priced, some missing) still returns —
    the caller decides whether to persist it or fall back. Deliberately
    lenient so a mid-spec review can still show a best-guess number
    rather than nothing.
    """

    from apps.psp.services import (
        PspClient,
        PspError,
        get_psp_config,
        is_psp_live,
    )

    formulation = version.formulation
    organization = formulation.organization

    if not is_psp_live(organization):
        return None

    snapshot_lines = list(version.snapshot_lines or [])
    if not snapshot_lines:
        return None

    # Skip stage outputs of this project — they're semi-finished
    # products this project itself manufactures, so their material
    # cost is captured inside the producing stage's BOM.
    own_project_uuids: set[str] = set()
    if formulation.psp_finished_product_uuid:
        own_project_uuids.add(str(formulation.psp_finished_product_uuid))
    for stage in formulation.stages.all():
        if stage.psp_semi_finished_uuid:
            own_project_uuids.add(str(stage.psp_semi_finished_uuid))

    # Resolve every line's PSP uuid. Local-sourced lines carry the
    # local Item pk in ``item_id``; the mirror service copies each
    # Item.psp_source_uuid so we can hop from the local pk to the
    # PSP identity in one query.
    local_item_ids: list[Any] = []
    for line in snapshot_lines:
        if line.get("item_source") != "psp":
            item_id = line.get("item_id")
            if item_id:
                local_item_ids.append(item_id)

    psp_uuid_by_local_id: dict[str, str] = {}
    if local_item_ids:
        for item in Item.objects.filter(id__in=local_item_ids).only(
            "id", "psp_source_uuid"
        ):
            if item.psp_source_uuid:
                psp_uuid_by_local_id[str(item.id)] = str(item.psp_source_uuid)

    # Build per-line records + collect the priceable uuids in one pass.
    #
    # ``priceable_lines`` carries only the lines whose PSP uuid we
    # actually need a price for (i.e. not own-project stage outputs);
    # ``uuids_to_price`` is the deduped set we ship to PSP.
    class _LinePricingRow:
        __slots__ = ("psp_uuid", "label_claim_mg", "own_project")

        def __init__(self, psp_uuid: str, label_claim_mg: Decimal, own: bool):
            self.psp_uuid = psp_uuid
            self.label_claim_mg = label_claim_mg
            self.own_project = own

    pricing_rows: list[_LinePricingRow] = []
    uuids_to_price: set[str] = set()

    for line in snapshot_lines:
        item_id_raw = line.get("item_id")
        if not item_id_raw:
            continue
        item_id = str(item_id_raw)

        if line.get("item_source") == "psp":
            psp_uuid = item_id
        else:
            psp_uuid = psp_uuid_by_local_id.get(item_id, "")

        if not psp_uuid:
            continue

        try:
            label_claim_mg = Decimal(str(line.get("label_claim_mg") or "0"))
        except (InvalidOperation, TypeError, ValueError):
            label_claim_mg = Decimal("0")

        is_own = psp_uuid in own_project_uuids
        pricing_rows.append(
            _LinePricingRow(psp_uuid, label_claim_mg, is_own)
        )
        if not is_own:
            uuids_to_price.add(psp_uuid)

    if not uuids_to_price:
        return None

    try:
        config = get_psp_config(organization=organization)
        client = PspClient(config)
        price_items = client.suggest_costs(list(uuids_to_price))
    except (PspError, Exception):  # noqa: BLE001 — surface as "no cost", not 500
        return None

    price_by_uuid: dict[str, dict] = {
        str(row.get("uuid")): row
        for row in (price_items or [])
        if row and row.get("uuid")
    }

    # ``servings_per_pack`` came from the formulation at save time so we
    # prefer the snapshot's copy; fall back to the live formulation for
    # pre-migration versions that don't carry it.
    metadata = version.snapshot_metadata or {}
    servings = metadata.get("servings_per_pack")
    if servings is None:
        servings = getattr(formulation, "servings_per_pack", None) or 1
    try:
        servings_int = int(servings) if servings else 1
    except (TypeError, ValueError):
        servings_int = 1
    servings_dec = Decimal(servings_int or 1)

    total = Decimal("0")
    priced_any = False

    for row in pricing_rows:
        if row.own_project:
            # Own-project stage output — cost is inside the stage BOM.
            continue

        price = price_by_uuid.get(row.psp_uuid)
        if price is None:
            continue

        unit_cost_raw = price.get("unit_cost")
        if unit_cost_raw is None:
            continue

        try:
            unit_cost = Decimal(str(unit_cost_raw))
        except (InvalidOperation, TypeError, ValueError):
            continue

        uom = str(price.get("uom_symbol") or "").lower().strip()

        if uom in _UNIT_UOMS:
            line_cost = unit_cost
        elif uom in _MASS_UOM_TO_MG:
            mg_per_pack = row.label_claim_mg * servings_dec
            if mg_per_pack <= 0:
                continue
            line_cost = (mg_per_pack / _MASS_UOM_TO_MG[uom]) * unit_cost
        else:
            # Unknown UoM — skip rather than guess. Fine-tune when we
            # extend the vocabulary; today ml / L / IU aren't priced.
            continue

        total += line_cost
        priced_any = True

    routing_cost = _compute_marginal_routing_cost_per_unit(formulation)
    if routing_cost is not None:
        total += routing_cost
        priced_any = True

    if not priced_any:
        return None

    # Round to 4dp — matches the ``DecimalField`` precision on
    # ``SpecificationSheet.unit_cost`` and the display fmt on the
    # approval modal.
    return total.quantize(Decimal("0.0001"))


# Assumed finished-units per production batch used to amortise
# per-batch routing costs (setup labour, ``fixed_cost``,
# ``other_fixed_cost``) into a per-unit number for the spec sheet.
# Kept in sync with the FE constant in ``cost-calculator.tsx``.
# When the proposal quantity is close to this, quantity × unit_cost
# closely reproduces the real batch cost; smaller / larger orders
# accept the amortisation approximation.
_ASSUMED_BATCH_SIZE = Decimal("5000")


def _compute_marginal_routing_cost_per_unit(formulation) -> Decimal | None:
    """Per-unit routing cost for the spec sheet's ``unit_cost``.

    Six components, summed per stage across the formulation:

    * ``cycle × (machine + labour)`` — the per-unit operator time.
    * ``setup × (machine + labour) / ASSUMED_BATCH_SIZE`` — per-batch
      setup labour, amortised into a per-unit number.
    * ``variable_cost`` — per-unit variable override on the stage row.
    * ``fixed_cost / ASSUMED_BATCH_SIZE`` — per-batch fixed override,
      amortised.
    * ``other_variable_cost`` — per-unit routing-header variable.
    * ``other_fixed_cost / ASSUMED_BATCH_SIZE`` — per-batch routing-
      header fixed, amortised.

    Cycle time prefers PSP-derived history when the workstation group
    has session data (avg_seconds_per_unit from vita-performance
    kiosk writebacks, avg_labour_hourly_rate from HR wages); falls back
    to the stage's own ``cycle_time_min`` × ``workstation_group.hourly_rate``.
    Amortisation uses ``_ASSUMED_BATCH_SIZE`` so a proposal for that
    quantity multiplies back to the real batch cost.

    Returns ``None`` when PSP isn't configured or the formulation has
    no stage with a workstation group attached.
    """

    from apps.psp.services import (
        PspClient,
        PspError,
        get_psp_config,
        is_psp_live,
    )

    organization = formulation.organization
    if not is_psp_live(organization):
        return None

    stages = list(formulation.stages.all())
    if not stages:
        return None

    wsg_uuids = [
        str(s.workstation_group_uuid)
        for s in stages
        if s.workstation_group_uuid
    ]
    if not wsg_uuids:
        return None

    try:
        config = get_psp_config(organization=organization)
        client = PspClient(config)
        cost_items = client.workstation_costs(list(set(wsg_uuids)))
    except (PspError, Exception):  # noqa: BLE001 — surface as no-cost
        return None

    cost_by_uuid: dict[str, dict] = {
        str(row.get("uuid")): row
        for row in (cost_items or [])
        if row and row.get("uuid")
    }

    total = Decimal("0")
    any_stage_priced = False

    for stage in stages:
        wsg_uuid = (
            str(stage.workstation_group_uuid)
            if stage.workstation_group_uuid
            else None
        )
        rate_row = cost_by_uuid.get(wsg_uuid) if wsg_uuid else None

        # Machine + labour are separate costs that stack. Either can
        # legitimately be 0 without invalidating the other — a WSG
        # without a configured ``hourly_rate`` on PSP just doesn't
        # contribute machine cost, and a stage without kiosk history
        # simply doesn't contribute labour. We compute with what's
        # actually captured; no synthetic fallback.
        machine_hourly = _dec(rate_row.get("machine_hourly_rate")) if rate_row else Decimal("0")
        labour_hourly = _dec(rate_row.get("avg_labour_hourly_rate")) if rate_row else Decimal("0")
        hourly = machine_hourly + labour_hourly

        # Cycle time — prefer measured throughput, fall back to the
        # stage's declared cycle_time_min.
        cycle_seconds: Decimal | None = None
        if rate_row and rate_row.get("avg_seconds_per_unit") is not None:
            cycle_seconds = _dec(rate_row.get("avg_seconds_per_unit"))
        elif stage.cycle_time_min is not None:
            cycle_seconds = Decimal(str(stage.cycle_time_min)) * Decimal("60")

        cycle_cost = Decimal("0")
        if cycle_seconds and cycle_seconds > 0 and hourly > 0:
            cycle_cost = (cycle_seconds / Decimal("3600")) * hourly

        # Per-unit variable overrides declared on the stage row.
        variable = (
            Decimal(str(stage.variable_cost)) if stage.variable_cost is not None else Decimal("0")
        )
        other_variable = (
            Decimal(str(stage.other_variable_cost))
            if stage.other_variable_cost is not None
            else Decimal("0")
        )

        # Per-batch costs amortised over ``_ASSUMED_BATCH_SIZE``.
        setup_cost_amortised = Decimal("0")
        if stage.setup_time_min is not None and hourly > 0:
            setup_minutes = Decimal(str(stage.setup_time_min))
            if setup_minutes > 0:
                setup_cost_amortised = (
                    (setup_minutes / Decimal("60")) * hourly
                ) / _ASSUMED_BATCH_SIZE

        fixed_cost_amortised = (
            Decimal(str(stage.fixed_cost)) / _ASSUMED_BATCH_SIZE
            if stage.fixed_cost is not None
            else Decimal("0")
        )
        other_fixed_cost_amortised = (
            Decimal(str(stage.other_fixed_cost)) / _ASSUMED_BATCH_SIZE
            if stage.other_fixed_cost is not None
            else Decimal("0")
        )

        stage_cost = (
            cycle_cost
            + setup_cost_amortised
            + variable
            + fixed_cost_amortised
            + other_variable
            + other_fixed_cost_amortised
        )
        if stage_cost > 0:
            total += stage_cost
            any_stage_priced = True

    return total if any_stage_priced else None


def _dec(raw) -> Decimal:
    """Best-effort ``Decimal`` coercion for the mixed str / int / None
    payload shapes coming back from PSP. Returns ``Decimal(0)`` when
    the value doesn't parse — the caller adds it, so 0 is the right
    identity."""
    if raw is None:
        return Decimal("0")
    try:
        return Decimal(str(raw))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


@transaction.atomic
def regenerate_sheet(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    new_formulation_version_id: Any,
    force: bool = False,
) -> SpecificationSheet:
    """Re-pin ``sheet`` to a newer FormulationVersion.

    Everything version-locked (actives, nutrition, allergens,
    ingredients declaration, weight — all derived from
    ``formulation_version.snapshot_*``) is re-derived by the pin
    swap. Everything the scientist typed (code, commercial numbers,
    cover notes, packaging picks, shelf-life / storage / food
    contact / weight-uniformity text, snapshot overrides, limits
    overrides, section visibility / ordering) is preserved verbatim.

    Proposal gating:

    * ``unlinked`` / ``draft`` → allowed unconditionally.
    * ``sent`` → requires ``force=True``. Callers surface the
      resulting :class:`SheetRegenerationRequiresForce` as a
      confirmation prompt.
    * ``signed`` → hard block. Caller must create a fresh spec
      sheet (an amendment) instead.

    The new version must belong to the same organization AND the
    same formulation — cross-formulation re-pinning would be a
    silent identity swap on a document the customer trusts, so we
    refuse.
    """

    _guard_editable(sheet)

    lock_state = _proposal_lock_state(sheet)
    if lock_state == "signed":
        raise SheetLockedBySignedProposal()
    if lock_state == "sent" and not force:
        raise SheetRegenerationRequiresForce()

    new_version = (
        FormulationVersion.objects.select_related("formulation")
        .filter(id=new_formulation_version_id)
        .first()
    )
    if new_version is None:
        raise FormulationVersionNotInOrg()
    if new_version.formulation.organization_id != sheet.organization_id:
        raise FormulationVersionNotInOrg()
    # Same-formulation invariant: regeneration is a *version bump* on
    # the same product. Cross-formulation would rewrite the identity
    # of the document — that path is "create a new sheet", not
    # "regenerate this one".
    if new_version.formulation_id != sheet.formulation_version.formulation_id:
        raise FormulationVersionNotInOrg()

    before = snapshot(sheet)

    sheet.formulation_version = new_version

    # Re-run the packaging FK auto-seed for any slot that is still
    # blank — a scientist who added packaging picks in the new
    # version (e.g. finally chose a bottle after v3) should see them
    # land on the sheet without a manual set_packaging round-trip.
    # Existing picks are preserved (first-write-wins) so a manual
    # override doesn't get overwritten by the routing-side picker.
    slot_for_type = {
        packaging_type: slot for slot, packaging_type in PACKAGING_SLOT_TYPES.items()
    }
    _packaging_keyword_slots: tuple[tuple[str, str], ...] = (
        ("lid", "packaging_lid"),
        ("cap", "packaging_lid"),
        ("closure", "packaging_lid"),
        ("bottle", "packaging_container"),
        ("pouch", "packaging_container"),
        ("tub", "packaging_container"),
        ("jar", "packaging_container"),
        ("container", "packaging_container"),
        ("carton", "packaging_container"),
        ("label", "packaging_label"),
        ("sleeve", "packaging_label"),
        ("wrap", "packaging_label"),
        ("tamper", "packaging_antitemper"),
        ("seal", "packaging_antitemper"),
        ("shrink", "packaging_antitemper"),
        ("band", "packaging_antitemper"),
    )
    packaging_lines = (
        new_version.formulation.lines.select_related("item").filter(
            source_kind=FormulationLine.SOURCE_KIND_MANUAL,
            item__isnull=False,
        )
    )
    resolved_by_slot: dict[str, Item] = {}
    for line in packaging_lines:
        item = line.item
        attrs = item.attributes or {}
        slot: str | None = None
        packaging_type = attrs.get("packaging_type")
        if packaging_type:
            slot = slot_for_type.get(packaging_type)
        if slot is None and attrs.get("psp_item_type") == "packaging":
            lower_name = (item.name or "").lower()
            for keyword, slot_candidate in _packaging_keyword_slots:
                if keyword in lower_name:
                    slot = slot_candidate
                    break
        if slot and slot not in resolved_by_slot:
            resolved_by_slot[slot] = item
    for slot, item in resolved_by_slot.items():
        if getattr(sheet, slot) is None:
            setattr(sheet, slot, item)

    # Re-price against the new version's snapshot lines. Regenerate is
    # explicitly a "re-pin to the current builder state" action, so the
    # cost should reflect the current PSP prices + workstation rates,
    # not whatever number was auto-populated when the sheet was first
    # created. A director who typed a manual override before hitting
    # regenerate can re-enter it on approval; keeping stale numbers is
    # the worse failure mode (customer sees the wrong price).
    recomputed = compute_unit_cost_for_version(new_version)
    if recomputed is not None:
        sheet.unit_cost = recomputed

    sheet.updated_by = actor
    sheet.save()

    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.regenerate",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


def delete_sheet(
    *,
    sheet: SpecificationSheet,
    actor: Any,
) -> dict[str, Any]:
    """Hard-delete a spec sheet if (and only if) it is still a draft.

    The audit trail entry returned from this function carries the
    snapshot of the row *before* the DELETE so a future incident
    response can reconstruct what was wiped. The view layer
    persists this snapshot via :func:`apps.audit.services.record`.

    Raises :class:`SpecificationDeletionLocked` for any sheet whose
    status sits outside :data:`_DELETION_ALLOWED_STATUSES` — the
    set is currently ``{draft}`` because every other status carries
    either a director signature, a customer signature, or a
    terminal-state audit trail that survives the sheet object.
    Reverting to draft (see :data:`ALLOWED_TRANSITIONS`) is the
    explicit path to unblock a delete on those rows; this service
    deliberately does NOT auto-revert because the revert side has
    its own signature-clearing semantics that the caller should
    acknowledge.
    """

    if sheet.status not in _DELETION_ALLOWED_STATUSES:
        raise SpecificationDeletionLocked()

    # FINAL specs survive forever once the customer has signed them
    # — the production document is legally binding and the downstream
    # LabelDesign workflow references the snapshot. Pre-signature
    # FINAL drafts can still be deleted so a scientist can replace
    # them after a trial-batch reshoot.
    if (
        sheet.document_kind == SpecificationDocumentKind.FINAL
        and sheet.customer_signed_at is not None
    ):
        raise FinalSpecDeletionLocked()

    organization = sheet.organization
    target_id = str(sheet.pk)
    before = snapshot(sheet)
    sheet.delete()
    return {
        "organization": organization,
        "actor": actor,
        "target_id": target_id,
        "before": before,
    }


@transaction.atomic
def create_sheet(
    *,
    organization: Organization,
    actor: Any,
    formulation_version_id: Any,
    code: str = "",
    client_name: str = "",
    client_email: str = "",
    client_company: str = "",
    margin_percent: Any = None,
    final_price: Any = None,
    cover_notes: str = "",
    total_weight_label: str = "",
    document_kind: str = SpecificationDocumentKind.DRAFT.value,
) -> SpecificationSheet:
    """Create a specification sheet locked to a formulation version.

    The version must belong to the caller's organization; crossing
    tenants is the loudest possible failure and we refuse rather than
    silently attach someone else's snapshot to an unrelated client.
    """

    version = (
        FormulationVersion.objects.select_related(
            "formulation", "formulation__customer"
        )
        .filter(id=formulation_version_id)
        .first()
    )
    if version is None or version.formulation.organization_id != organization.id:
        raise FormulationVersionNotInOrg()

    # A spec sheet is a per-customer artifact for Custom projects —
    # cover notes, prices, delivery terms all belong to a real client.
    # RTG projects don't have a customer at this point (customers order
    # later through the portal), so the check is skipped for them; the
    # spec covers the SKU itself, not a client contract.
    if (
        version.formulation.customer_id is None
        and version.formulation.project_type != "ready_to_go"
    ):
        raise SpecRequiresCustomer()

    if code:
        duplicate = SpecificationSheet.objects.filter(
            organization=organization, code=code
        ).exists()
        if duplicate:
            raise SpecificationCodeConflict()

    if document_kind not in SpecificationDocumentKind.values:
        raise InvalidSpecificationDocumentKind()

    # One FINAL per project. The auto-create-on-validation path
    # short-circuits via ``_existing_final_for_formulation`` before
    # calling us; this guard catches the manual-create surface (a
    # scientist building a second FINAL by hand) and the test paths.
    if document_kind == SpecificationDocumentKind.FINAL:
        if (
            _existing_final_for_formulation(
                formulation_id=version.formulation_id
            )
            is not None
        ):
            raise FinalSpecAlreadyExists()

    # One live DRAFT per project. When a regeneratable draft already
    # exists, the scientist must go through the "Regenerate" action
    # on that sheet instead — that path re-pins to the new version
    # while preserving cost / margin / cover-notes / packaging picks
    # they've already typed. Drafts locked by a signed proposal don't
    # count against the quota (they've crossed into audit-artefact
    # territory and can no longer be regenerated) so a fresh draft
    # can still be created alongside a customer-signed one.
    if document_kind == SpecificationDocumentKind.DRAFT:
        existing_draft = _live_draft_for_formulation(
            formulation_id=version.formulation_id
        )
        if existing_draft is not None:
            raise LiveDraftAlreadyExists(existing_sheet_id=existing_draft.pk)

    # Seed shelf-life / storage / weight-uniformity from the per-
    # dosage-form defaults so the spec sheet lands populated rather
    # than three blank cells. Read the dosage form off the locked
    # snapshot — the formulation header may have moved on, but the
    # version is the canonical state of the product when the sheet
    # was issued.
    from apps.specifications.constants import SPECIFICATION_TEXT_DEFAULTS

    snapshot_metadata = version.snapshot_metadata or {}
    dosage_form = snapshot_metadata.get("dosage_form", "") or ""
    spec_defaults = SPECIFICATION_TEXT_DEFAULTS.get(dosage_form, {})

    # Auto-seed the four packaging FK slots from the builder's picks.
    # Packaging isn't an M2M on Formulation — the scientist drops
    # closure / material / label / tamper_proof items into a
    # packaging stage via the Routing picker
    # (``FormulationLine(source_kind='manual')``). Read those live
    # lines here and slot each item into the matching sheet FK by:
    #
    # 1. Direct match on ``item.attributes.packaging_type`` (local
    #    packaging catalogue: authoritative vocabulary).
    # 2. Fallback for PSP-mirrored items — those carry only
    #    ``psp_item_type == 'packaging'`` (packaging bucket flag),
    #    not the closure/material/label/tamper_proof sub-type, so we
    #    infer the slot from item-name keywords. This mirrors what
    #    a scientist would guess reading the picked SKU list.
    #
    # First pick per slot wins. Falls through silently on any
    # missing pick so scientists who haven't finalised packaging
    # can still generate a draft sheet.
    slot_for_type = {
        packaging_type: slot for slot, packaging_type in PACKAGING_SLOT_TYPES.items()
    }
    # Keyword → slot map for the PSP-mirrored fallback. Order
    # matters: keywords are matched in list order and first hit
    # wins, so an "HDPE Lid Tamper-Evident" item lands on
    # ``packaging_lid`` (Lid keyword comes first) rather than
    # ``packaging_antitemper`` (Tamper keyword). Overlap is rare
    # but the closure interpretation is the useful one — a lid IS
    # a closure that also happens to have tamper-evident features.
    _packaging_keyword_slots: tuple[tuple[str, str], ...] = (
        ("lid", "packaging_lid"),
        ("cap", "packaging_lid"),
        ("closure", "packaging_lid"),
        ("bottle", "packaging_container"),
        ("pouch", "packaging_container"),
        ("tub", "packaging_container"),
        ("jar", "packaging_container"),
        ("container", "packaging_container"),
        ("carton", "packaging_container"),
        ("label", "packaging_label"),
        ("sleeve", "packaging_label"),
        ("wrap", "packaging_label"),
        ("tamper", "packaging_antitemper"),
        ("seal", "packaging_antitemper"),
        ("shrink", "packaging_antitemper"),
        ("band", "packaging_antitemper"),
    )
    packaging_lines = (
        version.formulation.lines.select_related("item")
        .filter(
            source_kind=FormulationLine.SOURCE_KIND_MANUAL,
            item__isnull=False,
        )
    )
    packaging_by_slot: dict[str, Item] = {}
    for line in packaging_lines:
        item = line.item
        attrs = item.attributes or {}
        slot: str | None = None
        # Prefer the explicit sub-type when present.
        packaging_type = attrs.get("packaging_type")
        if packaging_type:
            slot = slot_for_type.get(packaging_type)
        # PSP-mirrored fallback — only apply the keyword heuristic
        # when the item is tagged as packaging on the PSP side so a
        # semi-finished stage output with a coincidental keyword
        # ("Lid Formula") can't hijack a slot.
        if slot is None and attrs.get("psp_item_type") == "packaging":
            lower_name = (item.name or "").lower()
            for keyword, slot_candidate in _packaging_keyword_slots:
                if keyword in lower_name:
                    slot = slot_candidate
                    break
        if slot and slot not in packaging_by_slot:
            packaging_by_slot[slot] = item

    # Auto-price the sheet from the version's snapshot lines + live PSP
    # data so the director doesn't have to eyeball the builder's cost
    # pill and re-type on approval. Director can still override on the
    # approval modal — this only fills the starting value.
    computed_unit_cost = compute_unit_cost_for_version(version)

    sheet = SpecificationSheet.objects.create(
        organization=organization,
        formulation_version=version,
        code=code,
        client_name=client_name,
        client_email=client_email,
        client_company=client_company,
        unit_cost=computed_unit_cost,
        margin_percent=margin_percent,
        final_price=final_price,
        cover_notes=cover_notes,
        total_weight_label=total_weight_label,
        shelf_life=spec_defaults.get("shelf_life", ""),
        storage_conditions=spec_defaults.get("storage_conditions", ""),
        weight_uniformity=spec_defaults.get("weight_uniformity", ""),
        status=SpecificationStatus.DRAFT,
        document_kind=document_kind,
        packaging_lid=packaging_by_slot.get("packaging_lid"),
        packaging_container=packaging_by_slot.get("packaging_container"),
        packaging_label=packaging_by_slot.get("packaging_label"),
        packaging_antitemper=packaging_by_slot.get("packaging_antitemper"),
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="spec_sheet.create",
        target=sheet,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def auto_create_final_spec_for_version(
    *,
    formulation_version: FormulationVersion,
    actor: Any,
) -> SpecificationSheet | None:
    """Create a ``document_kind=FINAL`` spec sheet on
    ``formulation_version`` if the project does not already have one.

    Idempotent — second call (or a re-fire of the validation pass
    that triggered the first) is a no-op and returns ``None``.

    Most fields are seeded from the most recent draft spec on the
    same project so the scientist isn't re-typing storage / shelf
    life / packaging / client info. The new sheet lands at
    ``status=DRAFT`` so the existing scientist → director → sent →
    customer sign chain still applies — the auto-step only removes
    the "click new sheet" friction.

    Returns the new sheet on creation, or ``None`` when no work was
    needed.
    """

    formulation = formulation_version.formulation
    organization = formulation.organization

    def _next_unique_final_code(*, base: str) -> str:
        """Pick a per-org-unique ``-FINAL`` suffix on ``base``.

        ``base`` is typically the draft spec's code or the formulation
        code. If that bare ``<base>-FINAL`` already exists we walk
        ``-FINAL-2``, ``-FINAL-3``, … until we find a free slot.
        Returns ``""`` if ``base`` was empty — the caller falls back
        to leaving the code blank (and the spec lists as "Untitled"
        until the scientist fills it in).
        """

        base = (base or "").strip()
        if not base:
            return ""
        candidate = f"{base}-FINAL"
        suffix = 2
        while SpecificationSheet.objects.filter(
            organization=organization, code=candidate
        ).exists():
            candidate = f"{base}-FINAL-{suffix}"
            suffix += 1
        return candidate

    if _existing_final_for_formulation(formulation_id=formulation.id) is not None:
        # A final already exists somewhere on this project — could be
        # the customer-signed one (project should be APPROVED already)
        # or an unsigned draft we made on a previous trial-pass cycle.
        # Either way, the invariant is satisfied; no-op.
        return None

    # Pre-populate from the most recent draft on the same project.
    # We deliberately walk all formulation_versions (not just the one
    # the validation pinned) so a scientist who already built a draft
    # on v2 sees its packaging / storage carry into the FINAL.
    source_draft = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation_id=formulation.id,
            document_kind=SpecificationDocumentKind.DRAFT,
        )
        .order_by("-updated_at")
        .first()
    )

    from apps.specifications.constants import SPECIFICATION_TEXT_DEFAULTS

    snapshot_metadata = formulation_version.snapshot_metadata or {}
    dosage_form = snapshot_metadata.get("dosage_form", "") or ""
    spec_defaults = SPECIFICATION_TEXT_DEFAULTS.get(dosage_form, {})

    def _copy_or_default(attr: str, default_key: str | None = None) -> str:
        if source_draft is not None:
            value = getattr(source_draft, attr, "") or ""
            if value:
                return value
        if default_key is not None:
            return spec_defaults.get(default_key, "") or ""
        return ""

    # Pick a code that signals "this is the final" at a glance — the
    # source draft's code with a ``-FINAL`` suffix is the most legible
    # option for the spec list UI ("MA521352" → "MA521352-FINAL"). If
    # the draft has no code, derive from the formulation code; if THAT
    # is also blank, leave it empty for the scientist to fill in.
    code_base = (
        (getattr(source_draft, "code", "") or "").strip()
        or (formulation.code or "").strip()
    )
    # Prefer whatever cost the source draft already had (a director
    # may have overridden the auto-populate at approval); fall back to
    # a fresh compute against the pinned version so the FINAL doesn't
    # ship empty when no draft existed to seed from.
    source_unit_cost = (
        getattr(source_draft, "unit_cost", None) if source_draft else None
    )
    if source_unit_cost is None:
        source_unit_cost = compute_unit_cost_for_version(formulation_version)

    sheet = SpecificationSheet.objects.create(
        organization=organization,
        formulation_version=formulation_version,
        code=_next_unique_final_code(base=code_base),
        client_name=_copy_or_default("client_name"),
        client_email=_copy_or_default("client_email"),
        client_company=_copy_or_default("client_company"),
        unit_cost=source_unit_cost,
        margin_percent=getattr(source_draft, "margin_percent", None)
        if source_draft
        else None,
        final_price=getattr(source_draft, "final_price", None)
        if source_draft
        else None,
        quantity=getattr(source_draft, "quantity", 1) if source_draft else 1,
        currency=getattr(source_draft, "currency", "GBP")
        if source_draft
        else "GBP",
        cover_notes=_copy_or_default("cover_notes"),
        total_weight_label=_copy_or_default("total_weight_label"),
        unit_quantity=_copy_or_default("unit_quantity"),
        food_contact_status=_copy_or_default("food_contact_status"),
        shelf_life=_copy_or_default("shelf_life", "shelf_life"),
        storage_conditions=_copy_or_default("storage_conditions", "storage_conditions"),
        weight_uniformity=_copy_or_default("weight_uniformity", "weight_uniformity"),
        status=SpecificationStatus.DRAFT,
        document_kind=SpecificationDocumentKind.FINAL,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="spec_sheet.auto_create_final",
        target=sheet,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def update_sheet(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    **changes: Any,
) -> SpecificationSheet:
    _guard_editable(sheet)
    mutable = {
        "code",
        "client_name",
        "client_email",
        "client_company",
        # Commercial pricing trio + unit-of-quote. ``unit_cost`` and
        # ``margin_percent`` derive ``final_price`` via
        # :func:`set_spec_pricing`; the existing ``update_sheet`` path
        # is preserved for direct edits, but a pricing-lock guard
        # below refuses these fields once the spec hits
        # ``approved`` (the director signed the snapshot — including
        # the price).
        "unit_cost",
        "margin_percent",
        "final_price",
        "quantity",
        "currency",
        "cover_notes",
        "total_weight_label",
        # Extra packaging-spec strings from the reference workbook —
        # renderable on the customer PDF, editable through the same
        # PATCH the existing UI uses, so no new endpoint required.
        "unit_quantity",
        "food_contact_status",
        "shelf_life",
        "storage_conditions",
        "weight_uniformity",
        # ``limits_override`` is a JSON object; the serializer clamps
        # the shape before we see it here, so assignment is safe.
        "limits_override",
        # Draft-vs-final decides the watermark. Lives here (not under
        # the status machine) so scientists can flip it without
        # triggering a lifecycle transition.
        "document_kind",
    }
    # Pricing fields freeze with the director signature. Refuse the
    # write *before* the snapshot diff so a stray patch from a
    # legacy client doesn't silently overwrite the signed price.
    pricing_keys = {
        "unit_cost",
        "margin_percent",
        "final_price",
        "quantity",
        "currency",
    }
    pricing_in_payload = any(
        key in changes and changes[key] is not None for key in pricing_keys
    )
    if pricing_in_payload and sheet.status in _PRICING_LOCKED_STATUSES:
        raise SpecificationPricingLocked()
    new_kind = changes.get("document_kind")
    if new_kind is not None and new_kind not in SpecificationDocumentKind.values:
        raise InvalidSpecificationDocumentKind()
    # Flipping a draft to FINAL has the same uniqueness constraint as
    # creating a fresh FINAL. Exclude the row we're editing so a
    # no-op kind=final → kind=final update doesn't trip on itself.
    if (
        new_kind == SpecificationDocumentKind.FINAL
        and sheet.document_kind != SpecificationDocumentKind.FINAL
    ):
        if (
            _existing_final_for_formulation(
                formulation_id=sheet.formulation_version.formulation_id,
                exclude_pk=sheet.pk,
            )
            is not None
        ):
            raise FinalSpecAlreadyExists()
    new_code = changes.get("code")
    if new_code and new_code != sheet.code:
        duplicate = (
            SpecificationSheet.objects.filter(
                organization=sheet.organization, code=new_code
            )
            .exclude(pk=sheet.pk)
            .exists()
        )
        if duplicate:
            raise SpecificationCodeConflict()

    # Phase G5a — last-mile overrides. Validate up front so any
    # malformed payload short-circuits before we touch the sheet.
    # ``None`` = leave the existing dict alone; ``{}`` = clear all
    # overrides; a populated dict replaces the override map.
    pending_overrides: dict[str, Any] | None = None
    if "snapshot_overrides" in changes:
        raw_overrides = changes.pop("snapshot_overrides")
        if raw_overrides is not None:
            pending_overrides = _validate_snapshot_overrides(raw_overrides)

    before = snapshot(sheet)
    for key, value in changes.items():
        if key in mutable and value is not None:
            setattr(sheet, key, value)
    if pending_overrides is not None:
        sheet.snapshot_overrides = pending_overrides

    sheet.updated_by = actor
    sheet.save()
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.update",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


class SpecificationPricingLocked(Exception):
    """Raised when ``set_spec_pricing`` is called on a sheet that has
    already been director-approved (or any later status). Pricing is
    part of the snapshot the director signs, so editing it after the
    signature would invalidate the audit trail."""

    code = "specification_pricing_locked"


class SpecificationDeletionLocked(Exception):
    """Raised when a delete is attempted on a sheet that has moved
    past ``draft``. Once a reviewer (director or customer) has
    interacted with the sheet — director signature on approval,
    customer kiosk acceptance, supplier-facing send — the row is
    part of the audit trail and a hard delete would wipe both the
    signatures and the proposal-side history that points at it.

    The escape hatch is the existing revert-to-draft transition:
    ``in_review`` / ``approved`` / ``rejected`` all carry an
    edge back to ``draft`` (see :data:`ALLOWED_TRANSITIONS`), which
    clears the relevant signatures explicitly and audit-logs the
    rollback. The scientist then deletes the now-draft sheet.
    ``sent`` and ``accepted`` are deliberately *not* revertible —
    the customer has seen / signed the sheet and the deal's audit
    trail outlives the sheet object.

    The API layer maps this to ``409 specification_deletion_locked``
    so the frontend can render a "revert to draft first" hint.
    """

    code = "specification_deletion_locked"


class SpecificationNotMutable(Exception):
    """Raised when any edit service is called on a sheet that has
    already been director-approved. ``approved`` / ``sent`` /
    ``accepted`` / ``rejected`` all carry a director signature (and,
    in the customer-actioned states, a customer signature too); any
    field write at that point would orphan those signatures.

    ``in_review`` is intentionally *not* locked — the director needs
    to be able to tweak the sheet before stamping their signature on
    it. The prepared-by signature stays as the scientist's "I drafted
    this" marker; the director's signature is the legally binding
    one, and it lands on whatever state the sheet is in at approval
    time. Reverting to draft is the way to unlock an approved sheet.
    """

    code = "specification_not_mutable"


#: Statuses that freeze the spec's pricing. Mirrors the snapshot
#: lock — once a director has signed off, the per-unit cost,
#: margin, and price are part of what they attested to.
_PRICING_LOCKED_STATUSES: frozenset = frozenset(
    {
        SpecificationStatus.APPROVED,
        SpecificationStatus.SENT,
        SpecificationStatus.ACCEPTED,
    }
)


#: Only draft sheets can be hard-deleted. Everything else has a
#: signature, a customer interaction, or a terminal-state audit
#: trail attached and must be reverted to draft first (via the
#: existing :data:`ALLOWED_TRANSITIONS` revert edges) before
#: deletion is permitted. The single-status whitelist makes the
#: rule trivially auditable — the moment a new status appears it
#: is locked-by-default rather than accidentally deletable.
_DELETION_ALLOWED_STATUSES: frozenset = frozenset(
    {SpecificationStatus.DRAFT}
)


#: Statuses that freeze the entire spec snapshot. The director's
#: signature is the legally binding one — once it lands, every field
#: on the sheet is part of what they attested to. ``in_review`` is
#: deliberately excluded so the director can fine-tune the sheet
#: before signing; the prepared-by stamp is internal-only and
#: tolerates pre-approval edits.
_EDIT_LOCKED_STATUSES: frozenset = frozenset(
    {
        SpecificationStatus.APPROVED,
        SpecificationStatus.SENT,
        SpecificationStatus.ACCEPTED,
        SpecificationStatus.REJECTED,
    }
)


def _guard_editable(sheet: SpecificationSheet) -> None:
    """Refuse the call when the sheet's status freezes its snapshot.
    Use at the top of every edit-style service so each entry point
    enforces the lock consistently — status transitions stay
    available since they don't mutate snapshot fields directly."""

    if sheet.status in _EDIT_LOCKED_STATUSES:
        raise SpecificationNotMutable()


@transaction.atomic
def set_spec_pricing(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    unit_cost: Decimal | str | None = None,
    margin_percent: Decimal | str | None = None,
    final_price: Decimal | str | None = None,
    quantity: int | None = None,
    currency: str | None = None,
    allow_locked: bool = False,
) -> SpecificationSheet:
    """Persist commercial pricing on a spec sheet.

    Mirrors the proposal modal's math exactly: when ``unit_cost`` and
    ``margin_percent`` are provided and ``final_price`` is omitted,
    the per-unit price is derived as ``cost / (1 - margin/100)`` via
    :func:`apps.proposals.services.suggest_unit_price`. An explicit
    ``final_price`` overrides the derivation, useful when the team
    negotiates a custom rate.

    All inputs are optional — the caller patches whichever fields it
    has. ``None`` means "leave the existing value alone" rather than
    "set to NULL", matching the partial-PATCH semantics of the
    serializer that wraps this call.

    Locks once the sheet hits an approved-or-later status. The
    ``allow_locked`` escape hatch is the only way past the gate;
    callers use it from the director-approval flow so the price can
    be edited *at the moment of signing* (one atomic transaction
    sets both the price and the signature, after which the lock
    engages).
    """

    from apps.proposals.services import suggest_unit_price

    if not allow_locked and sheet.status in _PRICING_LOCKED_STATUSES:
        raise SpecificationPricingLocked()

    before = snapshot(sheet)
    dirty: list[str] = []

    def _coerce_decimal(value: Any) -> Decimal | None:
        """Accept Decimal / str / numeric input; raise on garbage so
        a malformed payload doesn't write zeros to the DB."""

        if value is None:
            return None
        if isinstance(value, Decimal):
            return value
        try:
            return Decimal(str(value).strip())
        except (InvalidOperation, ValueError) as exc:
            raise ValueError(f"invalid pricing value: {value!r}") from exc

    if unit_cost is not None:
        sheet.unit_cost = _coerce_decimal(unit_cost)
        dirty.append("unit_cost")
    if margin_percent is not None:
        sheet.margin_percent = _coerce_decimal(margin_percent)
        dirty.append("margin_percent")
    if final_price is not None:
        sheet.final_price = _coerce_decimal(final_price)
        dirty.append("final_price")
    elif (
        unit_cost is not None
        and margin_percent is not None
        and sheet.unit_cost is not None
        and sheet.margin_percent is not None
    ):
        # Cost + margin without an explicit price → derive. Skipped
        # when one of the two is missing so a single-field patch
        # doesn't overwrite a previously hand-typed price with a
        # half-derived number.
        sheet.final_price = suggest_unit_price(
            sheet.unit_cost, sheet.margin_percent
        )
        if "final_price" not in dirty:
            dirty.append("final_price")
    if quantity is not None:
        sheet.quantity = max(1, int(quantity))
        dirty.append("quantity")
    if currency is not None:
        cleaned = (currency or "").strip().upper()
        if cleaned:
            sheet.currency = cleaned[:3]
            dirty.append("currency")

    if not dirty:
        return sheet

    sheet.updated_by = actor
    dirty.append("updated_by")
    dirty.append("updated_at")
    sheet.save(update_fields=dirty)
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_pricing",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def set_packaging(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    selections: dict[str, Any],
) -> SpecificationSheet:
    """Assign or clear one or more packaging slots on ``sheet``.

    ``selections`` is a dict keyed by the FK slot name
    (``packaging_lid``, ``packaging_container``, ``packaging_label``,
    ``packaging_antitemper``). Each value is either a packaging
    ``Item`` UUID or ``None`` to clear that slot. Slots not present in
    the dict are untouched — the caller can update a single slot
    without re-sending the others.

    Every non-null selection is validated twice: the item must live in
    the sheet's org ``packaging`` catalogue (prevents cross-tenant
    attach), and its ``packaging_type`` attribute must match the slot
    (prevents selecting a closure for the bottle row). Both failures
    surface as :class:`PackagingItemNotAllowed` with a single error
    code so the API layer can translate them uniformly.
    """

    _guard_editable(sheet)
    before = snapshot(sheet)
    catalogue: Catalogue | None = None

    for slot, raw_id in selections.items():
        if slot not in PACKAGING_SLOT_TYPES:
            raise PackagingItemNotAllowed()

        if raw_id is None or raw_id == "":
            setattr(sheet, slot, None)
            continue

        if catalogue is None:
            catalogue = Catalogue.objects.filter(
                organization=sheet.organization, slug=PACKAGING_SLUG
            ).first()
            if catalogue is None:
                raise PackagingItemNotAllowed()

        item = Item.objects.filter(catalogue=catalogue, id=raw_id).first()
        if item is None:
            raise PackagingItemNotAllowed()

        expected_type = PACKAGING_SLOT_TYPES[slot]
        actual_type = (item.attributes or {}).get("packaging_type")
        if actual_type != expected_type:
            raise PackagingItemNotAllowed()

        setattr(sheet, slot, item)

    sheet.updated_by = actor
    sheet.save()
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_packaging",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def set_section_order(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    order: list[str],
) -> SpecificationSheet:
    """Persist the preferred render order for the customer-facing sheet.

    ``order`` is the full desired top-down sequence of section slugs.
    Unknown slugs are dropped rather than raising so the write
    tolerates a stale client that was loaded before a schema migration
    added or removed a section. Duplicates are deduped. The result is
    persisted verbatim — ``resolve_section_order`` does the canonical
    backfill at render time so newly-added sections still appear.
    """

    _guard_editable(sheet)
    before = snapshot(sheet)
    seen: set[str] = set()
    cleaned: list[str] = []
    for slug in order:
        if not isinstance(slug, str) or slug in seen:
            continue
        if slug not in SECTION_SLUGS:
            continue
        cleaned.append(slug)
        seen.add(slug)
    sheet.section_order = cleaned
    sheet.updated_by = actor
    sheet.save(update_fields=["section_order", "updated_by", "updated_at"])
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_section_order",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


@transaction.atomic
def set_section_visibility(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    visibility: dict[str, bool],
) -> SpecificationSheet:
    """Persist ``section_visibility`` overrides on the sheet.

    ``visibility`` is a partial ``{section_slug: bool}`` map — any
    key the caller omits is left untouched on the stored dict, so a
    single toggle does not unintentionally re-expose other sections
    the customer had flagged off. Unknown slugs are silently
    dropped: the canonical list lives in
    :data:`SECTION_SLUGS` and drives both the frontend UI and the
    renderer, so tolerating stale payloads is safer than 400-ing a
    request that is otherwise valid.
    """

    _guard_editable(sheet)
    before = snapshot(sheet)
    stored = dict(sheet.section_visibility or {})
    for slug, value in visibility.items():
        # Accept both section toggles and column-level toggles
        # (e.g. ``excipients_numbers``). Both share the same flat
        # ``{slug: bool}`` storage shape; the renderer reads each
        # flag under a separate key.
        if slug not in VISIBILITY_SLUGS:
            continue
        stored[slug] = bool(value)
    sheet.section_visibility = stored
    sheet.updated_by = actor
    sheet.save(
        update_fields=["section_visibility", "updated_by", "updated_at"]
    )
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.set_visibility",
        target=sheet,
        before=before,
        after=snapshot(sheet),
    )
    return sheet


#: Transitions that require a captured signature before the sheet
#: can move forward. Maps ``(from_status, to_status)`` to the slot
#: the drawn image lands in. Customer sign-off (``sent → accepted``)
#: happens on the kiosk path and is handled by a dedicated endpoint
#: that binds the signature to the visitor's kiosk session — it is
#: intentionally absent from this map so the internal transition
#: view cannot be used to fake a customer signature.
_INTERNAL_SIGNATURE_SLOT: dict[tuple[str, str], str] = {
    (SpecificationStatus.DRAFT, SpecificationStatus.IN_REVIEW): "prepared_by",
    (SpecificationStatus.IN_REVIEW, SpecificationStatus.APPROVED): "director",
}


#: Transitions that require an operator-typed reason before landing.
#: All "backwards" moves (reject, revert) — a director can't quietly
#: bounce a sheet without a paper trail explaining why. Keys are
#: ``(from_status, to_status)`` tuples so a specific revert like
#: ``approved → draft`` is distinguishable from ``in_review → draft``
#: even though the target status is the same.
_REASON_REQUIRED_TRANSITIONS: frozenset[tuple[str, str]] = frozenset(
    {
        (SpecificationStatus.IN_REVIEW, SpecificationStatus.DRAFT),
        (SpecificationStatus.APPROVED, SpecificationStatus.DRAFT),
        (SpecificationStatus.SENT, SpecificationStatus.REJECTED),
        (SpecificationStatus.REJECTED, SpecificationStatus.DRAFT),
    }
)


@transaction.atomic
def transition_status(
    *,
    sheet: SpecificationSheet,
    actor: Any,
    next_status: str,
    notes: str = "",
    signature_image: str | None = None,
    pricing: dict[str, Any] | None = None,
    delivery_method: str = "",
    delivery_recipient: str = "",
) -> SpecificationSheet:
    """Move the sheet one state forward and stamp an audit row.

    Certain transitions require a drawn signature captured on the
    signature pad:

    * ``draft → in_review`` — **prepared-by** (scientist who
      drafted the sheet).
    * ``in_review → approved`` — **director** / commercial owner.

    Customer sign-off (``sent → accepted``) lives on a separate
    kiosk endpoint and is rejected here — an internal actor cannot
    sign on the customer's behalf.

    The :class:`SpecificationTransition` insert and the sheet's
    ``status`` write share a single transaction — if either fails,
    neither lands, so the audit log cannot drift behind the sheet's
    headline status. Same-state transitions are a no-op (no row
    written) to keep the history clean of accidental re-clicks.
    """

    if next_status == sheet.status:
        return sheet
    allowed = ALLOWED_TRANSITIONS.get(sheet.status, frozenset())
    if next_status not in allowed:
        raise InvalidStatusTransition()
    if next_status == SpecificationStatus.ACCEPTED:
        # Block the internal path to ``accepted`` entirely — that
        # state is reserved for the kiosk sign-off flow.
        raise InvalidStatusTransition()

    # Compliance-first: reject / revert transitions must carry an
    # operator-typed reason. The CLAUDE.md rule says "workers trigger
    # actions, not states", and every action must have provenance —
    # for backwards moves, that provenance is a written justification
    # ("customer requested reformulation with less caffeine",
    # "compliance blocker on caffeine limit", etc.).
    reason = (notes or "").strip()
    if (
        sheet.status,
        next_status,
    ) in _REASON_REQUIRED_TRANSITIONS and not reason:
        raise MissingTransitionReason()

    # Delivery evidence must be captured at the send transition so
    # a signed sheet later carries provenance from build → send →
    # customer signature. We validate both fields here rather than
    # in the serializer so the same guard applies to any BE caller
    # (view, bundled proposal-send, script) rather than just the
    # HTTP surface.
    delivery_method_cleaned = (delivery_method or "").strip()
    delivery_recipient_cleaned = (delivery_recipient or "").strip()
    if next_status == SpecificationStatus.SENT:
        if delivery_method_cleaned not in {
            SpecificationSheet.SENT_DELIVERY_PUBLIC_LINK,
            SpecificationSheet.SENT_DELIVERY_EMAIL,
            SpecificationSheet.SENT_DELIVERY_OTHER,
        }:
            raise MissingDeliveryCapture()
        if not delivery_recipient_cleaned:
            raise MissingDeliveryCapture()

    # Director approval is gated on the project having a linked
    # customer — for CUSTOM projects. Signing off a Custom spec whose
    # formulation still points at nothing (or the "NPD Placeholder"
    # via PSP) locks in commercial terms against an unknown client —
    # bad for audit and worse for the proposal team who needs to know
    # who to invoice. RTG projects skip this — their specs cover the
    # SKU itself and customers get attached later at portal-order time.
    if next_status == SpecificationStatus.APPROVED:
        formulation = sheet.formulation_version.formulation
        if (
            formulation.customer_id is None
            and formulation.project_type != "ready_to_go"
        ):
            raise SpecRequiresCustomer()

    # Slot uniqueness on the ``in_review`` lane: the director has at
    # most one sheet of each ``document_kind`` queued for their
    # signature per project. Two drafts (or two finals) in_review on
    # the same formulation is almost always an accidental
    # double-submit, so we refuse and surface a dedicated error code
    # the UI can translate into "approve / revert the pending one
    # first." Draft and final slots are independent — one of each is
    # allowed at the same time.
    if next_status == SpecificationStatus.IN_REVIEW:
        clash = (
            SpecificationSheet.objects.filter(
                formulation_version__formulation_id=sheet.formulation_version.formulation_id,
                document_kind=sheet.document_kind,
                status=SpecificationStatus.IN_REVIEW,
            )
            .exclude(pk=sheet.pk)
            .exists()
        )
        if clash:
            raise SpecificationReviewSlotTaken()

    previous_status = sheet.status
    slot = _INTERNAL_SIGNATURE_SLOT.get((previous_status, next_status))
    normalised_image: str | None = None
    if slot is not None:
        try:
            normalised_image = validate_signature_image(signature_image)
        except SignatureImageInvalid as exc:
            raise SignatureRequired() from exc

    # If the caller bundled pricing into the approval payload, apply
    # it *before* the status flip so the values land outside the
    # ``_PRICING_LOCKED_STATUSES`` gate (the lock engages the moment
    # the sheet hits ``approved``). The ``allow_locked=True`` escape
    # hatch isn't needed because we're still on the pre-approved
    # status when this runs.
    if (
        pricing
        and next_status == SpecificationStatus.APPROVED
        and any(value is not None for value in pricing.values())
    ):
        set_spec_pricing(
            sheet=sheet,
            actor=actor,
            unit_cost=pricing.get("unit_cost"),
            margin_percent=pricing.get("margin_percent"),
            final_price=pricing.get("final_price"),
            quantity=pricing.get("quantity"),
            currency=pricing.get("currency"),
        )

    sheet.status = next_status
    sheet.updated_by = actor
    update_fields = ["status", "updated_by", "updated_at"]
    now = timezone.now()

    # Freeze delivery evidence onto the sheet at the send moment so
    # any downstream renderer / audit query reads the same values
    # the operator entered without joining against transition rows.
    if next_status == SpecificationStatus.SENT:
        sheet.sent_at = now
        sheet.sent_delivery_method = delivery_method_cleaned
        sheet.sent_recipient = delivery_recipient_cleaned
        update_fields += [
            "sent_at",
            "sent_delivery_method",
            "sent_recipient",
        ]

    if slot == "prepared_by":
        sheet.prepared_by_user = actor
        sheet.prepared_by_signed_at = now
        sheet.prepared_by_signature_image = normalised_image or ""
        update_fields += [
            "prepared_by_user",
            "prepared_by_signed_at",
            "prepared_by_signature_image",
        ]
    elif slot == "director":
        sheet.director_user = actor
        sheet.director_signed_at = now
        sheet.director_signature_image = normalised_image or ""
        update_fields += [
            "director_user",
            "director_signed_at",
            "director_signature_image",
        ]

    sheet.save(update_fields=update_fields)

    SpecificationTransition.objects.create(
        sheet=sheet,
        from_status=previous_status,
        to_status=next_status,
        actor=actor,
        notes=(notes or "").strip(),
    )
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.status_transition",
        target=sheet,
        before={"status": previous_status},
        after={"status": next_status, "notes": (notes or "").strip()},
    )

    # Director approval is the moment the sheet becomes quotable —
    # pin the formulation's ``approved_version_number`` to whichever
    # version this sheet was drafted against so the proposal-creation
    # version picker auto-selects the right snapshot. Last
    # director-signed sheet wins; subsequent approvals on later
    # versions overwrite the pointer, matching scientist intent that
    # the *latest* internally-blessed iteration is the one to quote.
    if next_status == SpecificationStatus.APPROVED:
        set_approved_version(
            formulation=sheet.formulation_version.formulation,
            actor=actor,
            version_number=sheet.formulation_version.version_number,
        )

        # Mirror the sign-off to PSP's CustomerOrder so its wizard
        # phase moves R&D → Awaiting proposal. Fires on
        # ``transaction.on_commit`` so a rollback (rare here but
        # possible) doesn't tell PSP the spec was signed when the
        # local write got rolled back. Silent-degrade — the PSP
        # service already swallows every PspError and logs it, so a
        # slow / down PSP doesn't block the sign-off flow.
        formulation = sheet.formulation_version.formulation
        sheet_id = sheet.pk

        def _fire_spec_approved_sync() -> None:
            from apps.specifications.models import SpecificationSheet
            from apps.psp.services import sync_customer_order_to_psp

            try:
                fresh_sheet = SpecificationSheet.objects.select_related(
                    "prepared_by_user", "director_user"
                ).get(pk=sheet_id)
                sync_customer_order_to_psp(
                    formulation=formulation,
                    approved_spec_sheet=fresh_sheet,
                )
            except Exception:
                logger.exception(
                    "spec-approved: sync_customer_order_to_psp bubbled "
                    "for formulation %s sheet %s",
                    formulation.pk,
                    sheet_id,
                )

        transaction.on_commit(_fire_spec_approved_sync)

    # Revert-out-of-APPROVED (director → reject / revert-to-draft, or
    # a later APPROVED → SENT that a subsequent revert bounces back)
    # should tell PSP the spec is no longer quotable so the wizard
    # bounces back from :awaiting_proposal to :r_and_d. Same silent-
    # degrade contract as the approval-sync above.
    if (
        previous_status == SpecificationStatus.APPROVED
        and next_status != SpecificationStatus.APPROVED
    ):
        formulation = sheet.formulation_version.formulation

        def _fire_spec_reverted_sync() -> None:
            from apps.psp.services import sync_customer_order_to_psp

            try:
                sync_customer_order_to_psp(
                    formulation=formulation,
                    spec_cleared=True,
                )
            except Exception:
                logger.exception(
                    "spec-reverted: sync_customer_order_to_psp bubbled "
                    "for formulation %s",
                    formulation.pk,
                )

        transaction.on_commit(_fire_spec_reverted_sync)

    # FINAL spec hitting ``sent`` is the moment the customer needs
    # to come back and authorise production. Fire the email on
    # ``transaction.on_commit`` so a rollback (rare here, but possible
    # if a downstream signal raises) doesn't leave the customer with
    # a "please sign" link to a sheet that never went out.
    if (
        next_status == SpecificationStatus.SENT
        and sheet.document_kind == SpecificationDocumentKind.FINAL
        and (sheet.customer_email or "").strip()
    ):
        sheet_id = sheet.pk

        def _fire_final_spec_email() -> None:
            from apps.specifications.email import (
                send_final_spec_to_client,
            )

            send_final_spec_to_client(sheet_id=sheet_id, actor=actor)

        transaction.on_commit(_fire_final_spec_email)

    return sheet


# ---------------------------------------------------------------------------
# Public preview link (F3.2) — token-gated read-only sharing
# ---------------------------------------------------------------------------


@transaction.atomic
def rotate_public_token(
    *, sheet: SpecificationSheet, actor: Any
) -> SpecificationSheet:
    """Issue a fresh opaque UUID as the sheet's public token.

    Calling this on a sheet that already had a token invalidates the
    previous one in the same write — useful when a client shares a
    link more widely than intended and the scientist wants to cut off
    access without deleting the sheet.

    Also revokes every :class:`apps.comments.models.KioskSession`
    that was issued against the old token so any still-open
    public-comment browser immediately gets bounced on its next
    request.

    Raises :class:`PublicLinkNotAllowedForDraft` when called on a
    DRAFT-kind sheet — public share is a customer-facing preview
    affordance, only valid on FINAL.
    """

    if sheet.document_kind == SpecificationDocumentKind.DRAFT:
        raise PublicLinkNotAllowedForDraft()

    previous_token = sheet.public_token
    sheet.public_token = uuid.uuid4()
    sheet.updated_by = actor
    sheet.save(update_fields=["public_token", "updated_by", "updated_at"])
    if previous_token is not None:
        from apps.comments.kiosk import revoke_sessions_for_token

        revoke_sessions_for_token(previous_token)
    record_audit(
        organization=sheet.organization,
        actor=actor,
        action="spec_sheet.rotate_public_token",
        target=sheet,
    )
    return sheet


@transaction.atomic
def revoke_public_token(
    *, sheet: SpecificationSheet, actor: Any
) -> SpecificationSheet:
    """Clear the sheet's public token so no one can hit the preview
    URL. Idempotent — calling on an already-revoked sheet is a no-op
    for the token but still bumps ``updated_by``/``updated_at``.

    Also revokes every kiosk session that was bound to that token.
    """

    had_token = sheet.public_token is not None
    previous_token = sheet.public_token
    sheet.public_token = None
    sheet.updated_by = actor
    sheet.save(update_fields=["public_token", "updated_by", "updated_at"])
    if had_token:
        from apps.comments.kiosk import revoke_sessions_for_token

        if previous_token is not None:
            revoke_sessions_for_token(previous_token)
        record_audit(
            organization=sheet.organization,
            actor=actor,
            action="spec_sheet.revoke_public_token",
            target=sheet,
        )
    return sheet


@transaction.atomic
def accept_as_customer(
    *,
    sheet: SpecificationSheet,
    signer_name: str,
    signer_email: str,
    signer_company: str,
    signature_image: str,
) -> SpecificationSheet:
    """Move a ``sent`` sheet to ``accepted`` with a customer signature.

    This is the kiosk path — the signer is not a platform user, so
    the API layer pulls identity off the active kiosk session
    (established when the visitor first opened the public link) and
    hands the name / email / company strings to this service. Those
    strings stamp onto the sheet alongside the drawn signature.

    When the sheet has an attached :class:`apps.proposals.models.Proposal`
    that is also in ``sent`` status, the same signature is written
    onto the proposal in the same transaction. Scientists almost never
    want a customer to accept the spec without also accepting the
    commercial offer, so we bundle them — the alternative (separate
    signatures on two scrolling kiosk pages) was the first thing R&D
    complained about when they reviewed the flow.

    Rejects:
    * Sheets whose status is not ``sent`` (any other state already
      landed somewhere the customer should not be able to push).
    * A missing / malformed signature image.
    * A blank signer name — we refuse to record an anonymous
      signature.
    """

    if sheet.status != SpecificationStatus.SENT:
        raise InvalidStatusTransition()

    normalised_image = validate_signature_image(signature_image)
    name = (signer_name or "").strip()
    if not name:
        raise SignatureRequired()

    previous_status = sheet.status
    sheet.status = SpecificationStatus.ACCEPTED
    sheet.customer_name = name
    sheet.customer_email = (signer_email or "").strip()
    sheet.customer_company = (signer_company or "").strip()
    sheet.customer_signature_image = normalised_image
    sheet.customer_signed_at = timezone.now()
    sheet.save(
        update_fields=[
            "status",
            "customer_name",
            "customer_email",
            "customer_company",
            "customer_signature_image",
            "customer_signed_at",
            "updated_at",
        ]
    )
    SpecificationTransition.objects.create(
        sheet=sheet,
        from_status=previous_status,
        to_status=SpecificationStatus.ACCEPTED,
        # Kiosk signers are not platform users; the audit row keeps
        # ``actor`` pointing at the sheet's last internal editor so
        # the foreign key stays satisfied, and the captured signer
        # identity lives on the sheet's ``customer_*`` columns.
        actor=sheet.updated_by,
        notes=f"Accepted by {name}".strip(),
    )
    record_audit(
        organization=sheet.organization,
        actor=sheet.updated_by,
        action="spec_sheet.customer_accept",
        target=sheet,
        before={"status": previous_status},
        after={
            "status": SpecificationStatus.ACCEPTED,
            "signer_name": name,
            "signer_email": sheet.customer_email,
            "signer_company": sheet.customer_company,
        },
    )

    # Bundled proposal signature. Import locally to dodge the
    # specifications → proposals → specifications circular import
    # (Proposal.specification_sheet is an FK back here).
    _sign_linked_proposal(
        sheet=sheet,
        name=name,
        email=sheet.customer_email,
        company=sheet.customer_company,
        signature_image=normalised_image,
    )

    # Customer signature is the project roadmap chip's only forward
    # trigger past ``in_development``. The target depends on both the
    # document kind AND the parent project's engagement type:
    #
    # Custom projects (bespoke laboratory development):
    #   * signed DRAFT sheet → ``pilot`` (unlocks trial batch phase)
    #   * signed FINAL sheet → ``approved`` (unlocks label design)
    #
    # Ready-to-go projects (existing validated recipe, straight to
    # manufacture — no trial batch, no final spec ever exists):
    #   * signed DRAFT sheet → ``approved`` (skip trial + final,
    #     bootstraps the LabelDesign chain immediately via the
    #     post_save signal on the spec sheet)
    #
    # Skip-ahead is fine — the roadmap is forward-only via
    # :func:`_maybe_advance_project_status`, so a later draft
    # signature can never demote an already-approved project. Actor
    # uses ``sheet.updated_by`` (the kiosk signer isn't a platform
    # user) so the audit row's FK stays valid.
    formulation = sheet.formulation_version.formulation

    # RTG signal: honour either the formulation's own project_type OR
    # the linked proposal's template_type. The two are supposed to
    # match — the create_proposal service defaults template_type from
    # formulation.project_type — but the proposal form lets the sales
    # rep override, and that override doesn't backfill the formulation.
    # Reading both here means "whatever the customer signed for" wins
    # over a stale formulation flag from before the sale.
    linked_proposal = getattr(sheet, "proposal", None)
    proposal_template_rtg = (
        linked_proposal is not None
        and getattr(linked_proposal, "template_type", None)
        == ProjectType.READY_TO_GO.value
    )
    is_ready_to_go = (
        formulation.project_type == ProjectType.READY_TO_GO.value
        or proposal_template_rtg
    )

    # When the proposal signals RTG but the formulation is still
    # tagged Custom, sync the formulation to match — that way the
    # rest of the workflow (stepper shape, wizard next-action, etc.)
    # reads a consistent story. Silently skipped when the formulation
    # is already the right type or when the guard would refuse the
    # switch anyway.
    if (
        is_ready_to_go
        and formulation.project_type != ProjectType.READY_TO_GO.value
    ):
        formulation.project_type = ProjectType.READY_TO_GO.value
        formulation.updated_by = sheet.updated_by
        formulation.save(update_fields=["project_type", "updated_by", "updated_at"])

    target_status: str | None = None
    if sheet.document_kind == SpecificationDocumentKind.DRAFT:
        target_status = (
            ProjectStatus.APPROVED.value
            if is_ready_to_go
            else ProjectStatus.PILOT.value
        )
    elif sheet.document_kind == SpecificationDocumentKind.FINAL:
        target_status = ProjectStatus.APPROVED.value
    if target_status is not None:
        _maybe_advance_project_status(
            formulation=formulation,
            target_status=target_status,
            actor=sheet.updated_by,
        )
    return sheet


def _sign_linked_proposal(
    *,
    sheet: SpecificationSheet,
    name: str,
    email: str,
    company: str,
    signature_image: str,
) -> None:
    """Mirror the customer signature onto the attached proposal (if any).

    Only writes when the linked proposal is in ``sent`` — other
    states mean the scientist has not finished internal review and
    the kiosk should not advance it. The spec sheet accept path
    already validates signature + signer name, so we re-use those
    values directly rather than re-running the same checks.
    """

    # Lazy import — Proposal.specification_sheet points back here so
    # top-level imports would deadlock.
    from apps.proposals.models import Proposal, ProposalStatus, ProposalStatusTransition

    proposal = Proposal.objects.filter(
        specification_sheet_id=sheet.id
    ).first()
    if proposal is None:
        return
    if proposal.status != ProposalStatus.SENT.value:
        return

    previous = proposal.status
    proposal.status = ProposalStatus.ACCEPTED.value
    proposal.customer_signer_name = name
    proposal.customer_signer_email = email
    proposal.customer_signer_company = company
    proposal.customer_signature_image = signature_image
    proposal.customer_signed_at = timezone.now()
    proposal.save(
        update_fields=[
            "status",
            "customer_signer_name",
            "customer_signer_email",
            "customer_signer_company",
            "customer_signature_image",
            "customer_signed_at",
            "updated_at",
        ]
    )
    ProposalStatusTransition.objects.create(
        proposal=proposal,
        from_status=previous,
        to_status=ProposalStatus.ACCEPTED.value,
        actor=sheet.updated_by,
        notes=f"Accepted by {name} (bundled with spec sheet)",
    )
    record_audit(
        organization=proposal.organization,
        actor=sheet.updated_by,
        action="proposal.customer_accept",
        target=proposal,
        before={"status": previous},
        after={
            "status": ProposalStatus.ACCEPTED.value,
            "signer_name": name,
            "signer_email": email,
            "signer_company": company,
            "bundled_with_spec_sheet": str(sheet.id),
        },
    )


def get_by_public_token(token: Any) -> SpecificationSheet:
    """Look up a sheet by its public token.

    Raises :class:`PublicLinkNotEnabled` both when the token is
    malformed, when no sheet matches, and when a sheet exists but its
    token has since been revoked. A single error code keeps the public
    endpoint from leaking "this sheet exists but you can't see it".
    """

    try:
        token_uuid = uuid.UUID(str(token))
    except (ValueError, TypeError) as exc:
        raise PublicLinkNotEnabled() from exc

    sheet = (
        SpecificationSheet.objects.select_related(
            *_SHEET_RELATED,
            "organization",
        )
        .filter(public_token=token_uuid)
        .first()
    )
    if sheet is None:
        raise PublicLinkNotEnabled()
    return sheet


# ---------------------------------------------------------------------------
# Render context — the flat view-model the frontend renders
# ---------------------------------------------------------------------------


def _signature_payload(
    *, user, signed_at, image: str
) -> dict[str, Any] | None:
    """Shape an internal-role signature (prepared-by / director) for
    the render payload. ``None`` when no signature has landed yet so
    the UI can render the empty state instead of a name with no
    signed-at timestamp."""

    if user is None or signed_at is None:
        return None
    return {
        "user_id": str(user.id),
        "name": (user.get_full_name() or user.email or "").strip(),
        "email": user.email,
        "signed_at": signed_at.isoformat(),
        "image": image or "",
    }


#: Status ordering for the heuristic fallback below — a sheet at or
#: past one of these states is treated as having implicitly cleared
#: the matching internal signature gate, even when the explicit
#: ``*_user`` / ``*_signed_at`` columns are blank.
_STATUS_RANK = {
    "draft": 0,
    "in_review": 1,
    "approved": 2,
    "sent": 3,
    "accepted": 4,
    "rejected": 0,  # rejected proves nothing about prior approval
}


def _resolve_internal_signature(
    *,
    sheet,
    user,
    signed_at,
    image: str,
    required_from_status,
) -> dict[str, Any] | None:
    """Like :func:`_signature_payload` but falls back to a
    best-effort heuristic when the sheet's lifecycle has clearly
    advanced past the matching signature gate but the explicit
    ``*_user`` / ``*_signed_at`` columns are blank.

    Why this exists: some sheets in production were created with
    their status set directly (via admin / data migration / seed
    scripts) and never went through :func:`transition_status`, so
    the in-row signature stamps are NULL even though the sheet is
    at ``sent`` / ``accepted``. Showing those sheets with a blank
    "Prepared by" / "Director" line — when the customer is reading
    a clearly-approved document — confused reviewers.

    Fallback uses ``sheet.updated_by`` as the actor and
    ``sheet.updated_at`` as the timestamp, the same pair the audit
    log would attribute the last write to. The image stays empty
    because we genuinely don't have one.
    """

    primary = _signature_payload(user=user, signed_at=signed_at, image=image)
    if primary is not None:
        return primary

    required_rank = _STATUS_RANK.get(
        required_from_status.value
        if hasattr(required_from_status, "value")
        else required_from_status,
        0,
    )
    current_rank = _STATUS_RANK.get(sheet.status, 0)
    if current_rank < required_rank:
        return None

    fallback_user = sheet.updated_by
    if fallback_user is None:
        return None
    return {
        "user_id": str(fallback_user.id),
        "name": (
            fallback_user.get_full_name() or fallback_user.email or ""
        ).strip(),
        "email": fallback_user.email or "",
        "signed_at": sheet.updated_at.isoformat() if sheet.updated_at else "",
        "image": "",
    }


def _coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        trimmed = value.strip()
        if not trimmed:
            return None
        try:
            return float(trimmed)
        except ValueError:
            return None
    return None


def _coerce_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _packaging_label(item: Item | None) -> str:
    """Render a packaging slot for the customer-facing spec sheet.

    Emits only the item name (e.g. ``Closure 38mm CT Metal Gold``).
    The internal procurement code is intentionally suppressed — the
    spec sheet is a customer deliverable and internal SKUs leak
    supplier-level signal that shouldn't ship with the document.
    Falls back to the TBD placeholder when no slot is picked, and to
    the code when the catalogue row is missing a name (defensive: a
    blank cell would otherwise hide the slot entirely).
    """

    if item is None:
        return PACKAGING_PLACEHOLDER
    name = (item.name or "").strip()
    if name:
        return name
    code = (item.internal_code or "").strip()
    return code or PACKAGING_PLACEHOLDER


def _compute_filled_total_mg(
    *,
    dosage_form: str,
    size_key: Any,
    fill_weight_mg: Any,
) -> Decimal | None:
    """Return the **filled capsule / tablet weight** including the
    empty capsule shell for capsule products.

    Capsules: ``fill_weight + shell_weight`` where the shell weight is
    looked up from the snapshot's ``size_key``. Tablets, powders,
    gummies and liquids have no shell so the filled total equals the
    fill weight already reported by the formulation engine. Returns
    ``None`` when the fill weight itself is missing.
    """

    fill = _coerce_decimal(fill_weight_mg)
    if fill is None:
        return None
    if dosage_form == DosageForm.CAPSULE.value and isinstance(size_key, str):
        capsule = capsule_size_by_key(size_key)
        if capsule is not None:
            shell = Decimal(str(capsule.shell_weight_mg))
            return (fill + shell).quantize(Decimal("0.0001"))
    return fill


def _nrv_percent(
    claim_mg: Any, item_attributes: dict[str, Any] | None
) -> str | None:
    """Return the ``%NRV`` cell for one active row.

    Falls back to ``None`` when the raw material's ``nrv_mg`` is not a
    positive number — most botanicals and excipients have no
    regulatory NRV so the cell stays blank, matching the workbook's
    ``N/A`` convention.
    """

    nrv_mg = _coerce_float((item_attributes or {}).get("nrv_mg"))
    claim = _coerce_float(claim_mg)
    if not nrv_mg or nrv_mg <= 0 or claim is None or claim <= 0:
        return None
    return f"{(claim / nrv_mg) * 100:.1f}"


def _apply_limits_overrides(
    rows: list[dict[str, str]], overrides: dict[str, str]
) -> list[dict[str, str]]:
    """Layer ``snapshot_overrides.limits`` on top of the resolved
    safety-limit rows. The legacy ``SpecificationSheet.limits_override``
    field still drives :func:`resolve_limits`, but this newer override
    section lets a scientist edit individual limit cells through the
    same modal that gates every other client-facing tweak."""

    if not overrides:
        return rows
    patched: list[dict[str, str]] = []
    for row in rows:
        slug = row.get("slug") or ""
        override_value = overrides.get(slug)
        if isinstance(override_value, str) and override_value:
            patched.append(
                {
                    **row,
                    "value": override_value,
                    "value_overridden": True,
                }
            )
        else:
            patched.append(row)
    return patched


def resolve_limits(sheet: SpecificationSheet) -> list[dict[str, str]]:
    """Compute the Microbiological / PAH / Pesticides / Heavy Metal block.

    Precedence order (highest first):

    1. :attr:`SpecificationSheet.limits_override` — a per-sheet
       ``{slug: value}`` dict the scientist edited on this specific
       deliverable.
    2. :attr:`Organization.default_spec_limits` — the tenant-level
       defaults seeded on org creation and editable by an admin.
    3. :data:`DEFAULT_SAFETY_LIMITS` — canonical values from the
       Valley workbook, so a brand-new org with an empty dict still
       renders sane limits.

    Return order matches :data:`SAFETY_LIMIT_ROWS` so every spec
    sheet produced by the org lists the rows in the same top-down
    order the printed workbook uses.
    """

    organization = sheet.organization
    org_defaults = organization.default_spec_limits or {}
    overrides = sheet.limits_override or {}

    rows: list[dict[str, str]] = []
    for slug, label in SAFETY_LIMIT_ROWS:
        value = (
            overrides.get(slug)
            or org_defaults.get(slug)
            or DEFAULT_SAFETY_LIMITS.get(slug, "")
        )
        rows.append({"slug": slug, "name": label, "value": value})
    return rows


def resolve_visibility(sheet: SpecificationSheet) -> dict[str, bool]:
    """Return the fully-populated ``{section_slug: visible}`` map.

    Keys that the sheet's ``section_visibility`` JSON omits default
    to ``True`` so pre-feature sheets and freshly-created sheets both
    render in full — the only way to hide a section is to explicitly
    write ``False`` through the manage-visibility endpoint. The
    renderer consults this map; the frontend also receives it so the
    admin view can show a "hidden by you" badge next to each section.
    """

    stored = sheet.section_visibility or {}
    return {slug: bool(stored.get(slug, True)) for slug in VISIBILITY_SLUGS}


def resolve_section_order(sheet: SpecificationSheet) -> list[str]:
    """Return the effective render order of section slugs.

    Honour ``sheet.section_order`` when present, dedupe against the
    canonical :data:`SECTION_SLUGS` tuple, and append any known
    sections the stored override forgot so a stale map cannot hide a
    newly-introduced section. Unknown slugs are silently dropped —
    the admin may have renamed a feature away.
    """

    stored = sheet.section_order or []
    seen: set[str] = set()
    ordered: list[str] = []
    for slug in stored:
        if not isinstance(slug, str):
            continue
        if slug not in SECTION_SLUGS or slug in seen:
            continue
        ordered.append(slug)
        seen.add(slug)
    for slug in SECTION_SLUGS:
        if slug in seen:
            continue
        ordered.append(slug)
    return ordered


def show_watermark_for(document_kind: str) -> bool:
    """Decide whether the sheet should render its diagonal ``DRAFT``
    watermark.

    The rule now hinges on the explicit ``document_kind`` flag: a
    sheet marked ``final`` prints clean regardless of approval
    status, and a sheet marked ``draft`` keeps the watermark even if
    the lifecycle has reached ``approved``. This matches how
    scientists actually use the document — an "internal review
    draft" and a "client-ready final" are two distinct outputs even
    for the same underlying version.
    """

    return document_kind != SpecificationDocumentKind.FINAL.value


def _augment_declaration_with_bolding(
    text: str,
    entries: list[dict[str, Any]],
) -> str:
    """Wrap allergen labels in ``<b>…</b>`` inside the frozen
    declaration string.

    Snapshots taken before the EU-1169-bolding rollout stored
    ``declaration.text`` as plain text. Re-rendering the whole string
    at view time would require ``use_as`` data the frozen entries
    don't carry, so we take the cheaper path: walk the entries list,
    pull out every ``is_allergen`` label, and substitute that label
    inside ``text`` with a bold-wrapped version.

    Skipped when ``text`` already contains ``<b>`` (a fresh snapshot
    produced by the new pipeline already has the markup, no need to
    double-wrap). HTML-escapes the result so any stray special chars
    in labels remain safe to inject via ``|safe`` /
    ``dangerouslySetInnerHTML``.
    """

    if not text:
        return ""
    if "<b>" in text or "<B>" in text:
        # Already-bolded snapshot — pass through unchanged.
        return text

    allergen_labels: list[str] = []
    for entry in entries:
        if not entry.get("is_allergen"):
            continue
        label = (entry.get("label") or "").strip()
        if label and label not in allergen_labels:
            allergen_labels.append(label)

    escaped = html.escape(text)
    if not allergen_labels:
        return escaped

    # Sort by length descending so longer labels match before any
    # shorter substring of them — protects "Whey Protein Isolate"
    # from being half-bolded by an entry just titled "Whey".
    for label in sorted(allergen_labels, key=len, reverse=True):
        escaped_label = html.escape(label)
        pattern = re.compile(
            r"(?<![A-Za-z0-9])" + re.escape(escaped_label) + r"(?![A-Za-z0-9])"
        )
        escaped = pattern.sub(
            lambda m, lbl=escaped_label: f"<b>{lbl}</b>", escaped
        )
    return escaped


#: Map of declaration-entry ``slug`` → list of override keys that feed
#: that entry. Anticaking is the only many-to-one mapping (mg_stearate
#: + silica collapse into one row); every other slug pairs 1:1 with
#: its override key. Used only to know whether an override is in
#: scope; the actual mg recomputation happens inline below.
_EXCIPIENT_SLUG_OVERRIDE_KEYS: dict[str, tuple[str, ...]] = {
    EXCIPIENT_SLUG_MCC: ("mcc_mg",),
    EXCIPIENT_SLUG_DCP: ("dcp_mg",),
    EXCIPIENT_SLUG_GUMMY_BASE: ("gummy_base_mg",),
    EXCIPIENT_SLUG_WATER: ("water_mg",),
    EXCIPIENT_SLUG_ANTICAKING: ("mg_stearate_mg", "silica_mg"),
}


#: Label-based fallback so snapshots taken before the per-entry
#: ``slug`` field landed still respect an excipients_mg override. Each
#: entry whose label matches one of these (case-insensitive, exact)
#: gets pinned to the corresponding canonical slug at render time.
_EXCIPIENT_LABEL_TO_SLUG: dict[str, str] = {
    EXCIPIENT_LABEL_MCC.lower(): EXCIPIENT_SLUG_MCC,
    "microcrystalline cellulose": EXCIPIENT_SLUG_MCC,
    EXCIPIENT_LABEL_DCP.lower(): EXCIPIENT_SLUG_DCP,
    EXCIPIENT_LABEL_GUMMY_BASE.lower(): EXCIPIENT_SLUG_GUMMY_BASE,
    EXCIPIENT_LABEL_WATER.lower(): EXCIPIENT_SLUG_WATER,
    EXCIPIENT_LABEL_ANTICAKING.lower(): EXCIPIENT_SLUG_ANTICAKING,
}


def _resolve_entry_slug(
    entry: dict[str, Any],
    *,
    label_index: dict[str, str] | None = None,
) -> str:
    """Return the override slug a declaration entry pairs with.

    Prefers the ``slug`` field stored on the entry (snapshots produced
    after the per-entry slug rollout) and falls back to a label
    heuristic so override edits still land on legacy snapshots that
    pre-date that field. ``label_index`` is an optional per-render
    map of ``label.lower() → canonical_slug`` populated from
    ``totals.excipients.mcc_carrier_rows`` / ``dcp_carrier_rows`` /
    ``gummy_base_rows`` so per-pick entries (e.g. "MCC PH-101") still
    pair with their typed-cell override key (e.g. ``mcc_mg``) on
    legacy snapshots. Returns an empty string when the entry is
    untargetable — actives, capsule shell, and per-pick rows whose
    label does not match a known synthetic excipient."""

    slug = entry.get("slug")
    if isinstance(slug, str) and slug:
        return slug
    label = (entry.get("label") or "").strip().lower()
    if not label:
        return ""
    if label_index and label in label_index:
        return label_index[label]
    return _EXCIPIENT_LABEL_TO_SLUG.get(label, "")


def _build_carrier_label_index(
    excipients: dict[str, Any] | None,
) -> dict[str, str]:
    """Map per-pick excipient labels back to their canonical override
    slug so legacy snapshots — saved before the per-entry slug field
    landed — still resolve through to the right ``excipients_mg``
    key. Walks every snapshot row collection that carries a stable
    identifier (carrier picks, gummy base picks, the open-ended
    ``rows`` list powder + gummy use) and pins each row's display
    label to the slug that drives it."""

    if not excipients:
        return {}
    index: dict[str, str] = {}
    for row in excipients.get("mcc_carrier_rows") or []:
        label = (row.get("label") if isinstance(row, dict) else None) or ""
        key = label.strip().lower()
        if key:
            index[key] = EXCIPIENT_SLUG_MCC
    for row in excipients.get("dcp_carrier_rows") or []:
        label = (row.get("label") if isinstance(row, dict) else None) or ""
        key = label.strip().lower()
        if key:
            index[key] = EXCIPIENT_SLUG_DCP
    # Gummy-base picks already serialise per-pick override keys
    # ``gummy_base:<item_id>``; legacy snapshots without entry slugs
    # still get hit on the label so the typed-cell ``gummy_base_mg``
    # override drops them too.
    for row in excipients.get("gummy_base_rows") or []:
        label = (row.get("label") if isinstance(row, dict) else None) or ""
        key = label.strip().lower()
        if key:
            index[key] = EXCIPIENT_SLUG_GUMMY_BASE
    # Powder + gummy flexible ``rows`` — the slug drives the override
    # key directly (``trisodium_citrate``, ``citric_acid``,
    # ``flavouring:<id>``, etc.). Pin the label so legacy declaration
    # entries that still emit only the label resolve to the row's
    # own slug.
    for row in excipients.get("rows") or []:
        if not isinstance(row, dict):
            continue
        slug = row.get("slug")
        if not isinstance(slug, str) or not slug:
            continue
        label = (row.get("label") or "").strip().lower()
        if label and label not in index:
            index[label] = slug
    return index


def _coerce_override_decimal(raw: Any) -> Decimal | None:
    """Tolerant Decimal parse — empty / unparseable values mean
    "leave the snapshot mg alone"; ``"0"`` / ``Decimal("0")`` mean
    "drop the row"; anything positive replaces the mg. ``None`` is
    returned for unparseable inputs so callers can keep the original
    value rather than silently zeroing it."""

    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    if isinstance(raw, (int, float)):
        try:
            return Decimal(str(raw))
        except (InvalidOperation, ValueError):
            return None
    if isinstance(raw, str):
        trimmed = raw.strip()
        if not trimmed:
            return None
        try:
            return Decimal(trimmed)
        except (InvalidOperation, ValueError):
            return None
    return None


def _format_grouped_declaration_from_entries(
    entries: list[dict[str, Any]],
) -> str:
    """Render the EU 1169/2011 grouped declaration string from a list
    of snapshot-shaped entry dicts.

    Mirrors ``apps.formulations.services._format_grouped_declaration``
    so an entry with a non-empty ``use_as`` joins ``"<Category> (member1,
    member2)"`` while standalone rows print their own label. The
    chunked string is sorted by the heaviest member's mg so the
    grouped phrasing slots in by weight rather than by insertion
    order. Allergen labels are wrapped in ``<b>…</b>`` to preserve the
    bolded-allergen contract every downstream renderer expects."""

    groups: dict[str, list[dict[str, Any]]] = {}
    standalone: list[dict[str, Any]] = []
    for entry in entries:
        use_as = (entry.get("use_as") or "").strip()
        if use_as and use_as != "Active":
            groups.setdefault(use_as, []).append(entry)
        else:
            standalone.append(entry)

    def render_label(entry: dict[str, Any]) -> str:
        escaped = html.escape((entry.get("label") or "").strip())
        return f"<b>{escaped}</b>" if entry.get("is_allergen") else escaped

    def entry_mg(entry: dict[str, Any]) -> float:
        try:
            return float(Decimal(str(entry.get("mg") or "0")))
        except (InvalidOperation, ValueError):
            return 0.0

    chunks: list[tuple[float, str]] = []
    for entry in standalone:
        chunks.append((entry_mg(entry), render_label(entry)))
    for category, members in groups.items():
        members.sort(key=lambda e: (-entry_mg(e), (e.get("label") or "")))
        leading = entry_mg(members[0])
        names = ", ".join(render_label(m) for m in members)
        chunks.append((leading, f"{html.escape(category)} ({names})"))

    chunks.sort(key=lambda c: -c[0])
    return ", ".join(rendered for _, rendered in chunks)


def _apply_excipient_overrides_to_declaration(
    declaration: dict[str, Any],
    excipient_mg_overrides: dict[str, str],
    *,
    excipients_payload: dict[str, Any] | None = None,
    excipients_label_overrides: dict[str, str] | None = None,
    capsule_shell_override: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Filter / rewrite a snapshot's declaration entries based on the
    sheet's ``excipients_mg`` overrides, then rebuild the joined text
    so the declaration string and the per-row table stay in sync.

    Rules:

    * An override value that parses to ``0`` (any sign) drops the
      matching entry from the declaration entirely — the spec sheet
      stops listing it on both the excipient table and the joined
      ingredient string. This is what scientists hit when a customer
      asks for a "no excipients" capsule.
    * A positive override replaces the entry's mg and tags the entry
      with ``mg_overridden`` so the UI can badge the edit.
    * Anticaking is special: a single declaration row collapses two
      override keys (``mg_stearate_mg`` + ``silica_mg``). The new mg
      is the sum of (override-or-snapshot mg_stearate) + (override-or-
      snapshot silica); zero on both keys drops the row.
    * Per-row overrides keyed by ``gummy_base:<id>`` or by an
      arbitrary ``excipients.rows`` slug match the entry whose ``slug``
      field matches that key (or, for legacy snapshots without slugs,
      a label-based heuristic).
    * Unmatched entries pass through unchanged.

    Old snapshots taken before the per-entry slug field still respect
    canonical-slug overrides through ``_resolve_entry_slug``'s label
    heuristic. Per-row overrides on legacy data are no-ops (no slug,
    no label match) — re-saving the formulation rebuilds the snapshot
    with slugs and the override starts taking effect."""

    label_overrides = excipients_label_overrides or {}
    shell_override = capsule_shell_override or {}
    has_any_override = bool(
        excipient_mg_overrides or label_overrides or shell_override
    )
    if not has_any_override:
        return declaration

    raw_entries = declaration.get("entries") or []
    if not isinstance(raw_entries, list) or not raw_entries:
        return declaration

    # Build the legacy-snapshot fallback index once per render so per-
    # pick MCC / DCP / gummy-base entries (saved before the per-entry
    # slug field landed) still resolve through to their typed-cell
    # override key.
    label_index = _build_carrier_label_index(excipients_payload)

    # Pre-resolve the anticaking override since it spans two keys.
    # ``None`` means "no override touches it"; a Decimal (incl. zero)
    # means "rewrite to this mg or drop".
    anticaking_total: Decimal | None = None
    if (
        "mg_stearate_mg" in excipient_mg_overrides
        or "silica_mg" in excipient_mg_overrides
    ):
        # Snapshot baseline pulled from the matching declaration entry
        # rather than ``totals.excipients`` so legacy snapshots that
        # only stored the entry list still work.
        snapshot_anticaking_mg = Decimal("0")
        for entry in raw_entries:
            if _resolve_entry_slug(entry, label_index=label_index) == EXCIPIENT_SLUG_ANTICAKING:
                snapshot_total = _coerce_override_decimal(entry.get("mg"))
                if snapshot_total is not None:
                    snapshot_anticaking_mg = snapshot_total
                break
        # Without explicit per-component snapshot mg numbers in the
        # entries list we can't split the baseline cleanly. Use the
        # overrides where given and zero the side that wasn't
        # overridden — matches scientist expectation that editing one
        # cell silences the other half.
        stearate_o = _coerce_override_decimal(
            excipient_mg_overrides.get("mg_stearate_mg")
        )
        silica_o = _coerce_override_decimal(
            excipient_mg_overrides.get("silica_mg")
        )
        if stearate_o is not None or silica_o is not None:
            stearate_part = (
                stearate_o
                if stearate_o is not None
                else snapshot_anticaking_mg
            )
            silica_part = silica_o if silica_o is not None else Decimal("0")
            # When ONLY silica is overridden the snapshot baseline
            # already covers the stearate share; flip the picks above
            # so the unmodified side keeps its baseline weight.
            if stearate_o is None and silica_o is not None:
                stearate_part = snapshot_anticaking_mg
                silica_part = silica_o
            anticaking_total = stearate_part + silica_part

    new_entries: list[dict[str, Any]] = []
    for entry in raw_entries:
        if not isinstance(entry, dict):
            new_entries.append(entry)
            continue
        slug = _resolve_entry_slug(entry, label_index=label_index)

        # Capsule shell — its own override section with both ``label``
        # and ``mg`` keys. ``mg = "0"`` drops the row, anything else
        # rewrites in place. Pre-empts the generic slug pass.
        if slug == EXCIPIENT_SLUG_CAPSULE_SHELL and shell_override:
            shell_mg_raw = shell_override.get("mg")
            if shell_mg_raw is not None and shell_mg_raw != "":
                shell_mg = _coerce_override_decimal(shell_mg_raw)
                if shell_mg is not None and shell_mg <= 0:
                    continue
                if shell_mg is not None:
                    entry = {
                        **entry,
                        "mg": str(shell_mg),
                        "mg_overridden": True,
                    }
            shell_label = shell_override.get("label")
            if isinstance(shell_label, str) and shell_label.strip():
                entry = {
                    **entry,
                    "label": shell_label.strip(),
                    "label_overridden": True,
                }
            new_entries.append(entry)
            continue

        # Anticaking is the only slug that aggregates two override
        # keys; handle it before the generic per-slug pass so the sum
        # logic above is the single source of truth for that row.
        if slug == EXCIPIENT_SLUG_ANTICAKING and anticaking_total is not None:
            if anticaking_total <= 0:
                continue
            new_entries.append(
                {
                    **entry,
                    "mg": str(anticaking_total),
                    "mg_overridden": True,
                }
            )
            continue

        # Generic 1:1 path: an override key that names the slug
        # directly drops or rewrites the row.
        candidate_keys: tuple[str, ...] = (slug,) if slug else ()
        if slug in _EXCIPIENT_SLUG_OVERRIDE_KEYS:
            candidate_keys = _EXCIPIENT_SLUG_OVERRIDE_KEYS[slug]
        override_key = next(
            (k for k in candidate_keys if k in excipient_mg_overrides),
            None,
        )
        if override_key is None:
            new_entries.append(entry)
            continue

        new_mg = _coerce_override_decimal(excipient_mg_overrides[override_key])
        if new_mg is None:
            new_entries.append(entry)
            continue
        if new_mg <= 0:
            # Drop the row entirely — disappears from both the
            # excipient table and the joined declaration text.
            continue
        new_entries.append(
            {
                **entry,
                "mg": str(new_mg),
                "mg_overridden": True,
            }
        )

    # Per-row label rewrites. Walk the surviving entries one more
    # time and apply ``excipients_label_overrides`` by the same slug
    # the mg overrides used. Empty / whitespace-only overrides leave
    # the original label alone.
    if label_overrides:
        relabelled: list[dict[str, Any]] = []
        for entry in new_entries:
            if not isinstance(entry, dict):
                relabelled.append(entry)
                continue
            slug = _resolve_entry_slug(entry, label_index=label_index)
            override_label = label_overrides.get(slug) if slug else None
            if isinstance(override_label, str) and override_label.strip():
                relabelled.append(
                    {
                        **entry,
                        "label": override_label.strip(),
                        "label_overridden": True,
                    }
                )
            else:
                relabelled.append(entry)
        new_entries = relabelled

    # Rebuild the joined string from the filtered entries so the
    # declaration paragraph never lists a row the table no longer
    # shows. ``_format_grouped_declaration_from_entries`` mirrors the
    # snapshot-time formatter so EU 1169/2011 grouping survives the
    # rewrite.
    rebuilt_text = _format_grouped_declaration_from_entries(new_entries)

    # Sort by mg desc to match the snapshot-time ordering rule the
    # frontend assumes when it walks ``rendered.declaration.entries``.
    def entry_mg(entry: dict[str, Any]) -> float:
        try:
            return float(Decimal(str(entry.get("mg") or "0")))
        except (InvalidOperation, ValueError):
            return 0.0

    new_entries.sort(key=lambda e: (-entry_mg(e), (e.get("label") or "")))

    return {
        **declaration,
        "entries": new_entries,
        "text": rebuilt_text,
    }


# ---------------------------------------------------------------------------
# Snapshot override validation + merge (Phase G5a)
# ---------------------------------------------------------------------------


#: Top-level keys allowed in :attr:`SpecificationSheet.snapshot_overrides`.
#: Anything else is rejected at write time so a stray key from a future
#: build never silently no-ops on render.
_OVERRIDE_SECTIONS: frozenset[str] = frozenset(
    {
        "formulation",
        "declaration",
        "allergens",
        "compliance",
        "actives",
        "excipients_mg",
        # Per-row excipient label rewrites — keyed by the same slug
        # as ``excipients_mg`` so a row can have either / both edits.
        "excipients_label",
        # Single-row capsule shell override (label + mg).
        "capsule_shell",
        # Free-form per-row Nutrition Information edits keyed by the
        # snapshot row's slug (``energy_kj``, ``fat_g``, ...). Each
        # row carries an ``amount_per_100g`` and ``amount_per_serving``
        # string so commercial leads can re-state the nutrition panel
        # against an off-spec serving size without re-saving the
        # formulation.
        "nutrition",
        # Same shape for the amino acid block. Keyed by group slug
        # (``essential`` / ``non_essential`` / ``conditional``) with
        # nested ``{<acid_key>: amount_string}`` payloads.
        "amino_acids",
        # Microbiological / heavy-metal / pesticide spec limits.
        # Mirrors the legacy ``SpecificationSheet.limits_override``
        # JSON field so a single place gates every "client-facing
        # numbers" edit.
        "limits",
        # Top-level metadata / weight rows surfaced on the Product
        # Specification block: filled total weight, weight uniformity
        # tolerance, total weight label, etc.
        "metadata",
    }
)

#: Per-section schema. Each entry is the set of keys that section
#: accepts. ``actives`` uses a different layout — the keys at that
#: level are line ids and the value is a ``{label_claim_mg, nrv_pct}``
#: dict — so it is validated separately below.
_OVERRIDE_KEYS_PER_SECTION: dict[str, frozenset[str]] = {
    "formulation": frozenset(
        {
            "directions_of_use",
            "suggested_dosage",
            "appearance",
            "disintegration_spec",
        }
    ),
    "declaration": frozenset({"text"}),
    "allergens": frozenset({"sources"}),
    "compliance": frozenset({"vegan", "organic", "halal", "kosher"}),
    "capsule_shell": frozenset({"label", "mg"}),
    "metadata": frozenset(
        {
            "filled_total_mg",
            "total_weight_label",
            "weight_uniformity",
            "powder_per_serving_mg",
            "powder_pack_total_mg",
        }
    ),
}

#: Per-line keys allowed inside ``actives.<line_id>``. Three string
#: fields: the numeric claim, the %NRV badge, and the displayed
#: ingredient name (which until now was locked to the catalogue
#: value — now editable so a client-specific spec sheet can rename
#: an active without forking the formulation).
_OVERRIDE_ACTIVE_KEYS: frozenset[str] = frozenset(
    {"label_claim_mg", "nrv_pct", "ingredient_list_name"}
)

#: Per-row keys allowed inside ``nutrition.<row_slug>`` and
#: ``amino_acids.<group_key>``. Free-form numeric strings (the spec
#: sheet's nutrition panel renders strings verbatim, no quantisation).
_OVERRIDE_NUTRITION_KEYS: frozenset[str] = frozenset(
    {"amount_per_100g", "amount_per_serving"}
)

#: Compliance flag values the validator accepts. Map onto the same
#: tri-state the snapshot exposes (yes / no / unknown). ``""`` is
#: treated as a clear-the-override sentinel by the merge layer.
_OVERRIDE_COMPLIANCE_VALUES: frozenset[str] = frozenset(
    {"yes", "no", "unknown", ""}
)


def _validate_snapshot_overrides(value: Any) -> dict[str, Any]:
    """Coerce + validate an incoming ``snapshot_overrides`` payload.

    * ``None`` / ``{}`` — no overrides, returned as ``{}``.
    * Top-level keys must sit in :data:`_OVERRIDE_SECTIONS`.
    * Each section's inner keys must match the per-section schema.
    * Compliance flag values must be ``yes`` / ``no`` / ``unknown``
      (or ``""`` to clear that key).
    * Allergens must be a list of non-empty strings.
    * Active per-line entries must be keyed by string id and only
      carry ``label_claim_mg`` / ``nrv_pct`` numeric strings.

    Raises :class:`InvalidSnapshotOverrides` on any structural error.
    """

    if value is None:
        return {}
    if not isinstance(value, dict):
        raise InvalidSnapshotOverrides()

    cleaned: dict[str, Any] = {}
    for section, inner in value.items():
        if section not in _OVERRIDE_SECTIONS:
            raise InvalidSnapshotOverrides()
        if inner is None:
            # Explicit ``null`` clears the whole section.
            continue
        if not isinstance(inner, dict):
            raise InvalidSnapshotOverrides()

        if section in {"excipients_mg", "excipients_label", "limits"}:
            # All three accept the same shape: ``{slug: free_text_string}``.
            # ``excipients_mg`` keys are the totals ``excipients.rows``
            # slugs ("acidity", "flavouring", "flavouring:<id>", etc.)
            # plus the four typed cells ("water_mg", "gummy_base_mg",
            # "mg_stearate_mg", "silica_mg", "mcc_mg", "dcp_mg"); values
            # are decimal strings ("200", "199.85"). ``excipients_label``
            # uses the same slugs and value-rewrites the displayed
            # excipient name. ``limits`` keys are the safety-limit
            # slugs (``total_aerobic``, ``e_coli``, ...) and accept
            # any free-form string ("≤10,000 cfu/g", "Comply with EU").
            cleaned_flat: dict[str, str] = {}
            for row_slug, raw in inner.items():
                if not isinstance(row_slug, str) or not row_slug:
                    raise InvalidSnapshotOverrides()
                if raw is None or raw == "":
                    continue
                if isinstance(raw, bool):
                    raise InvalidSnapshotOverrides()
                if isinstance(raw, (int, float)):
                    cleaned_flat[row_slug] = str(raw)
                    continue
                if isinstance(raw, str):
                    cleaned_flat[row_slug] = raw
                    continue
                raise InvalidSnapshotOverrides()
            if cleaned_flat:
                cleaned[section] = cleaned_flat
            continue

        if section in {"nutrition", "amino_acids"}:
            # ``{row_or_group_slug: {sub_key: value_string}}``. Inner
            # keys are constrained to a fixed vocabulary so the UI
            # cannot stuff arbitrary structured data here. Nutrition
            # uses ``amount_per_100g`` / ``amount_per_serving``;
            # amino_acids uses any string-keyed ``<acid_key>`` value
            # since acid keys are fluid (catalogue-driven).
            cleaned_nested: dict[str, dict[str, str]] = {}
            for outer_key, payload in inner.items():
                if not isinstance(outer_key, str) or not outer_key:
                    raise InvalidSnapshotOverrides()
                if payload is None:
                    continue
                if not isinstance(payload, dict):
                    raise InvalidSnapshotOverrides()
                cleaned_inner: dict[str, str] = {}
                for sub_key, raw in payload.items():
                    if not isinstance(sub_key, str) or not sub_key:
                        raise InvalidSnapshotOverrides()
                    if section == "nutrition" and sub_key not in _OVERRIDE_NUTRITION_KEYS:
                        raise InvalidSnapshotOverrides()
                    if raw is None or raw == "":
                        continue
                    if isinstance(raw, bool):
                        raise InvalidSnapshotOverrides()
                    if isinstance(raw, (int, float)):
                        cleaned_inner[sub_key] = str(raw)
                        continue
                    if isinstance(raw, str):
                        cleaned_inner[sub_key] = raw
                        continue
                    raise InvalidSnapshotOverrides()
                if cleaned_inner:
                    cleaned_nested[outer_key] = cleaned_inner
            if cleaned_nested:
                cleaned[section] = cleaned_nested
            continue

        if section == "actives":
            cleaned_actives: dict[str, dict[str, str]] = {}
            for line_id, line_payload in inner.items():
                if not isinstance(line_id, str) or not line_id:
                    raise InvalidSnapshotOverrides()
                if line_payload is None:
                    continue
                if not isinstance(line_payload, dict):
                    raise InvalidSnapshotOverrides()
                cleaned_line: dict[str, str] = {}
                for key, raw in line_payload.items():
                    if key not in _OVERRIDE_ACTIVE_KEYS:
                        raise InvalidSnapshotOverrides()
                    if raw is None or raw == "":
                        # Empty string / null clears that field.
                        continue
                    if isinstance(raw, bool):
                        raise InvalidSnapshotOverrides()
                    if isinstance(raw, (int, float)):
                        cleaned_line[key] = str(raw)
                        continue
                    if isinstance(raw, str):
                        # Defer numeric strictness to render time —
                        # the field is free-text per the workbook
                        # convention (some products carry "TBC" or
                        # "200 (≥98% pure)" strings).
                        cleaned_line[key] = raw
                        continue
                    raise InvalidSnapshotOverrides()
                if cleaned_line:
                    cleaned_actives[line_id] = cleaned_line
            if cleaned_actives:
                cleaned[section] = cleaned_actives
            continue

        allowed_keys = _OVERRIDE_KEYS_PER_SECTION[section]
        cleaned_section: dict[str, Any] = {}
        for key, raw in inner.items():
            if key not in allowed_keys:
                raise InvalidSnapshotOverrides()
            if raw is None:
                # Explicit clear for this key.
                continue
            if section == "compliance":
                if not isinstance(raw, str):
                    raise InvalidSnapshotOverrides()
                if raw not in _OVERRIDE_COMPLIANCE_VALUES:
                    raise InvalidSnapshotOverrides()
                if raw == "":
                    continue
                cleaned_section[key] = raw
                continue
            if section == "allergens":
                if not isinstance(raw, list):
                    raise InvalidSnapshotOverrides()
                cleaned_list: list[str] = []
                for entry in raw:
                    if isinstance(entry, str):
                        trimmed = entry.strip()
                        if trimmed:
                            cleaned_list.append(trimmed)
                cleaned_section[key] = cleaned_list
                continue
            # ``formulation`` + ``declaration`` accept free-text
            # strings only — guard against arrays / dicts so a UI
            # bug cannot stash structured data here and trip the
            # template render.
            if not isinstance(raw, str):
                raise InvalidSnapshotOverrides()
            cleaned_section[key] = raw

        if cleaned_section:
            cleaned[section] = cleaned_section

    return cleaned


def _override_compliance_status(raw: str) -> bool | None:
    """Map a stored compliance override (``yes`` / ``no`` /
    ``unknown``) to the tri-state used in ``snapshot_totals.compliance``.
    Unknown overrides surface as ``None`` so the chip fades the same
    way it does for missing snapshot data."""

    if raw == "yes":
        return True
    if raw == "no":
        return False
    return None


def _apply_compliance_override(
    compliance: dict[str, Any],
    overrides: dict[str, str],
) -> dict[str, Any]:
    """Layer per-flag overrides onto the snapshot's compliance block.

    Walks ``compliance.flags`` and replaces ``status`` for any flag
    whose key is overridden. The compliant / non-compliant counts
    stay frozen — they describe the underlying ingredient breakdown,
    not the human-edited final answer.
    """

    if not overrides:
        return compliance
    flags = list(compliance.get("flags") or [])
    by_key = {flag.get("key"): flag for flag in flags if isinstance(flag, dict)}
    next_flags: list[dict[str, Any]] = []
    for flag in flags:
        if not isinstance(flag, dict):
            next_flags.append(flag)
            continue
        key = flag.get("key")
        if key in overrides:
            patched = dict(flag)
            patched["status"] = _override_compliance_status(overrides[key])
            patched["override_applied"] = True
            next_flags.append(patched)
        else:
            next_flags.append(flag)
    # Patch flags that exist in the override but were missing from
    # the snapshot — covers the "scientist marked Halal yes on a
    # snapshot that never tracked halal" edge case.
    for key, raw in overrides.items():
        if key in by_key:
            continue
        next_flags.append(
            {
                "key": key,
                "label": key.title(),
                "status": _override_compliance_status(raw),
                "compliant_count": 0,
                "non_compliant_count": 0,
                "unknown_count": 0,
                "override_applied": True,
            }
        )
    return {**compliance, "flags": next_flags}


def render_context(sheet: SpecificationSheet) -> dict[str, Any]:
    """Turn a sheet + its snapshot into the flat dict the frontend
    renders. Pure function — no DB writes, no side effects."""

    version = sheet.formulation_version
    metadata = version.snapshot_metadata or {}
    totals = version.snapshot_totals or {}
    snapshot_lines = version.snapshot_lines or []
    # Phase G5a — last-mile overrides applied at render time. The
    # validator already coerces the payload at write time so by the
    # time we reach here every key sits in the canonical schema.
    overrides = sheet.snapshot_overrides or {}
    formulation_overrides: dict[str, str] = (
        overrides.get("formulation") or {}
    )
    declaration_overrides: dict[str, str] = (
        overrides.get("declaration") or {}
    )
    allergens_overrides: dict[str, Any] = overrides.get("allergens") or {}
    compliance_overrides: dict[str, str] = overrides.get("compliance") or {}
    actives_overrides: dict[str, dict[str, str]] = (
        overrides.get("actives") or {}
    )
    excipient_mg_overrides: dict[str, str] = (
        overrides.get("excipients_mg") or {}
    )
    excipients_label_overrides: dict[str, str] = (
        overrides.get("excipients_label") or {}
    )
    capsule_shell_overrides: dict[str, str] = (
        overrides.get("capsule_shell") or {}
    )
    nutrition_overrides: dict[str, dict[str, str]] = (
        overrides.get("nutrition") or {}
    )
    amino_acids_overrides: dict[str, dict[str, str]] = (
        overrides.get("amino_acids") or {}
    )
    limits_overrides: dict[str, str] = overrides.get("limits") or {}
    metadata_overrides: dict[str, str] = overrides.get("metadata") or {}

    # The snapshot stores ``mg_per_serving`` as the raw-powder weight
    # *per unit* (per capsule / per tablet / per scoop) — the variable
    # was named when single-unit servings were the default and never
    # got renamed. For ``instantiate_active_label`` we need the
    # *per-serving* raw weight so the "From <Xmg> of 10:1 Extract"
    # label reads correctly on multi-unit servings. A product with 2
    # capsules/serving carrying 200mg of raw Maca per cap declares
    # "From 400mg of 10:1 Extract" — not the per-cap 200mg — because
    # the whole actives table is per-serving.
    serving_size = metadata.get("serving_size") or 1
    try:
        serving_multiplier = Decimal(str(serving_size))
    except (InvalidOperation, ValueError):
        serving_multiplier = Decimal("1")
    if serving_multiplier <= 0:
        serving_multiplier = Decimal("1")

    # Live ``use_as`` lookup for snapshots that pre-date adding the
    # tag to ``_SNAPSHOT_ATTRIBUTE_KEYS``. Resolves by item_id in a
    # single round-trip rather than per-line so a long actives list
    # doesn't fan out into N queries. New snapshots already carry
    # ``use_as`` in ``item_attributes`` and skip this fallback.
    line_item_ids = [
        str(line.get("item_id"))
        for line in snapshot_lines
        if line.get("item_id")
        and not (line.get("item_attributes") or {}).get("use_as")
    ]
    live_use_as_by_id: dict[str, str] = {}
    if line_item_ids:
        live_use_as_by_id = {
            str(item.id): (item.attributes or {}).get("use_as") or ""
            for item in Item.objects.filter(id__in=line_item_ids).only(
                "id", "attributes"
            )
        }

    actives = []
    for line in snapshot_lines:
        attrs = line.get("item_attributes") or {}
        # Compliance filter — the actives table is for operator-picked
        # actives only. Band-picks (excipients materialised from the
        # M2M pickers) and routing-tab manual picks (packaging,
        # semi-finished stage outputs) both persist as FormulationLine
        # rows and get snapshotted, but they aren't actives. Skip
        # them before the use_as check so a packaging item with a
        # blank ``use_as`` (packaging catalogue items don't carry
        # one) can't sneak through the "default to Active" fallback
        # below.
        source_kind = line.get("source_kind") or "active"
        if source_kind != "active":
            continue
        # Only true actives belong in the Active Ingredients table.
        # Lines tagged with a non-Active ``use_as`` (Bulking Agent,
        # Sweeteners, Acidity Regulator, etc.) flow into the EU 1169
        # declaration + Excipient Information section instead. Items
        # with an empty / missing ``use_as`` default to Active for
        # backwards compatibility with snapshots written before the
        # vocabulary was enforced -- mirrors the same fallback used
        # by ``build_ingredient_declaration``.
        raw_use_as = attrs.get("use_as") or live_use_as_by_id.get(
            str(line.get("item_id") or "")
        )
        use_as = (
            normalize_use_as_value(str(raw_use_as)) if raw_use_as else ""
        )
        if use_as and use_as != "Active":
            continue
        raw_per_unit = _coerce_decimal(line.get("mg_per_serving"))
        raw_per_serving = (
            (raw_per_unit * serving_multiplier)
            if raw_per_unit is not None
            else None
        )
        # Per-line overrides — sales tweaks "Caffeine 200mg" → "210mg"
        # for a specific client without forking the formulation. The
        # displayed name is also overrideable so a client-facing sheet
        # can rename ``Maca Extract (From 200mg of 10:1 Extract)`` to
        # something more marketing-friendly without touching the
        # catalogue. Lookup is by snapshot line ``item_id`` (the
        # version stores one line per active and the id is stable
        # across re-renders).
        line_override = actives_overrides.get(str(line.get("item_id") or ""))
        override_label_claim = (
            line_override.get("label_claim_mg") if line_override else None
        )
        override_nrv = (
            line_override.get("nrv_pct") if line_override else None
        )
        override_ingredient_name = (
            line_override.get("ingredient_list_name")
            if line_override
            else None
        )
        effective_label_claim = (
            override_label_claim
            if override_label_claim
            else (line.get("label_claim_mg") or "")
        )
        snapshot_ingredient_name = instantiate_active_label(
            nutrition_information_name=attrs.get(
                "nutrition_information_name"
            ),
            ingredient_list_name=attrs.get("ingredient_list_name"),
            item_name=line.get("item_name", ""),
            raw_mg=raw_per_serving,
        )
        actives.append(
            {
                "item_name": line.get("item_name", ""),
                "item_internal_code": line.get("item_internal_code", ""),
                # Stable identifier so the UI can target the right
                # row when patching ``snapshot_overrides.actives``.
                "item_id": str(line.get("item_id") or ""),
                "ingredient_list_name": (
                    override_ingredient_name
                    if override_ingredient_name
                    else snapshot_ingredient_name
                ),
                "ingredient_list_name_overridden": bool(
                    override_ingredient_name
                ),
                "label_claim_mg": str(effective_label_claim),
                "label_claim_overridden": bool(override_label_claim),
                # Surface the per-serving value under a per-serving
                # key so any UI that consumed the old ``mg_per_serving``
                # now reads the number that actually matches its label.
                "mg_per_serving": (
                    str(raw_per_serving) if raw_per_serving is not None else ""
                ),
                "nrv_percent": (
                    str(override_nrv)
                    if override_nrv
                    else _nrv_percent(line.get("label_claim_mg"), attrs)
                ),
                "nrv_overridden": bool(override_nrv),
            }
        )

    # Sort the active-ingredients table by ``label_claim_mg``,
    # descending — i.e. the number the customer actually reads in the
    # "Claim per Serving" column. Sorting by the raw-powder weight
    # (``mg_per_serving``) used to be the rule because it lines up
    # with the EU 1169/2011 declaration ordering below; but extracts
    # diverge wildly — a 5:1 extract with a 100 mg label claim has
    # 500 mg of raw powder, so it floats above a 200 mg caffeine row
    # and the customer reads the column as randomly ordered.
    # ``label_claim_mg`` keeps the visible column monotonic.
    # ``mg_per_serving`` survives as the tiebreaker for actives that
    # share a claim, and ``item_name`` makes the order deterministic
    # for ties on both.
    def _active_sort_key(row: dict[str, Any]) -> tuple[Decimal, Decimal, str]:
        raw_claim = _coerce_decimal(row.get("label_claim_mg")) or Decimal("0")
        raw_mg = _coerce_decimal(row.get("mg_per_serving")) or Decimal("0")
        return (-raw_claim, -raw_mg, row.get("item_name", "").lower())

    actives.sort(key=_active_sort_key)

    compliance = totals.get("compliance") or {"flags": []}
    compliance = _apply_compliance_override(compliance, compliance_overrides)
    declaration = totals.get("declaration") or {"text": "", "entries": []}
    # Apply per-row excipient mg overrides BEFORE the text-override /
    # bolding pass so a "set MCC to 0" override drops the MCC row from
    # both the joined declaration string and the per-row entries list
    # the frontend renders the excipient table from. Without this the
    # override only touched ``totals.excipients`` (the typed cells)
    # while ``declaration.entries`` stayed frozen, leading to the spec
    # sheet showing a row the override modal claimed to have killed.
    declaration_text_already_bolded = False
    if (
        excipient_mg_overrides
        or excipients_label_overrides
        or capsule_shell_overrides
    ):
        # Pass the raw snapshot ``excipients`` block (NOT the override-
        # patched payload built later) so the legacy-snapshot label
        # index reads the original carrier-row labels — which is what
        # the declaration entries on disk match against.
        rewritten = _apply_excipient_overrides_to_declaration(
            declaration,
            excipient_mg_overrides,
            excipients_payload=(totals.get("excipients") or {}) or None,
            excipients_label_overrides=excipients_label_overrides,
            capsule_shell_override=capsule_shell_overrides,
        )
        if rewritten is not declaration:
            declaration = rewritten
            # ``_format_grouped_declaration_from_entries`` already
            # html-escapes labels and wraps allergens in ``<b>``, so
            # the downstream bolding pass would double-escape. Skip it.
            declaration_text_already_bolded = True
    # Pre-split / pre-bolding snapshots stored ``declaration.text`` as
    # a plain comma-joined string with no allergen markup. We can't
    # rewrite the frozen blob, but we *can* re-render at view time
    # using the entries list (which carries ``is_allergen`` flags) so
    # the PDF + in-app view both show bolded allergens — same fix
    # without forcing every existing version to re-snapshot.
    declaration_text_override = declaration_overrides.get("text")
    if declaration_text_override is not None:
        # Manual override — render verbatim and skip the auto-bolding
        # pass so a sales-edited string is shown exactly as typed.
        # ``html.escape`` keeps any stray ``<`` safe to inject via
        # ``dangerouslySetInnerHTML`` / Django ``|safe``.
        declaration = {
            **declaration,
            "text": html.escape(declaration_text_override),
            "text_overridden": True,
        }
    elif declaration_text_already_bolded:
        # Excipient-override rebuild already produced final HTML —
        # only attach the ``text_overridden`` flag the frontend reads.
        declaration = {**declaration, "text_overridden": False}
    else:
        declaration = {
            **declaration,
            "text": _augment_declaration_with_bolding(
                declaration.get("text") or "",
                declaration.get("entries") or [],
            ),
            "text_overridden": False,
        }
    allergens = totals.get("allergens") or {"sources": [], "allergen_count": 0}
    if "sources" in allergens_overrides:
        override_sources = allergens_overrides.get("sources")
        if isinstance(override_sources, list):
            cleaned_sources = [
                s.strip()
                for s in override_sources
                if isinstance(s, str) and s.strip()
            ]
            allergens = {
                **allergens,
                "sources": cleaned_sources,
                "allergen_count": len(cleaned_sources),
                "sources_overridden": True,
            }
    nutrition = totals.get("nutrition") or {"rows": []}
    if nutrition_overrides:
        # Per-row Nutrition Information rewrites. The snapshot stores
        # the cells as ``per_100g`` / ``per_serving`` (the frontend
        # template reads those keys directly), while the override
        # modal exposes the friendlier ``amount_per_*`` aliases. Map
        # the override keys to the snapshot keys so a ``"0"`` override
        # actually shows up in the table.
        patched_rows = []
        for row in nutrition.get("rows") or []:
            if not isinstance(row, dict):
                patched_rows.append(row)
                continue
            slug = row.get("slug") or row.get("key") or ""
            override = nutrition_overrides.get(str(slug))
            if not override:
                patched_rows.append(row)
                continue
            new_row = {**row}
            override_per_100g = override.get("amount_per_100g")
            override_per_serving = override.get("amount_per_serving")
            if override_per_100g is not None and override_per_100g != "":
                new_row["per_100g"] = override_per_100g
                new_row["per_100g_overridden"] = True
            if override_per_serving is not None and override_per_serving != "":
                new_row["per_serving"] = override_per_serving
                new_row["per_serving_overridden"] = True
            patched_rows.append(new_row)
        nutrition = {**nutrition, "rows": patched_rows}

    amino_acids = totals.get("amino_acids") or {"groups": []}
    if amino_acids_overrides:
        # Amino acid blocks have a two-level shape:
        # ``groups[i].acids[j].per_serving / per_100g``. The modal
        # only exposes a single mg-per-serving cell per acid (matches
        # what the spec sheet renders), so an override value lands on
        # ``per_serving``; legacy callers that wrote ``per_100g``
        # alongside still work.
        patched_groups = []
        for group in amino_acids.get("groups") or []:
            if not isinstance(group, dict):
                patched_groups.append(group)
                continue
            group_slug = group.get("slug") or group.get("key") or ""
            group_overrides = amino_acids_overrides.get(str(group_slug)) or {}
            if not group_overrides:
                patched_groups.append(group)
                continue
            patched_acids = []
            for acid in group.get("acids") or []:
                if not isinstance(acid, dict):
                    patched_acids.append(acid)
                    continue
                acid_key = acid.get("key") or acid.get("slug") or ""
                override_value = group_overrides.get(str(acid_key))
                if override_value is None or override_value == "":
                    patched_acids.append(acid)
                    continue
                patched_acids.append(
                    {
                        **acid,
                        "per_serving": override_value,
                        "per_serving_overridden": True,
                    }
                )
            patched_groups.append({**group, "acids": patched_acids})
        amino_acids = {**amino_acids, "groups": patched_groups}

    # Phase G5a — apply per-row excipient mg overrides on top of the
    # frozen excipients dict. Keys match either the four typed cells
    # (water_mg / gummy_base_mg / mg_stearate_mg / silica_mg / mcc_mg
    # / dcp_mg) or one of the per-row slugs in ``excipients.rows``
    # (e.g. ``acidity``, ``flavouring:<id>``). Overrides only swap
    # the displayed mg + tag the cell with ``*_overridden`` so the UI
    # can badge the edit; the snapshot itself stays untouched.
    raw_excipients = totals.get("excipients") or {}
    if excipient_mg_overrides and raw_excipients:
        excipients_payload = dict(raw_excipients)
        for typed_key in (
            "water_mg",
            "gummy_base_mg",
            "mg_stearate_mg",
            "silica_mg",
            "mcc_mg",
            "dcp_mg",
        ):
            if typed_key in excipient_mg_overrides:
                excipients_payload[typed_key] = excipient_mg_overrides[
                    typed_key
                ]
                excipients_payload[f"{typed_key}_overridden"] = True
        rows_payload = list(excipients_payload.get("rows") or [])
        if rows_payload:
            patched_rows: list[dict[str, Any]] = []
            for row in rows_payload:
                if not isinstance(row, dict):
                    patched_rows.append(row)
                    continue
                slug = row.get("slug")
                if isinstance(slug, str) and slug in excipient_mg_overrides:
                    patched_rows.append(
                        {
                            **row,
                            "mg": excipient_mg_overrides[slug],
                            "mg_overridden": True,
                        }
                    )
                else:
                    patched_rows.append(row)
            excipients_payload["rows"] = patched_rows
        gummy_rows_payload = list(
            excipients_payload.get("gummy_base_rows") or []
        )
        if gummy_rows_payload:
            patched_gummy: list[dict[str, Any]] = []
            for row in gummy_rows_payload:
                if not isinstance(row, dict):
                    patched_gummy.append(row)
                    continue
                slug = f"gummy_base:{row.get('item_id', '')}"
                if slug in excipient_mg_overrides:
                    patched_gummy.append(
                        {
                            **row,
                            "mg": excipient_mg_overrides[slug],
                            "mg_overridden": True,
                        }
                    )
                else:
                    patched_gummy.append(row)
            excipients_payload["gummy_base_rows"] = patched_gummy
        excipients_for_render = excipients_payload
    else:
        excipients_for_render = raw_excipients or None

    # Filled total weight = powder fill + capsule shell (if any). For
    # tablets the filled weight is just the fill weight (no shell), and
    # for powder/gummy/liquid the snapshot's total_weight_mg already
    # equals the total active — we pass it through unchanged.
    filled_total_mg = _compute_filled_total_mg(
        dosage_form=metadata.get("dosage_form", ""),
        size_key=totals.get("size_key"),
        fill_weight_mg=totals.get("total_weight_mg"),
    )

    # Powder-only roll-ups that the workbook's FINAL spec sheet
    # surfaces on the Product Specification panel:
    #   per_serving_mg = serving_size (scoops) × total_weight_mg (per scoop)
    #   total_pack_mg  = servings_per_pack × per_serving_mg
    # Scientists paste these directly into the procurement ticket.
    powder_per_serving_mg: Decimal | None = None
    powder_pack_total_mg: Decimal | None = None
    if metadata.get("dosage_form") == DosageForm.POWDER.value:
        per_scoop_mg = _coerce_decimal(totals.get("total_weight_mg"))
        serving_size = metadata.get("serving_size") or 1
        servings_per_pack = metadata.get("servings_per_pack") or 0
        if per_scoop_mg is not None:
            try:
                scoops = Decimal(str(serving_size))
                packs = Decimal(str(servings_per_pack))
            except (InvalidOperation, ValueError):
                scoops = Decimal("1")
                packs = Decimal("0")
            powder_per_serving_mg = (per_scoop_mg * scoops).quantize(
                Decimal("0.0001")
            )
            if packs > 0:
                powder_pack_total_mg = (
                    powder_per_serving_mg * packs
                ).quantize(Decimal("0.0001"))

    # Transition history — newest first. Serialized inline rather
    # than behind a separate endpoint so the browser view and the PDF
    # render from the same payload without a second round-trip.
    history = [
        {
            "id": str(t.id),
            "from_status": t.from_status,
            "to_status": t.to_status,
            "actor_id": str(t.actor_id),
            "actor_name": (t.actor.get_full_name() or t.actor.email).strip(),
            "actor_email": t.actor.email,
            "notes": t.notes,
            "created_at": t.created_at.isoformat(),
        }
        for t in sheet.transitions.select_related("actor").all()
    ]

    return {
        "sheet": {
            "id": str(sheet.id),
            "code": sheet.code,
            "client_name": sheet.client_name,
            "client_email": sheet.client_email,
            "client_company": sheet.client_company,
            "margin_percent": (
                str(sheet.margin_percent) if sheet.margin_percent is not None else None
            ),
            "final_price": (
                str(sheet.final_price) if sheet.final_price is not None else None
            ),
            "cover_notes": sheet.cover_notes,
            "total_weight_label": (
                metadata_overrides.get("total_weight_label")
                or sheet.total_weight_label
            ),
            "unit_quantity": sheet.unit_quantity,
            # Free-text per sheet, falls back to the standing default
            # ("Packaging to be food-grade and fit for purpose.") when
            # the scientist hasn't typed a custom phrasing yet.
            "food_contact_status": (
                sheet.food_contact_status or DEFAULT_FOOD_CONTACT_STATUS
            ),
            "shelf_life": sheet.shelf_life,
            "storage_conditions": sheet.storage_conditions,
            "status": sheet.status,
            "created_at": sheet.created_at.isoformat(),
            "updated_at": sheet.updated_at.isoformat(),
            # Signals to the kiosk + authenticated viewer that this
            # sheet has a commercial proposal bundled with it. When
            # true, the kiosk renders a second tab with the proposal
            # body and the single "Accept & Sign" action advances
            # both documents together. Routed through
            # ``resolve_linked_proposal`` so multi-spec proposals
            # (where every spec after the first attaches via
            # ``ProposalLine`` rather than the legacy OneToOne) are
            # detected correctly — otherwise the kiosk would hide
            # the proposal section for every additional spec.
            "has_proposal": resolve_linked_proposal(sheet) is not None,
            # Raw override map — surfaced unmerged so the inline
            # editors on the spec sheet view know which fields are
            # currently overridden and what value to seed each input
            # with. The merged values still flow through the
            # ``formulation`` / ``declaration`` / ``allergens`` /
            # ``compliance`` / ``actives`` blocks below.
            "snapshot_overrides": dict(sheet.snapshot_overrides or {}),
        },
        "signatures": {
            "prepared_by": _resolve_internal_signature(
                sheet=sheet,
                user=sheet.prepared_by_user,
                signed_at=sheet.prepared_by_signed_at,
                image=sheet.prepared_by_signature_image,
                # Past which status does the absence of an explicit
                # prepared-by stamp justify falling back to the
                # ``updated_by`` heuristic? Anything at or past
                # in_review has implicitly been "signed by scientist".
                required_from_status=SpecificationStatus.IN_REVIEW,
            ),
            "director": _resolve_internal_signature(
                sheet=sheet,
                user=sheet.director_user,
                signed_at=sheet.director_signed_at,
                image=sheet.director_signature_image,
                required_from_status=SpecificationStatus.APPROVED,
            ),
            "customer": {
                "name": sheet.customer_name,
                "email": sheet.customer_email,
                "company": sheet.customer_company,
                "signed_at": (
                    sheet.customer_signed_at.isoformat()
                    if sheet.customer_signed_at is not None
                    else None
                ),
                "image": sheet.customer_signature_image,
            },
        },
        "formulation": {
            "id": str(version.formulation_id),
            "version_number": version.version_number,
            "version_label": version.label,
            "code": metadata.get("code", ""),
            "name": metadata.get("name", ""),
            "description": metadata.get("description", ""),
            "dosage_form": metadata.get("dosage_form", ""),
            "capsule_size": metadata.get("capsule_size", ""),
            "tablet_size": metadata.get("tablet_size", ""),
            "serving_size": metadata.get("serving_size", 1),
            "servings_per_pack": metadata.get("servings_per_pack", 0),
            # Last-mile overrides applied per-key — falls back to the
            # snapshot value when a key is not in the override map.
            "directions_of_use": formulation_overrides.get(
                "directions_of_use",
                metadata.get("directions_of_use", ""),
            ),
            "suggested_dosage": formulation_overrides.get(
                "suggested_dosage",
                metadata.get("suggested_dosage", ""),
            ),
            "appearance": formulation_overrides.get(
                "appearance",
                metadata.get("appearance", ""),
            ),
            "disintegration_spec": formulation_overrides.get(
                "disintegration_spec",
                metadata.get("disintegration_spec", ""),
            ),
            # Per-key flags so the UI can badge "Edited" cells.
            "directions_of_use_overridden": bool(
                formulation_overrides.get("directions_of_use")
            ),
            "suggested_dosage_overridden": bool(
                formulation_overrides.get("suggested_dosage")
            ),
            "appearance_overridden": bool(
                formulation_overrides.get("appearance")
            ),
            "disintegration_spec_overridden": bool(
                formulation_overrides.get("disintegration_spec")
            ),
        },
        "totals": {
            "total_active_mg": totals.get("total_active_mg"),
            "total_weight_mg": totals.get("total_weight_mg"),
            "filled_total_mg": (
                metadata_overrides.get("filled_total_mg")
                or (
                    str(filled_total_mg)
                    if filled_total_mg is not None
                    else None
                )
            ),
            "filled_total_mg_overridden": bool(
                metadata_overrides.get("filled_total_mg")
            ),
            "max_weight_mg": totals.get("max_weight_mg"),
            "size_label": totals.get("size_label"),
            "excipients": excipients_for_render,
            "viability": totals.get("viability"),
            # Powder-only fields; non-powder sheets leave them null and
            # the template suppresses the corresponding rows.
            "powder_per_serving_mg": (
                metadata_overrides.get("powder_per_serving_mg")
                or (
                    str(powder_per_serving_mg)
                    if powder_per_serving_mg is not None
                    else None
                )
            ),
            "powder_per_serving_mg_overridden": bool(
                metadata_overrides.get("powder_per_serving_mg")
            ),
            "powder_pack_total_mg": (
                metadata_overrides.get("powder_pack_total_mg")
                or (
                    str(powder_pack_total_mg)
                    if powder_pack_total_mg is not None
                    else None
                )
            ),
            "powder_pack_total_mg_overridden": bool(
                metadata_overrides.get("powder_pack_total_mg")
            ),
        },
        "actives": actives,
        "compliance": compliance,
        "declaration": declaration,
        "allergens": allergens,
        "nutrition": nutrition,
        "amino_acids": amino_acids,
        "history": history,
        "packaging": {
            # Phase 3: True when the source formulation is RTG AND has
            # packaging combos. Signals the render path to show the
            # "chosen per order — see proposal" placeholder rather than
            # the four FK slot rows (which are intentionally empty on
            # RTG SKUs since customers pick a combo per order).
            "customer_choice": (
                getattr(
                    sheet.formulation_version.formulation,
                    "project_type",
                    "",
                )
                == "ready_to_go"
                and sheet.formulation_version.formulation.packaging_combos.exists()
            ),
            "lid_description": _packaging_label(sheet.packaging_lid),
            "bottle_pouch_tub": _packaging_label(sheet.packaging_container),
            "label_size": _packaging_label(sheet.packaging_label),
            "antitemper": _packaging_label(sheet.packaging_antitemper),
            # Unit Quantity is a sheet-level override (e.g. "28
            # sachets") that falls back to the formulation's
            # ``servings_per_pack`` snapshot when left blank. Keeps
            # the workbook's semantics where the spec sheet cell is
            # editable but usually mirrors the project setup.
            "unit_quantity": (
                sheet.unit_quantity or metadata.get("servings_per_pack") or ""
            ),
            "food_contact_status": (
                sheet.food_contact_status or DEFAULT_FOOD_CONTACT_STATUS
            ),
            "shelf_life": sheet.shelf_life,
            "storage_conditions": sheet.storage_conditions,
        },
        "limits": _apply_limits_overrides(
            resolve_limits(sheet), limits_overrides
        ),
        "weight_uniformity": (
            metadata_overrides.get("weight_uniformity")
            or sheet.weight_uniformity
            or DEFAULT_WEIGHT_UNIFORMITY_PCT
        ),
        "visibility": resolve_visibility(sheet),
        "section_order": resolve_section_order(sheet),
        "watermark": show_watermark_for(sheet.document_kind),
    }


# ---------------------------------------------------------------------------
# PDF rendering (F3.1) — WeasyPrint + Django template
# ---------------------------------------------------------------------------


#: Display labels for the nutrition rows, indexed by the catalogue key.
#: Mirrors the ``nutrition_rows.*`` translations the React view uses so
#: the PDF reads identically to the browser sheet.
_NUTRITION_ROW_LABELS: dict[str, str] = {
    "energy_kj": "Energy kJ",
    "energy_kcal": "Energy kcal",
    "fat": "Fat",
    "fat_saturated": "of which saturates",
    "carbohydrate": "Carbohydrate",
    "sugar": "of which sugar",
    "fibre": "Fibre",
    "protein": "Protein",
    "salt": "Salt",
}

#: The nine-row subset the browser view renders. Excludes the
#: ``fat_monounsaturated`` / ``fat_polyunsaturated`` aggregates which
#: are captured on the raw material but not surfaced on the client
#: sheet (they live in the snapshot for completeness, not display).
_NUTRITION_ROW_ORDER: tuple[str, ...] = (
    "energy_kj",
    "energy_kcal",
    "fat",
    "fat_saturated",
    "carbohydrate",
    "sugar",
    "fibre",
    "protein",
    "salt",
)

_AMINO_GROUP_LABELS: dict[str, str] = {
    "essential": "Essential Amino Acids",
    "conditionally_essential": "Conditionally Essential Amino Acids",
    "non_essential": "Non-Essential Amino Acids",
}

_AMINO_ACID_LABELS: dict[str, str] = {
    "isoleucine": "Isoleucine",
    "leucine": "Leucine",
    "lysine": "Lysine",
    "methionine": "Methionine",
    "phenylalanine": "Phenylalanine",
    "threonine": "Threonine",
    "tryptophan": "Tryptophan",
    "valine": "Valine",
    "arginine": "Arginine",
    "cystine": "Cystine",
    "glutamic_acid": "Glutamic acid",
    "histidine": "Histidine",
    "proline": "Proline",
    "tyrosine": "Tyrosine",
    "alanine": "Alanine",
    "asparatic_acid": "Aspartic acid",
    "glycine": "Glycine",
    "serine": "Serine",
}


def _resolve_total_weight_display(context: dict[str, Any]) -> str:
    """Mirror the React view's Total Weight (mg) resolution: explicit
    override wins → computed filled weight → ``TBC``."""

    override = (context["sheet"].get("total_weight_label") or "").strip()
    if override:
        return override
    filled = context["totals"].get("filled_total_mg")
    if filled:
        try:
            return f"{Decimal(str(filled)):.2f} mg"
        except (InvalidOperation, ValueError, TypeError):
            pass
    return "TBC"


def _prepare_template_context(
    context: dict[str, Any],
    sheet: SpecificationSheet | None = None,
) -> dict[str, Any]:
    """Shape the flat ``render_context`` payload into the extra
    fields the PDF template relies on (labelled nutrition rows,
    ordered amino groups, the resolved Total Weight cell,
    organization-level header + footer metadata)."""

    # Nutrition rows — map backend keys to display labels, preserving
    # the view order. Missing rows render as zero via the template
    # filter, matching the React view's behaviour.
    rows_by_key = {row["key"]: row for row in context["nutrition"].get("rows", [])}
    nutrition_rows = [
        {
            "key": key,
            "label": _NUTRITION_ROW_LABELS[key],
            "per_serving": rows_by_key.get(key, {}).get("per_serving"),
            "per_100g": rows_by_key.get(key, {}).get("per_100g"),
            "contributors": rows_by_key.get(key, {}).get("contributors", 0),
        }
        for key in _NUTRITION_ROW_ORDER
    ]

    amino_groups = []
    for group in context["amino_acids"].get("groups", []):
        amino_groups.append(
            {
                "key": group["key"],
                "label": _AMINO_GROUP_LABELS.get(group["key"], group["key"]),
                "acids": [
                    {
                        "key": acid["key"],
                        "label": _AMINO_ACID_LABELS.get(
                            acid["key"], acid["key"].replace("_", " ").title()
                        ),
                        "per_serving": acid.get("per_serving"),
                        "per_100g": acid.get("per_100g"),
                        "contributors": acid.get("contributors", 0),
                    }
                    for acid in group.get("acids", [])
                ],
            }
        )

    nutrition_has_data = any(
        row.get("contributors", 0) > 0 for row in context["nutrition"].get("rows", [])
    ) or any(
        acid.get("contributors", 0) > 0
        for group in context["amino_acids"].get("groups", [])
        for acid in group.get("acids", [])
    )
    contributor_count = max(
        (row.get("contributors", 0) for row in context["nutrition"].get("rows", [])),
        default=0,
    )

    # Header / footer metadata. The printable sheet carries the doc
    # code top-left, the update date top-right, and the organization
    # name + generic address across the bottom. Address line is left
    # as a single string so whoever curates the template can drop in
    # a real registered address without model work — the user will
    # supply this later; today the tenant name suffices to anchor the
    # footer and avoid looking unbranded.
    organization_name = sheet.organization.name if sheet is not None else ""
    report_date = _format_report_date(context.get("sheet", {}).get("updated_at"))

    return {
        **context,
        "nutrition_rows": nutrition_rows,
        "amino_groups": amino_groups,
        "nutrition_has_data": nutrition_has_data,
        "nutrition_contributor_count": contributor_count,
        "total_weight_display": _resolve_total_weight_display(context),
        "organization_name": organization_name,
        "organization_address": "",
        "report_date": report_date,
    }


def _format_report_date(iso: Any) -> str:
    """Render the top-right date as ``DD/MM/YYYY`` — the format the
    reference spec sheet uses. Accepts the ISO string the sheet's
    ``updated_at`` carries; invalid input yields the empty string so
    the header gracefully shows nothing rather than an error token.
    """

    if not isinstance(iso, str) or not iso:
        return ""
    try:
        # ``datetime.fromisoformat`` in 3.11+ parses the trailing ``+00:00``
        # that Django emits without needing a dedicated tz-aware parser.
        from datetime import datetime

        parsed = datetime.fromisoformat(iso)
    except ValueError:
        return ""
    return parsed.strftime("%d/%m/%Y")


def render_html(sheet: SpecificationSheet) -> str:
    """Render the spec sheet to an HTML string.

    Pure preview path — same template and context the PDF renderer
    feeds to WeasyPrint, just without the PDF conversion step. Used
    by the kiosk sign flow to hash the exact document the customer
    saw before stamping the signature, so the audit trail can prove
    "the signer saw THIS version, not the one that exists now".
    """

    context = render_context(sheet)
    template_context = _prepare_template_context(context, sheet=sheet)
    return render_to_string("specifications/sheet.html", template_context)


def render_pdf(sheet: SpecificationSheet) -> tuple[bytes, str]:
    """Render the spec sheet to a PDF byte string.

    Returns ``(pdf_bytes, suggested_filename)``. The filename mirrors
    the workbook's "``<sheet-code>`` v\\ ``<version>``" convention so a
    scientist filing the PDF on disk can trace it back to the sheet +
    version without opening it.
    """

    # Lazy import so missing system libraries do not break test
    # collection for unrelated apps — WeasyPrint imports cairo/pango
    # shared libraries at module load.
    from weasyprint import HTML  # noqa: WPS433

    html_string = render_html(sheet)
    pdf_bytes = HTML(string=html_string).write_pdf()

    code = (sheet.code or str(sheet.id)[:8]).strip().replace(" ", "-")
    version_number = sheet.formulation_version.version_number
    filename = f"{code}-v{version_number}.pdf"
    return pdf_bytes, filename
