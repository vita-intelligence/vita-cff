"""Service layer for the proposals app.

Public surface:

* CRUD (``create_proposal``, ``update_proposal``, ``delete_proposal``).
* Status transitions with signature enforcement (``transition_status``).
* ``compute_material_cost_per_pack`` — pure helper rolling raw-material
  cost into a per-pack number so the UI can suggest a unit price given
  a target margin.

Views never touch the ORM directly — they call these functions, which
also emit audit rows and validate signatures.
"""

from __future__ import annotations

import re
import logging
import uuid
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import Q, QuerySet
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot

logger = logging.getLogger(__name__)
from apps.formulations.models import (
    Formulation,
    FormulationVersion,
)
from apps.organizations.models import Organization
from apps.proposals.models import (
    Proposal,
    ProposalLine,
    ProposalStatus,
    ProposalStatusTransition,
    ProposalTemplateType,
)
from apps.specifications.models import (
    SpecificationSheet,
    SpecificationStatus,
)


#: Spec-sheet statuses that mean "director has signed off." Only
#: these sheets are bindable to a proposal — draft / in_review are
#: still being iterated on; rejected proves nothing about whether a
#: director ever signed (could have been rejected before review).
_QUOTABLE_SHEET_STATUSES: frozenset[str] = frozenset(
    {
        SpecificationStatus.APPROVED,
        SpecificationStatus.SENT,
        SpecificationStatus.ACCEPTED,
    }
)


def _spec_unit_cost(sheet: "SpecificationSheet") -> Decimal | None:
    """Best-available per-unit cost for a spec sheet.

    Prefers the explicit ``unit_cost`` column the director enters
    during the new approval flow. Falls back to deriving cost from
    ``final_price`` × ``(1 − margin_percent/100)`` for legacy / hand-
    typed specs where only price + margin were captured. Returns
    ``None`` when neither path can produce a positive cost so the
    caller leaves the line column blank rather than guessing zero.
    """

    if sheet.unit_cost is not None:
        return sheet.unit_cost
    price = sheet.final_price
    margin = sheet.margin_percent
    if price is None or margin is None:
        return None
    if margin < 0 or margin >= 100:
        return None
    return (price * (Decimal("1") - margin / Decimal("100"))).quantize(
        Decimal("0.0001")
    )


def _spec_unit_price(sheet: "SpecificationSheet") -> Decimal | None:
    """Best-available per-unit customer price for a spec sheet.

    Symmetric to :func:`_spec_unit_cost`. Prefers the explicit
    ``final_price`` column the director signed; falls back to
    deriving price from ``unit_cost / (1 − margin_percent/100)``
    for specs that were priced via cost + margin only (a common
    path when sales enters cost + target margin and lets the math
    produce the customer-pays figure). Returns ``None`` when
    neither path can produce a positive price so the caller
    leaves the line column blank rather than guessing zero.

    Used by :func:`update_proposal_line` and the line-create path
    so attaching a spec auto-fills the line's ``unit_price`` even
    when the underlying spec only stored cost + margin — the prior
    "only ``spec.final_price``" branch left the price at zero on
    those specs, which made the line table's derived-margin
    column compute to nothing.
    """

    if sheet.final_price is not None:
        return sheet.final_price
    cost = sheet.unit_cost
    margin = sheet.margin_percent
    if cost is None or margin is None:
        return None
    if margin < 0 or margin >= 100:
        return None
    return (
        cost / (Decimal("1") - margin / Decimal("100"))
    ).quantize(Decimal("0.0001"))


def _resolve_quotable_sheet(
    sheet_id: Any, organization
) -> "SpecificationSheet":
    """Load a spec sheet by id, refusing it unless it lives in
    ``organization`` AND has already been director-signed.

    Centralises the two guards that every bind-a-sheet-to-a-proposal
    code path (``create_proposal``, ``update_proposal``,
    ``add_proposal_line``, ``update_proposal_line``) has to enforce
    so a stale client cannot smuggle a draft sheet into a customer-
    facing quote.
    """

    sheet = SpecificationSheet.objects.filter(id=sheet_id).first()
    if sheet is None or sheet.organization_id != organization.id:
        raise SpecificationSheetNotInOrg()
    if sheet.status not in _QUOTABLE_SHEET_STATUSES:
        raise SpecificationSheetNotApproved()
    return sheet
from config.signatures import SignatureImageInvalid, validate_signature_image


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ProposalNotFound(Exception):
    code = "proposal_not_found"


class ProposalEmailRecipientRequired(Exception):
    """Raised when ``send_proposal_to_client`` is called without a
    recipient — the proposal's ``customer_email`` is empty and no
    override was passed. Fixed by filling the customer email on the
    proposal record (or typing one into the compose modal)."""

    code = "proposal_email_recipient_required"


class ProposalEmailSendFailed(Exception):
    """Raised when the SMTP send itself fails. The status transition
    is wrapped in the same atomic block so the proposal stays at
    ``approved`` and the sales person can retry from the modal."""

    code = "proposal_email_send_failed"


class ProposalNotMutable(Exception):
    """Raised when a write targets a terminal-state proposal.

    Once a proposal reaches ``accepted`` or ``rejected`` the document
    is legally frozen: ``accepted`` is the signed contract the client
    received, ``rejected`` is the closed-loss record. Allowing further
    edits would let the database drift away from what the customer
    actually signed, invalidating the audit trail and the contract.
    """

    code = "proposal_not_mutable"


class FormulationVersionNotInOrg(Exception):
    code = "formulation_version_not_in_org"


class FormulationVersionNotApproved(Exception):
    """Raised when ``create_proposal`` is given a version other than
    the one a scientist has marked as the formulation's approved
    snapshot.

    Only the version pointed to by
    :attr:`Formulation.approved_version_number` is sellable. Earlier
    drafts and unapproved iterations stay internal — a proposal must
    price the locked recipe, not whichever version a stale client
    happened to send.
    """

    code = "formulation_version_not_approved"


class SpecificationSheetNotInOrg(Exception):
    code = "specification_sheet_not_in_org"


class SpecificationSheetNotApproved(Exception):
    """Raised when a caller tries to bind a spec sheet to a proposal
    (or proposal line) before a director has signed it.

    Only sheets that have already moved past the internal-review
    lane (``approved`` / ``sent`` / ``accepted``) are quotable; a
    ``draft`` or ``in_review`` sheet is still being iterated on
    and could change, so bundling it with a customer-facing offer
    would risk the customer seeing a sheet that doesn't match what
    they signed. Frontend filters the picker to the same set;
    this guard catches stale clients / direct API callers.
    """

    code = "specification_sheet_not_approved"


class BundleEmpty(Exception):
    """A bundle-proposal payload arrived without any spec sheets.

    Handling this defensively rather than trusting the FE to always
    guard the button — a stale client, or a direct API call from a
    script, can otherwise skate right through the create surface and
    land an empty proposal.
    """

    code = "bundle_empty"


class BundleMixedCustomers(Exception):
    """A bundle-proposal referenced sheets from >1 customer.

    The FE's picker enforces the same-customer rule interactively;
    this guard catches TOCTOU races (someone re-linked one of the
    formulations mid-submit) and direct API callers. Callers can
    fix the payload by dropping the offending sheets.
    """

    code = "bundle_mixed_customers"


class BundleRequiresLinkedCustomer(Exception):
    """Every sheet in a bundle proposal must sit on a formulation
    that already carries a ``Formulation.customer`` FK — the same
    gate spec creation and approval enforce.
    """

    code = "bundle_requires_linked_customer"


class CustomerNotInOrg(Exception):
    """Raised when a ``customer_id`` references a customer that
    belongs to a different organization. Keeps cross-tenant FK
    stitching impossible even when an attacker knows a valid id."""

    code = "customer_not_in_org"


class ProposalSalesPersonNotMember(Exception):
    """Raised when ``sales_person_id`` resolves to a user who isn't a
    member of the proposal's organization. Mirrors
    ``apps.formulations.services.SalesPersonNotMember`` so the UI can
    surface one error code regardless of which document is being
    edited."""

    code = "sales_person_not_member"


class InvalidProposalTransition(Exception):
    code = "invalid_proposal_transition"


class SignatureRequired(Exception):
    """Fired when a status transition needs a signature the caller
    didn't provide — e.g. draft → in_review without the prepared-by
    signature. Mirrors :class:`apps.specifications.services.SignatureRequired`
    so the kiosk bundle can surface a single error code."""

    code = "signature_required"


class ProposalCodeConflict(Exception):
    code = "proposal_code_conflict"


class ProposalLineNotFound(Exception):
    code = "proposal_line_not_found"


class MissingRequiredFields(Exception):
    """Raised by :func:`transition_status` when the proposal is
    missing fields the next state requires. The ``missing`` attribute
    is a list of field keys the frontend surfaces as a 'please fill'
    modal before re-submitting the transition.

    Kept structured (list of strings, not a generic validation error)
    so a single translation on the frontend covers every combination
    without hard-coding each transition's rejection copy.
    """

    code = "missing_required_fields"

    def __init__(self, missing: list[str]):
        super().__init__(f"missing required fields: {missing!r}")
        self.missing = missing


# ---------------------------------------------------------------------------
# Cost math
# ---------------------------------------------------------------------------


def _coerce_decimal(raw: Any) -> Decimal | None:
    """Tolerant decimal coercion — catalogue attributes ship as text
    and may contain ``"N/A"`` / blank / ``"#VALUE!"``. Returns None
    for every unparseable input so the caller can display ``TBC``."""

    if raw is None or raw == "":
        return None
    if isinstance(raw, bool):
        return None
    if isinstance(raw, Decimal):
        return raw
    try:
        text = str(raw).strip()
        if not text or text.upper() in {"N/A", "NA", "-", "#VALUE!"}:
            return None
        return Decimal(text)
    except (InvalidOperation, ValueError, TypeError):
        return None


def compute_material_cost_per_pack(version: FormulationVersion) -> Decimal:
    """Roll every snapshot line's raw-material cost into a per-pack total.

    Reads ``cost_price_per_kg`` (GBP) from each item's snapshotted
    attributes, multiplies by the line's ``mg_per_serving``, scales
    by ``servings_per_pack`` from the formulation metadata, and sums.

    The unit math::

        mg/serving × (cost_per_kg GBP / 1_000_000 mg/kg) × servings_per_pack
                   = GBP per pack contribution

    Missing costs contribute zero rather than blocking the sum — the
    UI flags rows with no cost so the scientist knows which catalogue
    rows still need a price. Returns ``Decimal("0")`` when the whole
    formulation has no costed ingredients.
    """

    metadata = version.snapshot_metadata or {}
    lines = version.snapshot_lines or []
    try:
        packs = int(metadata.get("servings_per_pack") or 1)
    except (TypeError, ValueError):
        packs = 1
    if packs <= 0:
        packs = 1

    total = Decimal("0")
    for line in lines:
        if not isinstance(line, dict):
            continue
        attrs = line.get("item_attributes") or {}
        cost_per_kg = _coerce_decimal(attrs.get("cost_price_per_kg"))
        if cost_per_kg is None or cost_per_kg <= 0:
            continue
        mg_per_serving = _coerce_decimal(line.get("mg_per_serving"))
        if mg_per_serving is None or mg_per_serving <= 0:
            continue
        # mg × cost_per_kg ÷ 1_000_000 = GBP per serving
        per_serving = (mg_per_serving * cost_per_kg) / Decimal(1_000_000)
        total += per_serving * Decimal(packs)
    return total.quantize(Decimal("0.0001"))


def suggest_unit_price(
    material_cost: Decimal,
    margin_percent: Decimal | None,
) -> Decimal:
    """Apply the target gross margin to a material cost.

    Formula: ``cost / (1 − margin/100)``. A 30% gross margin on £5
    of cost returns ``5 / 0.7 ≈ £7.14`` — the price at which 30% of
    every sale lands as profit. Markup-on-cost (the other reading of
    "margin") would give ``£6.50`` instead; we picked gross margin
    because that's how sales reports and finance dashboards talk
    about profitability.

    Edge cases:
    * Margin ≥ 100 → price is mathematically infinite. We cap at the
      raw cost and leave the scientist to fix the number; better to
      quote at-cost than to emit ``inf``.
    * Missing / negative margin → return the raw cost; the picker
      shows a warning chip when the derivation failed.
    """

    if material_cost <= 0:
        return Decimal("0.0000")
    pct = margin_percent if margin_percent is not None else Decimal("0")
    if pct < 0:
        pct = Decimal("0")
    if pct >= Decimal("100"):
        return material_cost.quantize(Decimal("0.0001"))
    divisor = Decimal("1") - (pct / Decimal("100"))
    return (material_cost / divisor).quantize(Decimal("0.0001"))


# ---------------------------------------------------------------------------
# Code generation
# ---------------------------------------------------------------------------


_CODE_PREFIX = "PROP"
_CODE_RE = re.compile(rf"^{_CODE_PREFIX}-(\d+)$")


def _generate_unique_code(organization: Organization) -> str:
    """Return the next ``PROP-NNNN`` code for this organization.

    Scans existing codes that match the canonical pattern, takes the
    highest numeric suffix, and adds one. Padded to four digits for
    alignment; re-expands naturally beyond 9 999. Manual overrides
    (e.g. a sales person hand-typing ``Q2-SPECIAL-01``) are ignored
    by the scanner, so they don't skew the counter.
    """

    existing = (
        Proposal.objects.filter(organization=organization)
        .exclude(code="")
        .values_list("code", flat=True)
    )
    highest = 0
    for code in existing:
        match = _CODE_RE.match(code)
        if match is not None:
            highest = max(highest, int(match.group(1)))
    return f"{_CODE_PREFIX}-{highest + 1:04d}"


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def list_proposals(
    *,
    organization: Organization,
    formulation_id: Any = None,
    status: str | None = None,
    search: str | None = None,
    statuses: list[str] | None = None,
    sales_person_id: Any = None,
    valid_until_from: Any = None,
    valid_until_to: Any = None,
    template_type: str | None = None,
) -> QuerySet[Proposal]:
    """Return the org's proposals, newest first.

    ``formulation_id`` scopes down to one project's proposals so the
    project workspace's panel can render without a second query.
    ``status`` (single-value, e.g. ``"in_review"``) is kept for the
    director's approval inbox which only ever asks for one lifecycle
    state. ``statuses`` (plural) is the multi-select replacement
    used by the org-wide list filter bar.

    ``search`` matches case-insensitively against the proposal code,
    customer_name, and customer_company.

    ``sales_person_id`` filters by the assigned commercial owner.
    The special string ``"unassigned"`` surfaces rows with no
    sales person.

    ``valid_until_from`` / ``valid_until_to`` are inclusive date
    bounds on the proposal expiry — sales hunts proposals about to
    lapse via this filter. Either bound may be ``None`` to leave
    that side open.
    """

    queryset = Proposal.objects.filter(organization=organization)
    if formulation_id is not None:
        # Traverse ``lines`` so a bundled proposal built from N specs
        # shows up on ALL N projects' Proposals tabs, not just the
        # one that happened to be the first line (that first line
        # sets the Proposal's own ``formulation_version`` FK, but
        # every other spec belongs to a different project). Distinct
        # collapses the row-per-matching-line the join would emit.
        queryset = queryset.filter(
            Q(formulation_version__formulation_id=formulation_id)
            | Q(lines__formulation_version__formulation_id=formulation_id)
        ).distinct()
    if status:
        queryset = queryset.filter(status=status)
    if statuses:
        cleaned = [s.strip() for s in statuses if s and s.strip()]
        if cleaned:
            queryset = queryset.filter(status__in=cleaned)
    if search:
        needle = search.strip()
        if needle:
            queryset = queryset.filter(
                Q(code__icontains=needle)
                | Q(customer_name__icontains=needle)
                | Q(customer_company__icontains=needle)
            )
    if sales_person_id:
        if str(sales_person_id).strip().lower() == "unassigned":
            queryset = queryset.filter(sales_person__isnull=True)
        else:
            queryset = queryset.filter(sales_person_id=sales_person_id)
    if valid_until_from is not None:
        queryset = queryset.filter(valid_until__gte=valid_until_from)
    if valid_until_to is not None:
        queryset = queryset.filter(valid_until__lte=valid_until_to)
    # ``template_type`` splits the org list between manually authored
    # proposals (``custom``) and the auto-drafted RTG orders that
    # come out of the customer portal's Ready-to-Go flow
    # (``ready_to_go``). Unknown values fall through as no-ops so a
    # bogus query param never 500s the list.
    if template_type:
        cleaned = template_type.strip()
        if cleaned in {"custom", "ready_to_go"}:
            queryset = queryset.filter(template_type=cleaned)
    return queryset.select_related(
        "formulation_version__formulation",
        "formulation_version__formulation__sales_person",
        "specification_sheet",
        "created_by",
        # The read serializer's ``get_sales_person_name`` /
        # ``get_prepared_by`` / ``get_director`` all dereference these
        # FKs; without ``select_related`` each row fires a follow-up
        # query (3 × N for a 50-item page = 150 extra round-trips).
        "sales_person",
        "prepared_by_user",
        "director_user",
    ).prefetch_related(
        # ``Proposal.subtotal`` / ``Proposal.total_excl_vat`` (both
        # exposed by every list + detail serializer) iterate
        # ``self.lines.all()``. Without this prefetch each row in a
        # 50-item page fires its own lines query — classic N+1. One
        # extra batched IN-query for the whole page is dramatically
        # cheaper, and the list endpoint also reads ``len(obj.lines.
        # all())`` from this same cache to populate ``lines_count``.
        "lines",
    ).order_by("-updated_at")


def get_proposal(
    *, organization: Organization, proposal_id: Any
) -> Proposal:
    proposal = (
        Proposal.objects.select_related(
            "formulation_version__formulation",
            "specification_sheet",
            "created_by",
            "updated_by",
        )
        .filter(organization=organization, id=proposal_id)
        .first()
    )
    if proposal is None:
        raise ProposalNotFound()
    return proposal


@transaction.atomic
def _schedule_proposal_psp_merge(proposal: Proposal) -> None:
    """Fire the PSP merge sync on the outer transaction's commit.

    Deferred to ``on_commit`` so:

    * A rollback anywhere in the create path (audit failure,
      backfill failure, …) DOESN'T leak a PSP-side merge for a
      proposal that didn't actually save.
    * The caller's atomic block only ever holds DB locks — network
      I/O to PSP happens after ``COMMIT``, so a slow PSP can never
      block the transaction.

    Silent-degrade — any exception from the PSP client is caught and
    logged; a failed sync must never break proposal creation for the
    operator. PSP is idempotent by ``npd_proposal_uuid`` so retries
    (from a future re-run or manual trigger) land cleanly.
    """

    def _fire() -> None:
        from apps.psp.services import sync_proposal_to_psp

        try:
            sync_proposal_to_psp(proposal=proposal)
        except Exception:  # noqa: BLE001 — deliberate belt-and-braces
            logger.exception(
                "PSP proposal merge sync failed for proposal %s",
                proposal.pk,
            )

    transaction.on_commit(_fire)


@transaction.atomic
def _schedule_proposal_psp_unmerge(
    *, organization: Organization, proposal_uuid: str
) -> None:
    """Reverse the PSP merge on the outer transaction's commit.

    Mirrors :func:`_schedule_proposal_psp_merge` but for the delete
    path. Captures ``organization`` + ``proposal_uuid`` at call time
    because the Proposal row is gone by the time ``on_commit`` fires.

    Silent-degrade — a failed unmerge must never break Proposal
    deletion for the operator. PSP is idempotent on
    ``proposal_uuid`` so a retry (from a future re-run) lands
    cleanly, and a genuinely-missing primary responds ``no_op:
    true`` rather than erroring.
    """

    def _fire() -> None:
        from apps.psp.services import unsync_proposal_from_psp

        try:
            unsync_proposal_from_psp(
                organization=organization, proposal_uuid=proposal_uuid
            )
        except Exception:  # noqa: BLE001 — deliberate belt-and-braces
            logger.exception(
                "PSP proposal unmerge sync failed for proposal %s",
                proposal_uuid,
            )

    transaction.on_commit(_fire)


def create_proposal(
    *,
    organization: Organization,
    actor: Any,
    formulation_version_id: Any,
    template_type: str | None = None,
    specification_sheet_id: Any = None,
    customer_id: Any = None,
    code: str = "",
    customer_name: str = "",
    customer_email: str = "",
    customer_phone: str = "",
    customer_company: str = "",
    invoice_address: str = "",
    delivery_address: str = "",
    dear_name: str = "",
    reference: str = "",
    currency: str = "GBP",
    quantity: int = 1,
    unit_price: Decimal | None = None,
    freight_amount: Decimal | None = None,
    margin_percent: Decimal | None = None,
    deposit_percent: Decimal | None = None,
    material_cost_per_pack: Decimal | None = None,
    cover_notes: str = "",
    valid_until: Any = None,
    defer_psp_sync: bool = False,
) -> Proposal:
    """Plan a new proposal against a saved formulation version.

    Set ``defer_psp_sync=True`` when :func:`create_proposal_bundle` is
    the outer caller — the bundle fires ONE merge sync after every
    line has landed rather than firing per-``create_proposal`` +
    once-per-``add_proposal_line``.

    * ``formulation_version_id`` must live in the caller's org.
    * ``specification_sheet_id`` (optional) must also be scoped.
      When set, the kiosk page renders both documents together.
    * ``template_type`` defaults to the formulation's ``project_type``
      so scientists don't have to pick it twice.
    * ``unit_price`` is auto-suggested from material cost × margin
      when omitted so the first render never reads as ``TBC``.
    * ``valid_until`` defaults to today + 14 days — matches the
      workbook template's "offer valid for 14 days" footer.
    """

    version = (
        FormulationVersion.objects.select_related("formulation")
        .filter(id=formulation_version_id)
        .first()
    )
    if version is None or version.formulation.organization_id != organization.id:
        raise FormulationVersionNotInOrg()
    # Project status no longer gates proposal creation: the customer
    # pipeline runs in parallel with the roadmap chip, so a quote
    # can leave the building while the project is still
    # ``in_development`` or ``pilot``. The version pointer
    # (``approved_version_number``) is now wired automatically when a
    # spec sheet reaches ``status=approved`` — see
    # :func:`apps.specifications.services.transition_status` — so the
    # gate below is effectively "has a sheet been director-signed
    # yet?" rather than a separate scientist action.
    #
    # ``!=`` also catches the "no approved version yet" case because
    # Python ints never equal ``None``.
    if version.version_number != version.formulation.approved_version_number:
        raise FormulationVersionNotApproved()

    sheet: SpecificationSheet | None = None
    if specification_sheet_id is not None:
        sheet = _resolve_quotable_sheet(specification_sheet_id, organization)

    # Pull the customer address-book entry if one was picked. Seed
    # any blank customer_* fields on the proposal from the linked
    # customer so the template renders real values on create, while
    # leaving caller-provided overrides intact.
    from apps.customers.models import Customer

    customer = None
    if customer_id is not None:
        customer = Customer.objects.filter(id=customer_id).first()
        if customer is None or customer.organization_id != organization.id:
            raise CustomerNotInOrg()
        customer_name = customer_name or customer.name
        customer_email = customer_email or customer.email
        customer_phone = customer_phone or customer.phone
        customer_company = customer_company or customer.company
        invoice_address = invoice_address or customer.invoice_address
        delivery_address = delivery_address or customer.delivery_address
        dear_name = dear_name or customer.name

    chosen_template = (
        template_type
        if template_type in {t.value for t in ProposalTemplateType}
        else version.formulation.project_type
    )

    if code:
        dupe = Proposal.objects.filter(organization=organization, code=code).exists()
        if dupe:
            code = _generate_unique_code(organization)
    else:
        code = _generate_unique_code(organization)

    # Unit cost: prefer the scientist's typed value (they know the
    # real cost better than the catalogue — labour, overheads, and
    # packaging aren't captured in raw-material attributes). Fall back
    # to the auto roll-up from raw materials only when no value is
    # supplied. The auto number is still useful on first render.
    if material_cost_per_pack is not None:
        material_cost = material_cost_per_pack
    else:
        material_cost = compute_material_cost_per_pack(version)
    # Auto-fill from the picked spec when the caller didn't supply
    # pricing — the spec is the new "single source of truth" the
    # team agreed on. Caller's explicit values still win so a
    # negotiated rate can override the spec default.
    if sheet is not None:
        if unit_price is None:
            derived_price = _spec_unit_price(sheet)
            if derived_price is not None:
                unit_price = derived_price
        if margin_percent is None and sheet.margin_percent is not None:
            margin_percent = sheet.margin_percent
        # Cost: prefer the spec's signed cost; fall back to deriving
        # from price + margin for legacy specs that only stored the
        # price. Only overrides the auto-roll-up — caller's typed
        # ``material_cost_per_pack`` still wins via the branch above.
        if material_cost_per_pack is None:
            derived_cost = _spec_unit_cost(sheet)
            if derived_cost is not None:
                material_cost = derived_cost
        # Spec currency seeds the proposal currency unless the caller
        # explicitly chose a different one. ``currency`` defaults to
        # ``"GBP"``; treat that default as "unspecified" so a spec
        # priced in EUR / USD takes precedence.
        spec_currency = (sheet.currency or "").strip().upper()
        if (
            spec_currency
            and spec_currency != "GBP"
            and (currency or "").strip().upper() == "GBP"
        ):
            currency = spec_currency
        # Quantity is a per-order figure the sales rep sets on the
        # proposal, not part of the signed per-unit economics on the
        # spec. We deliberately do *not* inherit ``sheet.quantity``
        # — one spec can underpin proposals at very different
        # volumes, and the customer always signs against the value
        # on the proposal.
    if unit_price is None:
        unit_price = suggest_unit_price(material_cost, margin_percent)

    if valid_until is None:
        valid_until = (timezone.now().date() + timedelta(days=14))

    # Sync back to the parent formulation when the sales rep picked a
    # template that disagrees with the formulation's current
    # project_type — the two are supposed to travel together, and the
    # workflow's roadmap (trial batch vs skip-to-payment) reads from
    # formulation.project_type. Without this, picking "Ready to Go" on
    # the proposal form only changes which .docx renders — the rest of
    # the pipeline still runs the Custom trial-batch loop.
    if (
        chosen_template
        and chosen_template != version.formulation.project_type
    ):
        version.formulation.project_type = chosen_template
        version.formulation.updated_by = actor
        version.formulation.save(
            update_fields=["project_type", "updated_by", "updated_at"]
        )

    # Ready-to-Go recipes are evergreen — the same spec sheet ships to
    # many customers and the same customer can re-order under separate
    # proposals. Setting the top-level ``Proposal.specification_sheet``
    # OneToOne locks the spec to one deal and blocks every subsequent
    # RTG sale with a UNIQUE-constraint 500. For RTG we skip the
    # OneToOne slot entirely and rely on the per-line FK below (still
    # written unconditionally); ``resolve_linked_proposal`` and
    # ``_attached_spec_sheets`` both walk the line-level path so
    # nothing downstream cares that the legacy slot is NULL.
    # Custom projects keep the OneToOne for schema-level
    # backward compatibility.
    should_pin_legacy_slot = (
        sheet is not None
        and getattr(version.formulation, "project_type", "custom")
        != "ready_to_go"
    )

    # A Custom sheet can only hold ONE proposal in the legacy OneToOne
    # slot at a time (schema-level uniqueness). When the prior proposal
    # for this sheet has died (rejected) or was signed (accepted), it's
    # legally a closed record — but its OneToOne link still occupies
    # the slot and would cause a UNIQUE-constraint 500 on the new
    # ``Proposal.objects.create`` below. Free the slot up so a fresh
    # quote can be raised. The old proposal keeps its ProposalLine FK
    # references to the sheet (that's the durable audit trail — every
    # line row records "this sheet was on that dead deal"), just not
    # the OneToOne header link.
    if should_pin_legacy_slot:
        existing = getattr(sheet, "proposal", None)
        if existing is not None and existing.status in (
            ProposalStatus.REJECTED.value,
            ProposalStatus.ACCEPTED.value,
        ):
            existing.specification_sheet = None
            existing.save(update_fields=["specification_sheet", "updated_at"])

    proposal = Proposal.objects.create(
        organization=organization,
        formulation_version=version,
        specification_sheet=sheet if should_pin_legacy_slot else None,
        customer=customer,
        code=code,
        template_type=chosen_template,
        status=ProposalStatus.DRAFT,
        customer_name=customer_name,
        customer_email=customer_email,
        customer_phone=customer_phone,
        customer_company=customer_company,
        invoice_address=invoice_address,
        delivery_address=delivery_address,
        dear_name=dear_name or customer_name,
        reference=reference or code,
        currency=currency,
        quantity=max(1, quantity),
        unit_price=unit_price,
        freight_amount=freight_amount,
        material_cost_per_pack=material_cost,
        margin_percent=margin_percent,
        **(
            {"deposit_percent": deposit_percent}
            if deposit_percent is not None
            else {}
        ),
        cover_notes=cover_notes,
        valid_until=valid_until,
        created_by=actor,
        updated_by=actor,
    )
    # Seed a default line from the version so the "Products on this
    # proposal" panel shows the product the scientist just picked,
    # the rendered PDF renders via the real multi-line code path (not
    # the legacy single-product fallback), and the missing-required
    # fields check ("at least one priced line") passes. Additional
    # products are added via the detail-page panel.
    ProposalLine.objects.create(
        proposal=proposal,
        formulation_version=version,
        specification_sheet=sheet,
        product_code=(
            (version.snapshot_metadata or {}).get("code")
            or version.formulation.code
            or ""
        ),
        description=(
            (version.snapshot_metadata or {}).get("name")
            or version.formulation.name
            or ""
        ),
        quantity=max(1, quantity),
        unit_cost=material_cost if material_cost and material_cost > 0 else None,
        unit_price=unit_price,
        display_order=0,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="proposal.create",
        target=proposal,
        after=snapshot(proposal),
    )

    # Back-fill the customer record's missing contact fields from
    # whatever the operator typed on the proposal (or seeded from
    # Dynamics through the create form). If the address book row
    # had a blank email / phone / invoice / delivery, copy the
    # proposal's value in so downstream surfaces (portal invites,
    # password reset, future proposals' auto-seed) all see one
    # complete record. Never overwrites a non-empty field — the
    # address book stays authoritative once set.
    _backfill_customer_from_proposal(proposal=proposal, actor=actor)

    if not defer_psp_sync:
        _schedule_proposal_psp_merge(proposal)

    return proposal


@transaction.atomic
def create_proposal_bundle(
    *,
    organization: Organization,
    actor: Any,
    sheet_specs: list[dict[str, Any]],
    deposit_percent: Decimal | None = None,
) -> Proposal:
    """One proposal, N specification sheets — the /signed bulk flow.

    ``sheet_specs`` is a list of ``{"sheet_id": uuid, "quantity": int}``
    entries. The first sheet is the "primary" — used to seed the
    proposal's currency, template type, customer identity, and
    pricing defaults. Every subsequent sheet becomes its own
    :class:`ProposalLine` via :func:`add_proposal_line`.

    Hard invariants (enforced before ANY row is written so a
    failure never leaves a half-created proposal):

      * At least one sheet.
      * Every sheet's formulation carries a linked
        ``Formulation.customer`` FK.
      * Every sheet's linked customer is the same.

    On success returns the fully-built :class:`Proposal`. Callers
    can inspect ``.lines.all()`` for the resulting line rows.
    """

    if not sheet_specs:
        raise BundleEmpty()

    # Resolve every sheet up-front so we can validate as a set before
    # any writes. Order-preserving so ``sheet_specs[0]`` stays primary.
    from apps.specifications.models import SpecificationSheet

    resolved: list[tuple[SpecificationSheet, int]] = []
    customer_ids: set[Any] = set()
    for entry in sheet_specs:
        sheet_id = entry.get("sheet_id") or entry.get("specification_sheet_id")
        raw_qty = entry.get("quantity", 1)
        try:
            qty = max(1, int(raw_qty))
        except (TypeError, ValueError):
            qty = 1

        sheet = _resolve_quotable_sheet(sheet_id, organization)
        # ``_resolve_quotable_sheet`` guards approval + org scope; we
        # still need the customer gate.
        formulation = sheet.formulation_version.formulation
        if formulation.customer_id is None:
            raise BundleRequiresLinkedCustomer()
        customer_ids.add(formulation.customer_id)
        resolved.append((sheet, qty))

    if len(customer_ids) > 1:
        raise BundleMixedCustomers()

    # Bootstrap the proposal against the first spec. All the seeding
    # behaviour (customer contact fields, pricing, currency, template
    # type) already lives in ``create_proposal`` — reusing it keeps
    # the two surfaces behaviourally identical.
    primary_sheet, primary_qty = resolved[0]
    primary_customer_id = primary_sheet.formulation_version.formulation.customer_id

    proposal = create_proposal(
        organization=organization,
        actor=actor,
        formulation_version_id=primary_sheet.formulation_version_id,
        specification_sheet_id=primary_sheet.id,
        customer_id=primary_customer_id,
        template_type="custom",
        quantity=primary_qty,
        deposit_percent=deposit_percent,
        # Suppress the inner PSP sync — we fire ONE at the end of the
        # bundle with every ProposalLine attached, so PSP sees the
        # full merge set in one round-trip.
        defer_psp_sync=True,
    )

    # Append every remaining sheet as its own line. ``add_proposal_line``
    # snapshots the formulation code + name and seeds pricing from the
    # spec, so lines land render-ready without extra bookkeeping here.
    for sheet, qty in resolved[1:]:
        add_proposal_line(
            proposal=proposal,
            actor=actor,
            formulation_version_id=sheet.formulation_version_id,
            specification_sheet_id=sheet.id,
            quantity=qty,
        )

    _schedule_proposal_psp_merge(proposal)

    return proposal


#: Every field an update request is allowed to touch. Kept explicit
#: so a stray kwarg never silently overwrites a signature / token /
#: audit column.
_UPDATABLE_FIELDS: tuple[str, ...] = (
    "customer_name",
    "customer_email",
    "customer_phone",
    "customer_company",
    "invoice_address",
    "delivery_address",
    "dear_name",
    "reference",
    "currency",
    "quantity",
    "unit_price",
    "freight_amount",
    "margin_percent",
    "deposit_percent",
    "material_cost_per_pack",
    "cover_notes",
    "valid_until",
    "template_type",
)


@transaction.atomic
def update_proposal(
    *, proposal: Proposal, actor: Any, **changes: Any
) -> Proposal:
    _guard_mutable(proposal)
    before = snapshot(proposal)

    # ``specification_sheet_id`` / ``customer_id`` are FKs, not free
    # fields. Pop them off ``changes`` so the flat-loop below doesn't
    # try to setattr them as strings. ``None`` detaches the link.
    if "specification_sheet_id" in changes:
        sheet_id = changes.pop("specification_sheet_id")
        if sheet_id is None:
            proposal.specification_sheet = None
        else:
            proposal.specification_sheet = _resolve_quotable_sheet(
                sheet_id, proposal.organization
            )
    if "customer_id" in changes:
        from apps.customers.models import Customer

        customer_id = changes.pop("customer_id")
        if customer_id is None:
            proposal.customer = None
        else:
            customer = Customer.objects.filter(id=customer_id).first()
            if (
                customer is None
                or customer.organization_id != proposal.organization_id
            ):
                raise CustomerNotInOrg()
            proposal.customer = customer
    if "sales_person_id" in changes:
        # Same safety net as ``customer_id`` — validate membership
        # before writing so a crafted UUID from another tenant can't
        # plant a foreign user on the proposal. ``None`` clears.
        from apps.organizations.models import Membership
        from django.contrib.auth import get_user_model

        sales_person_id = changes.pop("sales_person_id")
        if sales_person_id is None:
            proposal.sales_person = None
        else:
            User = get_user_model()
            sales_person = User.objects.filter(id=sales_person_id).first()
            if sales_person is None or not Membership.objects.filter(
                user=sales_person, organization=proposal.organization
            ).exists():
                raise ProposalSalesPersonNotMember()
            proposal.sales_person = sales_person

    for key, value in changes.items():
        if key in _UPDATABLE_FIELDS and value is not None:
            setattr(proposal, key, value)

    # Re-suggest unit price if margin changed but unit price didn't
    # — keeps the number in sync with whatever the scientist typed.
    if (
        "margin_percent" in changes
        and "unit_price" not in changes
        and proposal.material_cost_per_pack is not None
    ):
        proposal.unit_price = suggest_unit_price(
            proposal.material_cost_per_pack, proposal.margin_percent
        )

    proposal.updated_by = actor
    proposal.save()
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal.update",
        target=proposal,
        before=before,
        after=snapshot(proposal),
    )
    return proposal


@transaction.atomic
def delete_proposal(*, proposal: Proposal, actor: Any) -> None:
    _guard_mutable(proposal)
    before = snapshot(proposal)
    target_id = str(proposal.pk)
    organization = proposal.organization
    proposal.delete()
    # ``target`` must be passed explicitly as keyword even when the
    # row has been deleted; the audit service derives the string id
    # from ``target_id`` when the model instance is ``None``.
    record_audit(
        organization=organization,
        actor=actor,
        action="proposal.delete",
        target=None,
        target_type="proposal",
        target_id=target_id,
        before=before,
    )
    # Reverse the PSP-side merge so the N R&D drafts that got folded
    # into one primary reappear as individual orders — chat history
    # follows the comments back to their home CO.
    _schedule_proposal_psp_unmerge(
        organization=organization, proposal_uuid=target_id
    )


# ---------------------------------------------------------------------------
# Status transitions
# ---------------------------------------------------------------------------


#: Legal (from → to) edges. Matches the spec sheet's state machine
#: so the bundled signing flow on the kiosk advances both documents
#: together without bespoke per-document rules.
_LEGAL_TRANSITIONS: dict[str, frozenset[str]] = {
    ProposalStatus.DRAFT.value: frozenset(
        {ProposalStatus.IN_REVIEW.value, ProposalStatus.REJECTED.value}
    ),
    ProposalStatus.IN_REVIEW.value: frozenset(
        {
            ProposalStatus.APPROVED.value,
            ProposalStatus.DRAFT.value,
            ProposalStatus.REJECTED.value,
        }
    ),
    ProposalStatus.APPROVED.value: frozenset(
        {ProposalStatus.SENT.value, ProposalStatus.REJECTED.value}
    ),
    ProposalStatus.SENT.value: frozenset(
        {ProposalStatus.ACCEPTED.value, ProposalStatus.REJECTED.value}
    ),
    ProposalStatus.ACCEPTED.value: frozenset(),
    ProposalStatus.REJECTED.value: frozenset(),
}


#: States that freeze the proposal — no edits, no line CRUD, no
#: deletion. Once a director has approved the proposal the offer
#: is locked: any further mutation would invalidate the
#: prepared-by + director signature evidence and (if it's reached
#: ``sent``) potentially diverge from what the customer is reading
#: on the kiosk. The two terminal states (``accepted`` /
#: ``rejected``) are included for the same reason — the audit
#: trail of "what the customer agreed to / declined" must match
#: the document.
#:
#: Only ``draft`` and ``in_review`` remain editable.
_LOCKED_STATES: frozenset[str] = frozenset(
    {
        ProposalStatus.APPROVED.value,
        ProposalStatus.SENT.value,
        ProposalStatus.ACCEPTED.value,
        ProposalStatus.REJECTED.value,
    }
)


def _guard_mutable(proposal: Proposal) -> None:
    if proposal.status in _LOCKED_STATES:
        raise ProposalNotMutable()


@dataclass
class _SignatureSlot:
    """Which signature slot a transition writes into, if any.

    Mirrors the spec sheet's convention — ``draft → in_review``
    stamps ``prepared_by``, ``in_review → approved`` stamps
    ``director``, ``sent → accepted`` stamps ``customer``.
    """

    user_field: str | None
    signed_at_field: str
    image_field: str


_TRANSITION_SIGNATURE_SLOT: dict[tuple[str, str], _SignatureSlot] = {
    (ProposalStatus.DRAFT.value, ProposalStatus.IN_REVIEW.value): _SignatureSlot(
        user_field="prepared_by_user",
        signed_at_field="prepared_by_signed_at",
        image_field="prepared_by_signature_image",
    ),
    (ProposalStatus.IN_REVIEW.value, ProposalStatus.APPROVED.value): _SignatureSlot(
        user_field="director_user",
        signed_at_field="director_signed_at",
        image_field="director_signature_image",
    ),
    (ProposalStatus.SENT.value, ProposalStatus.ACCEPTED.value): _SignatureSlot(
        user_field=None,  # customer is not a platform user
        signed_at_field="customer_signed_at",
        image_field="customer_signature_image",
    ),
}


# ---------------------------------------------------------------------------
# Line CRUD
# ---------------------------------------------------------------------------


@transaction.atomic
def add_proposal_line(
    *,
    proposal: Proposal,
    actor: Any,
    formulation_version_id: Any | None = None,
    specification_sheet_id: Any | None = None,
    product_code: str = "",
    description: str = "",
    quantity: int = 1,
    unit_cost: Decimal | None = None,
    unit_price: Decimal | None = None,
    display_order: int | None = None,
) -> ProposalLine:
    """Attach a new product line to ``proposal``.

    When ``formulation_version_id`` is supplied we resolve it + verify
    it belongs to the proposal's organization, then snapshot the
    formulation's code and name onto the line. The scientist can
    override both with their own free-text values for proposals that
    quote an ad-hoc SKU (e.g. ``"Shipping crate"``).
    """

    _guard_mutable(proposal)

    from apps.formulations.models import FormulationVersion

    version = None
    if formulation_version_id is not None:
        version = (
            FormulationVersion.objects.select_related("formulation")
            .filter(id=formulation_version_id)
            .first()
        )
        if (
            version is None
            or version.formulation.organization_id != proposal.organization_id
        ):
            raise FormulationVersionNotInOrg()
        # Mirror the ``create_proposal`` gate: a line can only be
        # added against the version a scientist (or a director-
        # approved spec sheet) has marked as the formulation's
        # current approved snapshot. Otherwise the proposal could
        # quote a draft / un-finalised recipe even after the initial
        # create surface filtered correctly.
        if version.version_number != version.formulation.approved_version_number:
            raise FormulationVersionNotApproved()
        metadata = version.snapshot_metadata or {}
        if not product_code:
            product_code = (
                metadata.get("code") or version.formulation.code or ""
            )
        if not description:
            description = (
                metadata.get("name") or version.formulation.name or ""
            )

    sheet = None
    if specification_sheet_id is not None:
        sheet = _resolve_quotable_sheet(
            specification_sheet_id, proposal.organization
        )

    if display_order is None:
        display_order = proposal.lines.count()

    # Auto-fill pricing from the picked spec when the caller didn't
    # provide their own. The spec carries a director-approved price
    # (set during the approval flow); seeding the proposal line from
    # it means sales doesn't retype the same numbers on every quote.
    # Caller-provided values still win — sales can negotiate a
    # custom rate by passing ``unit_cost`` / ``unit_price``
    # explicitly, and the line column owns the source of truth from
    # that point onward.
    seeded_qty = quantity
    if sheet is not None:
        if unit_cost is None:
            derived_cost = _spec_unit_cost(sheet)
            if derived_cost is not None:
                unit_cost = derived_cost
        if unit_price is None:
            derived_price = _spec_unit_price(sheet)
            if derived_price is not None:
                unit_price = derived_price
        # Quantity is intentionally NOT inherited from the spec — it's
        # a per-order figure the sales rep sets on the proposal line,
        # not part of the signed per-unit economics. One spec can
        # underpin lines at very different volumes.
        # Inherit the spec's currency when the proposal is still on
        # the default GBP. Proposals are single-currency by design,
        # so the first non-default spec currency wins; later
        # additions of differently-priced specs keep the original
        # proposal currency (and the line stores prices verbatim,
        # which is a flag for the team to reprice if needed).
        spec_currency = (sheet.currency or "").strip().upper()
        if (
            spec_currency
            and spec_currency != "GBP"
            and (proposal.currency or "").strip().upper() == "GBP"
            and proposal.lines.count() == 0
        ):
            proposal.currency = spec_currency
            proposal.save(update_fields=["currency", "updated_at"])

    line = ProposalLine.objects.create(
        proposal=proposal,
        formulation_version=version,
        specification_sheet=sheet,
        product_code=product_code,
        description=description,
        quantity=max(1, int(seeded_qty)),
        unit_cost=unit_cost,
        unit_price=unit_price,
        display_order=display_order,
    )
    proposal.updated_by = actor
    proposal.save(update_fields=["updated_by", "updated_at"])
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal_line.add",
        target=proposal,
        after={"line_id": str(line.id)},
    )
    return line


@transaction.atomic
def update_proposal_line(
    *,
    proposal: Proposal,
    line_id: Any,
    actor: Any,
    **changes: Any,
) -> ProposalLine:
    _guard_mutable(proposal)
    line = proposal.lines.filter(id=line_id).first()
    if line is None:
        raise ProposalLineNotFound()

    # ``specification_sheet_id`` needs the cross-tenant FK check + the
    # director-signed guard. ``_resolve_quotable_sheet`` covers both.
    sheet_changed = False
    if "specification_sheet_id" in changes:
        sheet_id = changes.pop("specification_sheet_id")
        if sheet_id is None:
            line.specification_sheet = None
        else:
            line.specification_sheet = _resolve_quotable_sheet(
                sheet_id, proposal.organization
            )
        sheet_changed = True

    updatable = {
        "product_code",
        "description",
        "quantity",
        "unit_cost",
        "unit_price",
        "display_order",
    }
    for key, value in changes.items():
        if key in updatable and value is not None:
            setattr(line, key, value)

    # Auto-fill pricing from the newly-attached spec.
    #
    # Three intents to balance:
    #
    #   1. Operator created a line manually (cost=15, price=0 from
    #      the default Decimal zero), then attaches a spec hoping
    #      to fill the price. The "all-None" precondition the
    #      previous implementation used left price stuck at zero
    #      because zero is not None — the picker looked broken.
    #   2. Operator typed a deliberate price (price=99.99 for a
    #      one-off negotiation), then swaps the spec for a
    #      different one. The manual override is meaningful and
    #      shouldn't get silently clobbered.
    #   3. The same PATCH explicitly carries a new cost / price
    #      alongside the spec swap. That value is the operator's
    #      most recent stated intent and wins.
    #
    # Rule: same-payload override (#3) wins; otherwise empty
    # columns get filled from the spec, where "empty" means
    # ``None`` *or* zero (#1). A positive value on the line counts
    # as a manual override (#2) and survives the spec swap.
    if sheet_changed and line.specification_sheet is not None:
        spec = line.specification_sheet
        sales_set_cost = (
            "unit_cost" in changes and changes["unit_cost"] is not None
        )
        sales_set_price = (
            "unit_price" in changes and changes["unit_price"] is not None
        )
        cost_is_blank = line.unit_cost is None or line.unit_cost == 0
        price_is_blank = line.unit_price is None or line.unit_price == 0
        if not sales_set_cost and cost_is_blank:
            derived_cost = _spec_unit_cost(spec)
            if derived_cost is not None:
                line.unit_cost = derived_cost
        if not sales_set_price and price_is_blank:
            derived_price = _spec_unit_price(spec)
            if derived_price is not None:
                line.unit_price = derived_price

    line.save()
    proposal.updated_by = actor
    proposal.save(update_fields=["updated_by", "updated_at"])
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal_line.update",
        target=proposal,
        after={"line_id": str(line.id)},
    )
    return line


@transaction.atomic
def delete_proposal_line(
    *, proposal: Proposal, line_id: Any, actor: Any
) -> None:
    _guard_mutable(proposal)
    line = proposal.lines.filter(id=line_id).first()
    if line is None:
        raise ProposalLineNotFound()
    target_id = str(line.id)
    line.delete()
    proposal.updated_by = actor
    proposal.save(update_fields=["updated_by", "updated_at"])
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal_line.delete",
        target=proposal,
        after={"line_id": target_id},
    )


# ---------------------------------------------------------------------------
# Required fields per status transition
# ---------------------------------------------------------------------------


#: Fields the proposal needs before it can advance *into* each
#: status. Keys are (from_status, to_status) tuples so we can be
#: strict about the outgoing edge — e.g. ``draft → in_review``
#: requires customer info + pricing, while the reverse
#: ``in_review → draft`` has no requirements. The frontend uses this
#: list to pop a "fill these in" modal before retrying the transition.
#:
#: ``lines`` is a pseudo-field meaning "at least one priced line on
#: the proposal". Trivial to validate server-side, expressive enough
#: on the client — the modal renders a small "Add product" CTA
#: instead of a plain text input when it sees this key.
_REQUIRED_FOR_TRANSITION: dict[tuple[str, str], tuple[str, ...]] = {
    (ProposalStatus.DRAFT.value, ProposalStatus.IN_REVIEW.value): (
        # Mirrors the ``in_review → approved`` (and therefore the
        # ``approved → sent``) set so the operator cannot kick a
        # proposal into the director's queue with content the
        # director would have rejected anyway. Catching it at
        # send-for-review pushes the validation a step earlier
        # in the flow: the only way the proposal can REACH
        # ``in_review`` is with a complete document, so the
        # director can sign off on whatever lands in front of
        # them without paging the rep to fix blanks. The
        # alternative — gating only at approval — leaves the
        # director with the choice between rejecting (which
        # forces a second round-trip) and approving an
        # incomplete proposal that needs the post-hoc
        # ``complete_required_fields`` escape hatch.
        "customer_name",
        "customer_email",
        "reference",
        "invoice_address",
        "sales_person",
        "lines",
    ),
    (ProposalStatus.IN_REVIEW.value, ProposalStatus.APPROVED.value): (
        # Same set as the ``draft → in_review`` gate above. Kept
        # explicit (rather than collapsed via a shared tuple) so
        # the per-transition contract is auditable in one place
        # and a future divergence (e.g. director-specific fields)
        # is a localised edit.
        "customer_name",
        "customer_email",
        "reference",
        "invoice_address",
        "sales_person",
        "lines",
    ),
    (ProposalStatus.APPROVED.value, ProposalStatus.SENT.value): (
        "customer_name",
        "customer_email",
        # ``dear_name`` was here but the renderer already falls back
        # to ``customer_name`` when it's empty (see
        # apps/proposals/render.py — ``proposal.dear_name or
        # proposal.customer_name or "Customer"``), so requiring it
        # at the validation layer was redundant and confusing:
        # the edit form shows the customer name as a placeholder,
        # making the field LOOK filled while the stored value is
        # empty. The send would then reject with
        # ``missing_required_fields:dear_name`` for what the
        # operator sees as a populated field.
        "reference",
        "invoice_address",
        "sales_person",
        "lines",
    ),
}


def _missing_required_fields(
    proposal: Proposal, from_status: str, to_status: str
) -> list[str]:
    required = _REQUIRED_FOR_TRANSITION.get((from_status, to_status), ())
    missing: list[str] = []
    for key in required:
        if key == "lines":
            # At least one line AND every priced line has unit_price
            # so the rendered PDF doesn't ship with "TBC" in the
            # grand total.
            priced_lines = [
                line
                for line in proposal.lines.all()
                if line.unit_price is not None
            ]
            if not priced_lines:
                missing.append("lines")
            continue
        if key == "sales_person":
            # The proposal may carry an override (multi-project
            # proposals need one because "the project's sales person"
            # is ambiguous); otherwise we fall back to the primary
            # project's owner so single-line proposals keep working
            # without the scientist having to re-pick anyone.
            assigned = (
                proposal.sales_person
                or getattr(
                    proposal.formulation_version.formulation,
                    "sales_person",
                    None,
                )
            )
            if assigned is None:
                missing.append("sales_person")
            continue
        value = getattr(proposal, key, "")
        if value is None or (isinstance(value, str) and not value.strip()):
            missing.append(key)
    return missing


#: Free-text fields that may be filled on a locked (``approved``)
#: proposal *only* to satisfy the required-for-sent gate. Excludes
#: ``sales_person`` (a FK, not a text field) and ``lines`` (a logical
#: state, not a field). Both of those are now caught at the
#: ``in_review → approved`` gate too, so the only realistic miss on
#: an approved proposal is text metadata the director left blank.
_COMPLETABLE_REQUIRED_FIELDS: frozenset[str] = frozenset(
    {
        "customer_name",
        "customer_email",
        "reference",
        "invoice_address",
    }
)


class ProposalNotMissingRequiredField(Exception):
    """Raised when the caller asks to fill a field on an approved
    proposal that wasn't actually missing — guards against silent
    post-approval edits of fields the director did sign off on."""

    code = "proposal_not_missing_required_field"


@transaction.atomic
def complete_required_fields(
    *, proposal: Proposal, actor: Any, patch: dict[str, str]
) -> Proposal:
    """Fill required-for-send fields on an already-approved proposal.

    Narrow escape hatch for the case where a director approved a
    proposal before the ``in_review → approved`` gate was tightened to
    catch the full required-for-sent set. The mainline rule still
    stands: a locked proposal is read-only. This path only accepts
    keys in :data:`_COMPLETABLE_REQUIRED_FIELDS` that are currently
    reported missing by :func:`_missing_required_fields`, so it cannot
    be used to silently rewrite content the director did review.

    Raises:
        :class:`ProposalNotMutable` — proposal is not in ``approved``
            (drafts/in-review use ``update_proposal``; sent/accepted/
            rejected are terminal).
        :class:`ProposalNotMissingRequiredField` — caller tried to set
            a field that wasn't on the missing list.
    """

    if proposal.status != ProposalStatus.APPROVED.value:
        raise ProposalNotMutable()

    missing = set(
        _missing_required_fields(
            proposal,
            ProposalStatus.APPROVED.value,
            ProposalStatus.SENT.value,
        )
    )

    sanitized: dict[str, str] = {}
    for key, raw in patch.items():
        if key not in _COMPLETABLE_REQUIRED_FIELDS:
            raise ProposalNotMissingRequiredField()
        if key not in missing:
            raise ProposalNotMissingRequiredField()
        value = "" if raw is None else str(raw).strip()
        if not value:
            # Empty/whitespace is the state we're trying to fix —
            # rejecting it here means the audit row only records
            # actual transitions from blank → filled.
            raise ProposalNotMissingRequiredField()
        sanitized[key] = value

    if not sanitized:
        return proposal

    before = snapshot(proposal)
    for key, value in sanitized.items():
        setattr(proposal, key, value)
    proposal.updated_by = actor
    proposal.save()
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal.complete_required_fields",
        target=proposal,
        before=before,
        after=snapshot(proposal),
    )
    return proposal


@transaction.atomic
def transition_status(
    *,
    proposal: Proposal,
    actor: Any,
    to_status: str,
    signature_image: str = "",
    customer_info: dict[str, str] | None = None,
    notes: str = "",
) -> Proposal:
    """Advance the proposal along the status machine.

    Raises :class:`InvalidProposalTransition` when the edge is not
    allowed, :class:`SignatureRequired` when the edge needs a
    signature the caller didn't provide. Audit row + status-transition
    row are written atomically so history is always complete.
    """

    if to_status not in {s.value for s in ProposalStatus}:
        raise InvalidProposalTransition()
    legal = _LEGAL_TRANSITIONS.get(proposal.status, frozenset())
    if to_status not in legal:
        raise InvalidProposalTransition()

    # Gate the transition on required-field completion before touching
    # the signature slot — otherwise a scientist could land signed
    # approvals on a proposal that still has ``TBC`` prices or a
    # blank customer name, and the PDF sent to the client would bake
    # in that gap permanently.
    missing = _missing_required_fields(proposal, proposal.status, to_status)
    if missing:
        raise MissingRequiredFields(missing)

    slot = _TRANSITION_SIGNATURE_SLOT.get((proposal.status, to_status))
    from_status = proposal.status
    before = snapshot(proposal)

    if slot is not None:
        if not signature_image:
            raise SignatureRequired()
        try:
            validate_signature_image(signature_image)
        except SignatureImageInvalid as exc:
            raise SignatureRequired() from exc
        setattr(proposal, slot.image_field, signature_image)
        setattr(proposal, slot.signed_at_field, timezone.now())
        if slot.user_field is not None:
            setattr(proposal, slot.user_field, actor)
        if customer_info is not None and slot.user_field is None:
            # Customer signing from the kiosk — capture their
            # name/email/company on the proposal for the audit trail
            # and the rendered document.
            proposal.customer_signer_name = customer_info.get("name", "") or ""
            proposal.customer_signer_email = customer_info.get("email", "") or ""
            proposal.customer_signer_company = (
                customer_info.get("company", "") or ""
            )

    # Auto-rotate the public token on approval so the kiosk link only
    # goes live once both internal signatures are in place — mirrors
    # the spec-sheet flow.
    if (
        to_status == ProposalStatus.APPROVED.value
        and proposal.public_token is None
    ):
        proposal.public_token = uuid.uuid4()

    # Staff-driven manual reject: stamp the same audit columns the
    # kiosk path writes via :func:`capture_customer_rejection_on_proposal`
    # so the downstream surfaces (rejection panel on the proposal
    # page, the customer-rejection email to the sales person) work
    # regardless of who triggered the close. ``notes`` carries the
    # optional reason the closer typed into the dialog; it lands in
    # ``customer_rejection_reason`` (the field the panel + email
    # already read) so we don't fork a parallel "staff_rejection_*"
    # column set.
    is_manual_reject = (
        to_status == ProposalStatus.REJECTED.value
        and proposal.customer_rejected_at is None
    )
    if is_manual_reject:
        proposal.customer_rejected_at = timezone.now()
        proposal.customer_rejection_reason = (notes or "").strip()

    proposal.status = to_status
    proposal.updated_by = actor
    proposal.save()

    # Advance the PSP-side wizard block. The merge sync plants
    # ``npd_proposal_status`` on the primary CO; re-firing it here
    # keeps PSP's wizard in step (draft → in_review → approved →
    # sent → accepted flips the phase between "Awaiting proposal
    # approval", "Ready to send", "Awaiting customer signature",
    # then into Setup once accepted).
    #
    # Rejection is different: the proposal is dead, so the N R&D
    # formulations that were folded into the primary CO should split
    # back into individual orders — mirroring what NPD looks like
    # (separate projects) once the dead proposal no longer binds them.
    # We fire the same unmerge path as ``delete_proposal`` so PSP
    # restores every secondary CO, fans comments back to their home,
    # and wipes the primary's proposal identity. The proposal row
    # itself stays on NPD (terminal state) as the audit anchor for
    # the rejection reason.
    if to_status == ProposalStatus.REJECTED.value:
        _schedule_proposal_psp_unmerge(
            organization=proposal.organization,
            proposal_uuid=str(proposal.pk),
        )
    else:
        _schedule_proposal_psp_merge(proposal)

    # When the proposal is sent to the client, pull every attached
    # spec into ``SENT`` alongside it. The kiosk signs the whole
    # bundle at once and gates on each document being ``SENT``, so
    # leaving a bundled spec in ``DRAFT`` / ``APPROVED`` would
    # silently lock the client out of signing that document.
    if to_status == ProposalStatus.SENT.value:
        _promote_attached_specs_to_sent(proposal=proposal, actor=actor)

    # Inverse on the rejection path: revert promoted specs back to
    # ``APPROVED`` so the team can spawn a fresh proposal against
    # the same recipe. Without this, the project gets stuck — the
    # proposal builder requires specs at ``APPROVED`` and would
    # refuse to bundle a sheet still sitting at ``SENT`` from the
    # dead deal.
    if to_status == ProposalStatus.REJECTED.value:
        _revert_attached_specs_after_rejection(
            proposal=proposal, actor=actor
        )

    ProposalStatusTransition.objects.create(
        proposal=proposal,
        from_status=from_status,
        to_status=to_status,
        actor=actor,
        notes=notes,
    )
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal.status_transition",
        target=proposal,
        before=before,
        after=snapshot(proposal),
    )

    # Best-effort email-out for the manual reject. Same delivery
    # contract as the kiosk path: queued via ``transaction.on_commit``
    # so a roll-back upstream suppresses the notification, and
    # swallowed in eager mode so an SMTP blip can't undo the
    # rejection itself.
    if is_manual_reject:
        proposal_id = proposal.id

        def _dispatch_manual_rejection_email() -> None:
            from apps.proposals.tasks import (
                send_proposal_rejection_notification_task,
            )

            try:
                send_proposal_rejection_notification_task.delay(
                    str(proposal_id)
                )
            except Exception:  # noqa: BLE001
                pass

        transaction.on_commit(_dispatch_manual_rejection_email)
    return proposal


def _render_and_send_proposal_email(
    *,
    proposal: Proposal,
    recipient: str,
    subject: str,
    body_text: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
    auto_bcc_sales_person: bool = False,
) -> tuple[str, list[str], list[str]]:
    """Render the proposal email body (HTML wrapper + plain text) and
    push it through Django's email backend. Returns the final
    ``(subject, cc_clean, bcc_clean)`` so callers can audit-log what
    actually went out.

    Shared between :func:`send_proposal_to_client` (which then flips
    status to ``sent``) and :func:`send_proposal_test_email` (which
    sends a preview to the operator without touching status). Keeping
    one render path guarantees the test email is byte-identical to
    what the customer would receive — that's the whole point of
    letting sales send a preview to themselves.

    The template lookup is :data:`proposals/email/send_to_client.html`;
    the plain-text alternative is the operator's typed body verbatim.

    Raises :class:`ProposalEmailRecipientRequired` when ``recipient``
    is empty and :class:`ProposalEmailSendFailed` when the SMTP layer
    raises (the original exception is chained for the audit log).
    """

    recipient_clean = (recipient or "").strip()
    if not recipient_clean:
        raise ProposalEmailRecipientRequired()

    # Defensive cleaning on CC / BCC so a stray empty string from the
    # form layer doesn't fail SMTP validation. Lists default to empty.
    cc_clean = [addr.strip() for addr in (cc or []) if addr and addr.strip()]
    bcc_clean = [addr.strip() for addr in (bcc or []) if addr and addr.strip()]

    # Lazy import — Django email machinery doesn't need to be on the
    # import path for tests that don't exercise this code path.
    from django.conf import settings
    from django.core.mail import EmailMultiAlternatives
    from django.template.loader import render_to_string

    from_email = getattr(
        settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
    )
    app_base = getattr(
        settings, "APP_BASE_URL", "http://localhost:3000"
    ).rstrip("/")
    # The kiosk email now points at the customer portal's activation
    # landing page. Repurposes the existing ``public_token`` as the
    # one-shot activation credential: first click sets up a portal
    # account; subsequent clicks land on the sign-in page (the
    # activation view auto-routes returners to login).
    kiosk_url = (
        f"{app_base}/portal/activate/{proposal.public_token}"
        if proposal.public_token is not None
        else ""
    )

    # Activation code is NOT generated here any more. The proposal
    # email carries only the kiosk button — the 6-digit code is
    # delivered just-in-time by a separate email when the customer
    # actually needs to type it on the activation page (see
    # :func:`apps.client_portal.services.request_activation_code`).
    # Two reasons the code moved out of this email:
    #   * Customers couldn't find the code buried below a long
    #     cover letter and kept replying "I don't have a code".
    #   * A forwarded proposal email used to leak the code as well
    #     as the link; with separate delivery the link by itself is
    #     useless without a fresh code that only the inbox owner can
    #     retrieve at activation time.
    #
    # Clear any stale code/timestamp left over from a prior send so
    # the resend always starts the customer from a clean slate —
    # they must request a fresh code on the activation page.
    activation_code = ""
    proposal.activation_code = ""
    proposal.activation_code_sent_at = None

    # Cover-letter signoff name. Falls back through sales person →
    # primary project's owner → empty so the email never carries a
    # placeholder ``None`` token where a real name should be.
    sales_person = (
        proposal.sales_person
        or getattr(
            proposal.formulation_version.formulation, "sales_person", None
        )
    )
    sales_person_name = ""
    sales_person_email = ""
    if sales_person is not None:
        sales_person_name = (
            sales_person.get_full_name() or sales_person.email or ""
        ).strip()
        # Sign-off email — only surface it when distinct from the
        # name to avoid "Alex Smith\nAlex Smith" when the user has
        # no full name set. The template hides the line when empty.
        candidate_email = (sales_person.email or "").strip()
        if candidate_email and candidate_email != sales_person_name:
            sales_person_email = candidate_email

    body_html = render_to_string(
        "proposals/email/send_to_client.html",
        {
            "proposal": proposal,
            "body_text": body_text or "",
            "kiosk_url": kiosk_url,
            "activation_code": activation_code,
            "sales_person_name": sales_person_name,
            "sales_person_email": sales_person_email,
        },
    )

    # Plain-text body. Critical for deliverability: corporate spam
    # filters (especially Mimecast / Proofpoint / Microsoft ATP)
    # score messages on the HTML-only-vs-plain-text ratio, and some
    # paranoid Outlook policies render *only* the plain-text part to
    # the recipient. We append the kiosk URL on its own line so the
    # link survives even if the sales rep's typed body doesn't
    # mention it, and stamp the proposal code so the customer can
    # match the message to a deal in their own records.
    plain_lines: list[str] = []
    if body_text and body_text.strip():
        plain_lines.append(body_text.rstrip())
        plain_lines.append("")
    if kiosk_url:
        # Plain-text mirrors the HTML: link only, no code. The code
        # arrives in a separate JIT email when the customer hits the
        # activation page.
        plain_lines.append("Open the proposal here:")
        plain_lines.append(kiosk_url)
        plain_lines.append("")
    if sales_person_name:
        plain_lines.append("Kind regards,")
        plain_lines.append(sales_person_name)
        if sales_person_email:
            plain_lines.append(sales_person_email)
        plain_lines.append("")
    plain_lines.append(f"— Proposal · {proposal.code}")
    plain_body = "\n".join(plain_lines)

    final_subject = (subject or "").strip() or (
        f"Your proposal — {proposal.code}"
    )

    # ``Reply-To`` points at the sales person, not at the
    # ``no-reply`` from-address. Two reasons:
    #   1. Corporate spam filters flag ``no-reply`` senders without
    #      a reachable Reply-To header as low-trust.
    #   2. The customer should be able to reply to the email and
    #      reach a human, not the void. The from-address stays
    #      ``DEFAULT_FROM_EMAIL`` because SPF/DKIM are aligned on
    #      that domain (signing with the sales person's personal
    #      address would break DMARC).
    reply_to: list[str] = []
    sales_email = ""
    if sales_person is not None:
        sales_email = (getattr(sales_person, "email", "") or "").strip()
        if sales_email:
            reply_to = [
                f"{sales_person_name} <{sales_email}>"
                if sales_person_name
                else sales_email
            ]

    # Auto-BCC the assigned sales person so they get a record of
    # every customer-facing send without the operator having to
    # remember to CC themselves. BCC (not CC) so the customer
    # doesn't see internal addresses in the visible headers — the
    # Reply-To above already routes any reply back to them. Skip
    # when (a) the operator already put the sales person on the cc
    # / bcc explicitly, or (b) the sales person IS the recipient
    # (sending to yourself is weird).
    #
    # Gated on ``auto_bcc_sales_person`` so the preview path
    # (:func:`send_proposal_test_email`) never copies the sales
    # person — a test send is the operator's own iteration loop and
    # must not leak into anyone else's inbox.
    if auto_bcc_sales_person and sales_email:
        lowered_existing = {
            addr.lower() for addr in (cc_clean + bcc_clean + [recipient_clean])
        }
        if sales_email.lower() not in lowered_existing:
            bcc_clean.append(sales_email)

    message = EmailMultiAlternatives(
        subject=final_subject,
        body=plain_body,
        from_email=from_email,
        to=[recipient_clean],
        cc=cc_clean or None,
        bcc=bcc_clean or None,
        reply_to=reply_to or None,
        headers={
            # ``X-Auto-Response-Suppress`` tells exchange servers not
            # to bounce auto-replies back; the proposal email is
            # transactional and an OOO bounce is noise.
            "X-Auto-Response-Suppress": "All",
            # ``X-Entity-Ref-ID`` is read by Gmail to thread / group
            # emails about the same proposal. Pins related messages
            # (test send, real send) into one conversation so the
            # customer's inbox doesn't show two unrelated rows.
            "X-Entity-Ref-ID": str(proposal.id),
        },
    )
    message.attach_alternative(body_html, "text/html")

    try:
        message.send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001 — re-raised as domain error
        raise ProposalEmailSendFailed(str(exc)) from exc

    return final_subject, cc_clean, bcc_clean


def _send_proposal_rejection_notification(*, proposal_id: Any) -> None:
    """Email the sales person that the customer declined a proposal.

    Called from :func:`transaction.on_commit` inside
    :func:`capture_customer_rejection_on_proposal` so we don't dispatch
    a notification for a rejection that ended up rolled back. The
    proposal is re-fetched fresh from the DB by id — passing the
    instance through the closure can produce a stale state when the
    surrounding atomic block touches related rows.

    Best-effort delivery: logs and swallows SMTP failures so a flaky
    relay doesn't surface as an error to the kiosk after the
    rejection has otherwise committed. The audit row already proves
    the rejection happened — the email is a convenience nudge for
    the sales team.
    """

    import logging

    from django.conf import settings
    from django.core.mail import EmailMultiAlternatives
    from django.template.loader import render_to_string

    logger = logging.getLogger(__name__)

    proposal = Proposal.objects.filter(id=proposal_id).first()
    if proposal is None:
        return

    sales_person = (
        proposal.sales_person
        or getattr(
            proposal.formulation_version.formulation, "sales_person", None
        )
    )
    recipient = getattr(sales_person, "email", "") if sales_person else ""
    if not recipient:
        # No-one to email — log a breadcrumb so an admin reviewing the
        # audit trail can see why the team wasn't notified. The
        # rejection itself stays recorded.
        logger.warning(
            "Customer rejected proposal %s but no sales-person email is wired",
            proposal.id,
        )
        return

    from_email = getattr(
        settings, "DEFAULT_FROM_EMAIL", "no-reply@localhost"
    )
    app_base = getattr(
        settings, "APP_BASE_URL", "http://localhost:3000"
    ).rstrip("/")
    proposal_url = f"{app_base}/proposals/{proposal.id}"

    sales_person_name = ""
    if sales_person is not None:
        sales_person_name = (
            sales_person.get_full_name() or sales_person.email or ""
        ).strip()

    context = {
        "proposal": proposal,
        "proposal_url": proposal_url,
        "sales_person_name": sales_person_name,
        "reason": proposal.customer_rejection_reason or "",
    }
    subject = f"Proposal {proposal.code} declined by the customer"
    text_body = render_to_string(
        "proposals/email/customer_rejection.txt", context
    )
    html_body = render_to_string(
        "proposals/email/customer_rejection.html", context
    )

    message = EmailMultiAlternatives(
        subject=subject,
        body=text_body,
        from_email=from_email,
        to=[recipient],
    )
    message.attach_alternative(html_body, "text/html")
    try:
        message.send(fail_silently=False)
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "Failed to send rejection notification for proposal %s: %s",
            proposal.id,
            exc,
        )


def send_proposal_test_email(
    *,
    proposal: Proposal,
    actor: Any,
    recipient: str,
    subject: str,
    body_text: str,
) -> str:
    """Send a preview of the customer email to ``recipient`` (typically
    the operator themselves) without touching the proposal's status.

    The body is rendered through the same template + plain-text path
    as :func:`send_proposal_to_client`, so what the operator sees in
    their inbox is byte-identical to what the customer would receive
    if they hit "Send to client" with the same modal state.

    Deliberately *not* wrapped in a transaction: a test send is a
    side effect, not part of any business invariant. An audit row is
    still written so an admin reviewing the log can see who sent a
    preview and to which address (useful when a sales rep emails a
    test to a client by accident).

    Returns the final subject line that was sent — the modal uses it
    to render a "Sent test to …" confirmation banner.
    """

    final_subject, cc_clean, bcc_clean = _render_and_send_proposal_email(
        proposal=proposal,
        recipient=recipient,
        subject=subject,
        body_text=body_text,
        cc=None,
        bcc=None,
    )
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal.test_email_sent",
        target=proposal,
        after={
            "recipient": (recipient or "").strip(),
            "subject": final_subject,
        },
    )
    return final_subject


@transaction.atomic
def send_proposal_to_client(
    *,
    proposal: Proposal,
    actor: Any,
    recipient: str,
    subject: str,
    body_text: str,
    cc: list[str] | None = None,
    bcc: list[str] | None = None,
) -> Proposal:
    """Email the kiosk link to the customer and atomically flip the
    proposal status from ``approved`` to ``sent``.

    Atomic semantics: either the customer gets the email AND the
    proposal moves to ``sent``, or neither happens. The whole
    function runs inside ``@transaction.atomic`` and we send the email
    *before* the transition is recorded — if the SMTP layer raises,
    the surrounding transaction rolls back, the status stays at
    ``approved``, and the sales person can retry from the modal.

    The ``body_text`` arrives from the compose modal exactly as the
    sales person typed it. The HTML alternative is rendered server-
    side from :data:`proposals/email/send_to_client.html` with the
    typed copy wrapped in a branded card and an "Open proposal" CTA
    pointing at the kiosk URL. Two reasons the HTML is server-side:

    * Customers across email clients render markup inconsistently;
      one canonical template avoids surprises.
    * The kiosk URL is always built from ``APP_BASE_URL`` +
      ``proposal.public_token`` — never trust the frontend to embed
      a deep link.

    Raises:
        :class:`InvalidProposalTransition` — proposal isn't at
            ``approved`` (the state machine refuses the edge).
        :class:`ProposalEmailRecipientRequired` — ``recipient`` is
            empty after trimming.
        :class:`ProposalEmailSendFailed` — SMTP / Django raised on
            ``message.send``. Wraps the original exception.
        :class:`MissingRequiredFields` — proposal is missing
            something the status machine requires for ``sent``.
    """

    # Re-fetch under a row lock so two parallel "Send to client"
    # clicks on the same proposal serialise on the DB. Without this,
    # both requests would read ``status=approved`` simultaneously,
    # both pass the guard below, and both fire SMTP — producing
    # duplicate customer emails. The lock makes the second caller
    # wait until the first commits, at which point it sees the
    # ``sent`` status and raises ``InvalidProposalTransition``.
    proposal = Proposal.objects.select_for_update().get(pk=proposal.pk)

    if proposal.status != ProposalStatus.APPROVED.value:
        raise InvalidProposalTransition()

    # Shared render + send path. Raises on empty recipient or SMTP
    # failure; the surrounding ``@transaction.atomic`` rolls back the
    # whole block on any exception so a failed send never leaves the
    # status flipped. ``auto_bcc_sales_person=True`` so the real
    # customer dispatch always cc's the proposal's sales person —
    # the preview path leaves this off so a test send only ever
    # reaches the typed recipient.
    final_subject, cc_clean, bcc_clean = _render_and_send_proposal_email(
        proposal=proposal,
        recipient=recipient,
        subject=subject,
        body_text=body_text,
        cc=cc,
        bcc=bcc,
        auto_bcc_sales_person=True,
    )
    recipient_clean = (recipient or "").strip()

    # Persist the recipient the kiosk email actually reached + the
    # activation code we just generated. Both are read by the
    # portal activation flow. ``activation_code`` was assigned to
    # the in-memory ``proposal`` instance earlier so this single
    # save commits the value that was embedded in the outgoing
    # email body.
    proposal.kiosk_recipient_email = recipient_clean
    proposal.save(
        update_fields=[
            "kiosk_recipient_email",
            "activation_code",
            "activation_code_sent_at",
            "updated_at",
        ],
    )

    # Email succeeded — record the dispatch *before* the transition so
    # an operator inspecting the audit log can see the message went out
    # even if a later assertion in ``transition_status`` raises and
    # rolls the whole atomic block back. Recipient + subject only —
    # the body is captured in the SMTP log, not in our DB.
    record_audit(
        organization=proposal.organization,
        actor=actor,
        action="proposal.email_sent",
        target=proposal,
        after={
            "recipient": recipient_clean,
            "cc": cc_clean,
            "bcc": bcc_clean,
            "subject": final_subject,
        },
    )

    # Back-fill ``customer.email`` from the recipient we just emailed
    # if the customer record had nothing on file. Mitigates the
    # "customer claims they're not registered" trap: the proposal
    # carried a working address all along, but the address book row
    # was blank, which broke every downstream flow that reads
    # ``customer.email`` (portal invites, email-change confirmations,
    # password reset). We only fill the gap — never overwrite an
    # existing address — so the address book stays the source of
    # truth when the operator has explicitly set one.
    customer = proposal.customer
    if (
        customer is not None
        and not (customer.email or "").strip()
        and recipient_clean
    ):
        before_customer = {"email": customer.email or ""}
        customer.email = recipient_clean
        customer.save(update_fields=["email", "updated_at"])
        record_audit(
            organization=proposal.organization,
            actor=actor,
            action="customer.email_backfilled_from_proposal",
            target=customer,
            before=before_customer,
            after={"email": recipient_clean, "source_proposal_id": str(proposal.id)},
        )

    # Now flip status to ``sent``. Reuses the canonical transition path
    # so attached specs get promoted, the status-transition row is
    # written, and the same legal-edge check runs.
    return transition_status(
        proposal=proposal,
        actor=actor,
        to_status=ProposalStatus.SENT.value,
        notes=f"Sent to {recipient_clean}",
    )


# ---------------------------------------------------------------------------
# Proposal-centric kiosk
#
# A proposal shared via ``public_token`` renders on its own kiosk page
# alongside every specification sheet attached through ``ProposalLine``.
# The client signs each document separately (proposal + one signature
# per spec) but the deal only advances once all signatures are in —
# half-signed proposals are a legal concern ("I never saw that spec")
# so the finalize step is gated on every document carrying a captured
# signature. Signing individually writes the signature but leaves
# status at ``sent``; ``finalize_proposal_kiosk`` flips everything to
# ``accepted`` atomically.
# ---------------------------------------------------------------------------


class ProposalPublicLinkNotEnabled(Exception):
    """The requested ``public_token`` does not resolve to a proposal —
    either the token is wrong or the link was revoked. Maps to 404 so a
    stale token leaks no information about what the proposal became."""

    code = "public_link_not_enabled"


class KioskSpecNotOnProposal(Exception):
    """A kiosk request tried to sign a spec sheet that isn't attached
    to the proposal behind the public token. Defends against a client
    crafting a ``/specs/<uuid>/sign`` URL with an unrelated spec id."""

    code = "kiosk_spec_not_on_proposal"


class KioskSignaturesPending(Exception):
    """Finalize was called before every document had a captured
    customer signature. The kiosk lists which docs are still pending
    so the client can scroll back and sign them."""

    code = "kiosk_signatures_pending"


def _attached_spec_sheets(proposal: Proposal) -> list[SpecificationSheet]:
    """All specification sheets bundled with this proposal.

    Draws from two sources and dedupes by sheet id:

    * Every ``ProposalLine.specification_sheet`` that the scientist
      attached through the lines panel — the canonical path.
    * The legacy ``Proposal.specification_sheet`` OneToOne, kept on
      the schema for proposals created before per-line attachment
      existed. Including it here means a single migration hasn't
      yet been needed to deprecate the field.

    Returns sheets in ``created_at`` order so the kiosk paints them
    in a stable sequence regardless of insertion.
    """

    sheet_ids: list[Any] = []
    seen: set[Any] = set()
    for line in proposal.lines.all().order_by("display_order", "created_at"):
        sid = line.specification_sheet_id
        if sid is not None and sid not in seen:
            seen.add(sid)
            sheet_ids.append(sid)
    legacy = proposal.specification_sheet_id
    if legacy is not None and legacy not in seen:
        seen.add(legacy)
        sheet_ids.append(legacy)

    if not sheet_ids:
        return []

    by_id = {
        sheet.id: sheet
        for sheet in SpecificationSheet.objects.filter(id__in=sheet_ids)
    }
    return [by_id[sid] for sid in sheet_ids if sid in by_id]


def _ensure_attached_spec_tokens(
    *, proposal: Proposal, actor: Any
) -> None:
    """Mint a ``public_token`` on every attached spec that lacks one.

    Separated from :func:`_promote_attached_specs_to_sent` because the
    token is what makes the kiosk preview iframe load — and the
    customer should be able to *preview* the bundled spec sheets the
    moment the proposal kiosk URL goes live (i.e. as soon as the
    proposal is approved), not only once the proposal is flipped from
    ``approved`` → ``sent``.

    Idempotent: specs that already carry a token are untouched.
    """

    for sheet in _attached_spec_sheets(proposal):
        if sheet.public_token is not None:
            continue
        sheet.public_token = uuid.uuid4()
        sheet.updated_by = actor
        sheet.save(
            update_fields=["public_token", "updated_by", "updated_at"]
        )


def _promote_attached_specs_to_sent(
    *, proposal: Proposal, actor: Any
) -> list[SpecificationSheet]:
    """Move every attached spec sheet into ``SENT`` when the proposal
    is sent to the client.

    The spec state machine only permits ``APPROVED → SENT``, but a
    spec bundled into a proposal inherits the proposal's approval
    chain (prepared-by + director signatures on the proposal itself
    apply to the whole bundle). So we deliberately shortcut the
    spec's internal review here — the kiosk has to treat every
    document in the bundle as signable at the same moment, and
    legally the proposal's signatures cover the bundled specs.

    Already-``SENT`` / already-``ACCEPTED`` specs are skipped so we
    don't clobber a sheet that went through its own lifecycle. An
    audit row is recorded for every promoted sheet so the trail
    shows exactly which specs rode the proposal's send.
    """

    from apps.specifications.services import SpecificationStatus

    promoted: list[SpecificationSheet] = []
    for sheet in _attached_spec_sheets(proposal):
        mint_token = sheet.public_token is None
        if sheet.status in (
            SpecificationStatus.SENT,
            SpecificationStatus.ACCEPTED,
        ):
            # Still make sure the kiosk iframe can render it — a spec
            # that reached ``SENT`` on its own lifecycle might not have
            # had its token rotated yet.
            if mint_token:
                sheet.public_token = uuid.uuid4()
                sheet.updated_by = actor
                sheet.save(
                    update_fields=["public_token", "updated_by", "updated_at"]
                )
            continue
        before = {"status": sheet.status}
        sheet.status = SpecificationStatus.SENT
        if mint_token:
            sheet.public_token = uuid.uuid4()
        sheet.updated_by = actor
        update_fields = ["status", "updated_by", "updated_at"]
        if mint_token:
            update_fields.append("public_token")
        sheet.save(update_fields=update_fields)
        record_audit(
            organization=sheet.organization,
            actor=actor,
            action="spec_sheet.promoted_via_proposal",
            target=sheet,
            before=before,
            after={"status": sheet.status, "proposal_id": str(proposal.id)},
        )
        promoted.append(sheet)
    return promoted


def _revert_attached_specs_after_rejection(
    *, proposal: Proposal, actor: Any
) -> list[SpecificationSheet]:
    """Full reset every attached spec back to ``DRAFT``.

    When the proposal dies, the whole compliance cycle failed —
    the customer rejected the offering. We can't assume the
    scientist's draft or the director's sign-off are still valid,
    because sales may need to revise the recipe (not just re-price).
    So we wipe both internal signatures and bounce the sheet all the
    way back to ``DRAFT``, giving the scientist a clean slate to
    iterate on.

    Downstream effect on PSP: the ``APPROVED → DRAFT`` transition
    fires the existing "spec cleared" sync (see
    :func:`apps.specifications.services._fire_spec_reverted_sync`),
    which wipes ``npd_spec_approved_at`` on each affected CO. That
    flips the PSP wizard from ``:awaiting_proposal`` back to
    ``:r_and_d`` — matching NPD's reality that the project is
    genuinely back on the R&D bench.

    Two specs are deliberately left alone:

    * ``ACCEPTED`` — the customer has signed the spec. Signed
      documents are legally binding regardless of the proposal's
      fate; we never tear that down.
    * Any spec bound to ANOTHER non-terminal proposal — the
      sibling deal is still in flight and needs the spec intact.
      Ripping the signatures out would break the parallel proposal.

    Note: customer signature fields (``customer_*``) are also
    preserved — a customer-signed spec is already terminal
    (``ACCEPTED``) and won't reach this branch anyway, but keeping
    the defensive check means we never accidentally destroy
    customer identity captured at kiosk.

    Returns the list of reverted sheets so callers can audit the
    cleanup count.
    """

    from apps.specifications.services import SpecificationStatus

    reverted: list[SpecificationSheet] = []
    # Sheets in every non-terminal state get bounced. We only skip
    # the terminal customer-signed lane (``ACCEPTED``) and sheets
    # bound to a still-live sibling proposal.
    resettable_statuses = {
        SpecificationStatus.DRAFT,
        SpecificationStatus.IN_REVIEW,
        SpecificationStatus.APPROVED,
        SpecificationStatus.SENT,
        SpecificationStatus.REJECTED,
    }
    for sheet in _attached_spec_sheets(proposal):
        if sheet.status not in resettable_statuses:
            continue
        # Look for ANY other proposal that still references this
        # spec and is not terminal. ``REJECTED`` doesn't count
        # (it's just been declared dead — same regime we're in
        # now); ``ACCEPTED`` doesn't count (signed; the spec
        # itself moves to ``ACCEPTED`` so it wouldn't be at
        # ``SENT`` to begin with).
        attached_via_line = Proposal.objects.filter(
            lines__specification_sheet=sheet,
        )
        attached_via_legacy = Proposal.objects.filter(
            specification_sheet=sheet,
        )
        other_live_exists = (
            (attached_via_line | attached_via_legacy)
            .exclude(id=proposal.id)
            .exclude(
                status__in=(
                    ProposalStatus.REJECTED.value,
                    ProposalStatus.ACCEPTED.value,
                ),
            )
            .exists()
        )
        if other_live_exists:
            continue

        previous_status = sheet.status
        before = {
            "status": sheet.status,
            "director_signed_at": (
                sheet.director_signed_at.isoformat()
                if sheet.director_signed_at
                else None
            ),
            "prepared_by_signed_at": (
                sheet.prepared_by_signed_at.isoformat()
                if sheet.prepared_by_signed_at
                else None
            ),
        }
        sheet.status = SpecificationStatus.DRAFT
        # Clear both internal signatures — director AND scientist —
        # so the rework starts from a truly clean slate. Without
        # this, the sheet would look "approved" in every UI even
        # though its status says DRAFT (stale signatures leak into
        # the header banners and the audit trail).
        sheet.prepared_by_signature_image = ""
        sheet.prepared_by_signed_at = None
        sheet.prepared_by_user = None
        sheet.director_signature_image = ""
        sheet.director_signed_at = None
        sheet.director_user = None
        sheet.updated_by = actor
        sheet.save(
            update_fields=[
                "status",
                "prepared_by_signature_image",
                "prepared_by_signed_at",
                "prepared_by_user",
                "director_signature_image",
                "director_signed_at",
                "director_user",
                "updated_by",
                "updated_at",
            ]
        )
        record_audit(
            organization=sheet.organization,
            actor=actor,
            action="spec_sheet.reverted_after_proposal_rejection",
            target=sheet,
            before=before,
            after={
                "status": sheet.status,
                "proposal_id": str(proposal.id),
            },
        )

        # If the sheet was APPROVED (or beyond) at the point of
        # rejection, tell PSP to clear ``npd_spec_approved_at`` on
        # the mirrored CO. The specifications-side ``transition_status``
        # normally fires this on ``APPROVED → not-APPROVED``, but we
        # bypass that machinery here with a raw save. Mirror the
        # same on-commit hook so PSP flips back to ``:r_and_d``.
        if previous_status in {
            SpecificationStatus.APPROVED,
            SpecificationStatus.SENT,
        }:
            formulation = sheet.formulation_version.formulation

            def _fire_spec_cleared_sync(f=formulation) -> None:
                from apps.psp.services import sync_customer_order_to_psp

                try:
                    sync_customer_order_to_psp(
                        formulation=f, spec_cleared=True
                    )
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "proposal-reject: spec-cleared sync bubbled "
                        "for formulation %s",
                        f.pk,
                    )

            transaction.on_commit(_fire_spec_cleared_sync)

        reverted.append(sheet)
    return reverted


def _backfill_customer_from_proposal(
    *, proposal: Proposal, actor: Any
) -> None:
    """Fill in any blank customer contact fields with whatever the
    proposal carries.

    The address book is the source of truth ONCE a value is set —
    we only patch blanks, never overwrite. Mirrors the on-send
    email back-fill (:func:`send_proposal_to_client`) but for the
    broader set of contact fields, and on the create path so the
    address book gets populated as the team works rather than only
    on the first dispatch. Touches email, phone, invoice_address,
    delivery_address; never the identity fields (name, company)
    since those are how the operator picked the customer in the
    first place.
    """

    customer = proposal.customer
    if customer is None:
        return

    field_pairs = (
        ("email", (proposal.customer_email or "").strip()),
        ("phone", (proposal.customer_phone or "").strip()),
        ("invoice_address", (proposal.invoice_address or "").strip()),
        ("delivery_address", (proposal.delivery_address or "").strip()),
    )
    candidates: dict[str, str] = {}
    for field, value in field_pairs:
        if not value:
            continue
        if (getattr(customer, field) or "").strip():
            continue
        candidates[field] = value

    if not candidates:
        return

    before = {k: getattr(customer, k) or "" for k in candidates}
    for field, value in candidates.items():
        setattr(customer, field, value)
    customer.updated_by = actor
    customer.save(
        update_fields=[*candidates.keys(), "updated_by", "updated_at"],
    )
    record_audit(
        organization=customer.organization,
        actor=actor,
        action="customer.backfilled_from_proposal",
        target=customer,
        before=before,
        after={
            **candidates,
            "source_proposal_id": str(proposal.id),
        },
    )


def get_proposal_by_public_token(token: Any) -> Proposal:
    """Resolve a proposal by its public kiosk token.

    Raises :class:`ProposalPublicLinkNotEnabled` (mapped to 404) when
    the token is unknown or the proposal has had its link revoked —
    we deliberately conflate "never shared" and "revoked" so a stale
    link leaks no signal about the proposal's current state.
    """

    if token in (None, ""):
        raise ProposalPublicLinkNotEnabled()
    proposal = Proposal.objects.filter(public_token=token).first()
    if proposal is None:
        raise ProposalPublicLinkNotEnabled()
    return proposal


class ProposalAcknowledgementsRequired(Exception):
    """Customer attempted to sign the proposal without ticking every
    acknowledgement checkbox (spec signing / lead times / terms).
    The kiosk surfaces a 400 with a code the i18n layer translates."""

    code = "proposal_acknowledgements_required"


@transaction.atomic
def capture_customer_signature_on_proposal(
    *,
    proposal: Proposal,
    signer_name: str,
    signer_email: str,
    signer_company: str,
    signature_image: str,
    ack_spec_signing: bool = False,
    ack_lead_times: bool = False,
    ack_terms: bool = False,
    ack_rd_terms: bool = False,
    sign_ip: str = "",
    sign_user_agent: str = "",
    sign_document_hash: str = "",
) -> Proposal:
    """Record a customer signature on the proposal without moving it
    to ``accepted``. Used by the proposal-centric kiosk where many
    documents are signed before any advances — a partial sign must
    not push the proposal to terminal state.

    Idempotent: resigning overwrites the stored image and timestamp so
    a client who scribbled the first time can redraw without us
    needing a separate "reset signature" endpoint.

    Acknowledgement tickboxes the rendered HTML flips ☐ → ☑ once
    the customer signs:

    * ``ack_spec_signing`` — always required (every template).
    * ``ack_lead_times`` — always required.
    * ``ack_terms`` — always required.
    * ``ack_rd_terms`` — required ONLY for ``custom`` proposals; the
      Ready-to-Go template has no R&D phase and skips this row.

    Any required ack missing raises :class:`ProposalAcknowledgementsRequired`.
    """

    if proposal.status != ProposalStatus.SENT.value:
        raise InvalidProposalTransition()

    required_acks = ack_spec_signing and ack_lead_times and ack_terms
    if proposal.template_type == ProposalTemplateType.CUSTOM.value:
        required_acks = required_acks and ack_rd_terms
    if not required_acks:
        raise ProposalAcknowledgementsRequired()

    normalised_image = validate_signature_image(signature_image)
    name = (signer_name or "").strip()
    if not name:
        raise SignatureRequired()

    proposal.customer_signer_name = name
    proposal.customer_signer_email = (signer_email or "").strip()
    proposal.customer_signer_company = (signer_company or "").strip()
    proposal.customer_signature_image = normalised_image
    proposal.customer_signed_at = timezone.now()
    proposal.customer_sign_ip = (sign_ip or "")[:45]
    proposal.customer_sign_user_agent = sign_user_agent or ""
    proposal.customer_sign_document_hash = (sign_document_hash or "")[:64]
    proposal.ack_spec_signing = bool(ack_spec_signing)
    proposal.ack_lead_times = bool(ack_lead_times)
    proposal.ack_terms = bool(ack_terms)
    proposal.ack_rd_terms = bool(ack_rd_terms)
    proposal.save(
        update_fields=[
            "customer_signer_name",
            "customer_signer_email",
            "customer_signer_company",
            "customer_signature_image",
            "customer_signed_at",
            "customer_sign_ip",
            "customer_sign_user_agent",
            "customer_sign_document_hash",
            "ack_spec_signing",
            "ack_lead_times",
            "ack_terms",
            "ack_rd_terms",
            "updated_at",
        ]
    )
    record_audit(
        organization=proposal.organization,
        actor=proposal.updated_by,
        action="proposal.kiosk_sign",
        target=proposal,
        after={
            "signer_name": name,
            "sign_ip": proposal.customer_sign_ip,
            "sign_user_agent": proposal.customer_sign_user_agent,
            "sign_document_hash": proposal.customer_sign_document_hash,
        },
    )
    # Push signed_at through to the PSP mirror so the kanban card
    # moves from "Sent to client" to "Choose samples" the moment the
    # signature lands. Previously the mirror only refreshed on
    # sample-selection confirm, leaving the card sitting on the sign
    # column until the customer picked their sample count.
    _schedule_proposal_psp_merge(proposal)
    return proposal


@transaction.atomic
def capture_customer_signature_on_attached_spec(
    *,
    proposal: Proposal,
    sheet_id: Any,
    signer_name: str,
    signer_email: str,
    signer_company: str,
    signature_image: str,
    sign_ip: str = "",
    sign_user_agent: str = "",
    sign_document_hash: str = "",
) -> SpecificationSheet:
    """Record a customer signature on one spec sheet attached to this
    proposal. Same semantics as
    :func:`capture_customer_signature_on_proposal` — signature lands,
    status stays ``sent`` until the finalize call runs.

    Validates that ``sheet_id`` is actually attached to ``proposal``
    so a crafted URL can't stamp a signature onto an unrelated sheet
    the signer never saw.
    """

    attached = _attached_spec_sheets(proposal)
    sheet = next((s for s in attached if str(s.id) == str(sheet_id)), None)
    if sheet is None:
        raise KioskSpecNotOnProposal()

    # Reuse the spec-app's validator + domain errors so the kiosk
    # error codes match the existing spec-kiosk path.
    from apps.specifications.services import (
        SpecificationStatus,
        InvalidStatusTransition as SpecInvalidStatusTransition,
    )

    # Safety net for bundles that were sent to the client before the
    # eager promotion in :func:`transition_status` existed. The spec
    # legitimately rides the proposal's lifecycle once bundled, so
    # if the proposal itself is ``SENT`` we pull the sheet along.
    if (
        sheet.status != SpecificationStatus.SENT
        and proposal.status == ProposalStatus.SENT.value
    ):
        _promote_attached_specs_to_sent(
            proposal=proposal, actor=sheet.updated_by
        )
        sheet.refresh_from_db()

    if sheet.status != SpecificationStatus.SENT:
        raise SpecInvalidStatusTransition()

    normalised_image = validate_signature_image(signature_image)
    name = (signer_name or "").strip()
    if not name:
        raise SignatureRequired()

    sheet.customer_name = name
    sheet.customer_email = (signer_email or "").strip()
    sheet.customer_company = (signer_company or "").strip()
    sheet.customer_signature_image = normalised_image
    sheet.customer_signed_at = timezone.now()
    sheet.customer_sign_ip = (sign_ip or "")[:45]
    sheet.customer_sign_user_agent = sign_user_agent or ""
    sheet.customer_sign_document_hash = (sign_document_hash or "")[:64]
    sheet.save(
        update_fields=[
            "customer_name",
            "customer_email",
            "customer_company",
            "customer_signature_image",
            "customer_signed_at",
            "customer_sign_ip",
            "customer_sign_user_agent",
            "customer_sign_document_hash",
            "updated_at",
        ]
    )
    record_audit(
        organization=sheet.organization,
        actor=sheet.updated_by,
        action="spec_sheet.kiosk_sign",
        target=sheet,
        after={
            "signer_name": name,
            "proposal_id": str(proposal.id),
            "sign_ip": sheet.customer_sign_ip,
            "sign_user_agent": sheet.customer_sign_user_agent,
            "sign_document_hash": sheet.customer_sign_document_hash,
        },
    )
    return sheet


@transaction.atomic
def capture_customer_rejection_on_proposal(
    *,
    proposal: Proposal,
    reason: str = "",
) -> Proposal:
    """Mark a proposal as ``rejected`` because the customer declined
    via the kiosk's "Decline" button.

    The action is one-way: a rejected proposal is terminal and the
    state machine refuses any further edge. Only callable when the
    proposal is currently at ``sent`` — declining a draft or an
    already-accepted proposal is nonsense and would corrupt the
    audit trail.

    The optional ``reason`` is the free-text the customer typed in
    the modal. Empty when they declined without explaining.

    Fires an email notification to the sales person *after* the
    transaction commits (via :func:`transaction.on_commit`) so a
    later assertion in the same atomic block that rolls everything
    back doesn't email the team about a rejection that didn't
    actually land. Mirrors the comment-notifications pattern.
    """

    if proposal.status != ProposalStatus.SENT.value:
        raise InvalidProposalTransition()

    cleaned_reason = (reason or "").strip()
    before = snapshot(proposal)
    from_status = proposal.status

    proposal.status = ProposalStatus.REJECTED.value
    proposal.customer_rejected_at = timezone.now()
    proposal.customer_rejection_reason = cleaned_reason
    proposal.save(
        update_fields=[
            "status",
            "customer_rejected_at",
            "customer_rejection_reason",
            "updated_at",
        ]
    )

    ProposalStatusTransition.objects.create(
        proposal=proposal,
        from_status=from_status,
        to_status=ProposalStatus.REJECTED.value,
        actor=proposal.updated_by,
        notes=(
            f"Customer declined via kiosk: {cleaned_reason[:200]}"
            if cleaned_reason
            else "Customer declined via kiosk"
        ),
    )
    record_audit(
        organization=proposal.organization,
        actor=proposal.updated_by,
        action="proposal.kiosk_rejected",
        target=proposal,
        before=before,
        after=snapshot(proposal),
    )

    # Free the attached specs so the team can spawn another
    # proposal against the same recipe. Same helper the staff
    # manual-reject path uses; see its docstring for the
    # "leave ACCEPTED / sibling-live specs alone" rules.
    _revert_attached_specs_after_rejection(
        proposal=proposal, actor=proposal.updated_by,
    )

    # Notify the sales person *after* the transaction commits — the
    # email is best-effort (SMTP failures must not undo a genuine
    # customer rejection). ``on_commit`` guarantees the proposal row
    # is durable before the task is enqueued so a Celery worker
    # pulling the job immediately won't 404 on lookup.
    #
    # In eager mode (no broker configured) the ``.delay()`` body
    # runs synchronously inside the on_commit callback — same
    # observable behaviour as the previous direct call. With a real
    # broker, the kiosk response returns the moment the rejection
    # commits and the email round-trip happens on a worker.
    proposal_id = proposal.id

    def _dispatch_rejection_email() -> None:
        from apps.proposals.tasks import (
            send_proposal_rejection_notification_task,
        )

        try:
            send_proposal_rejection_notification_task.delay(
                str(proposal_id)
            )
        except Exception:  # noqa: BLE001
            # Eager-mode failure path. The task already retried + logged
            # internally; swallow so an SMTP blip doesn't bubble up
            # as an unhandled error to the kiosk.
            pass

    transaction.on_commit(_dispatch_rejection_email)
    return proposal


@transaction.atomic
def finalize_proposal_kiosk(*, proposal: Proposal) -> dict[str, Any]:
    """Advance the proposal + every attached spec from ``sent`` to
    ``accepted`` once every document has a captured signature.

    Raises :class:`KioskSignaturesPending` with the list of pending
    document ids so the kiosk can scroll the client back to the
    missing ones. The "all-or-nothing" rule is a legal requirement —
    a half-signed deal where the proposal is accepted but a spec
    isn't gives the client grounds to dispute the product terms
    ("I signed the price but never saw the final spec").

    Idempotent on a proposal that's already ``accepted`` — the call
    becomes a no-op instead of blowing up, so a double-click on the
    finalize button doesn't surface an error.
    """

    if proposal.status == ProposalStatus.ACCEPTED.value:
        return {"status": proposal.status, "already_finalized": True}

    if proposal.status != ProposalStatus.SENT.value:
        raise InvalidProposalTransition()

    attached_specs = _attached_spec_sheets(proposal)

    pending: list[str] = []
    if proposal.customer_signed_at is None:
        pending.append(f"proposal:{proposal.id}")
    for sheet in attached_specs:
        if sheet.customer_signed_at is None:
            pending.append(f"spec:{sheet.id}")

    if pending:
        raise KioskSignaturesPending(pending)

    from apps.formulations.models import ProjectStatus
    from apps.formulations.services import _maybe_advance_project_status
    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationStatus,
        SpecificationTransition,
    )

    previous_proposal_status = proposal.status
    proposal.status = ProposalStatus.ACCEPTED.value
    proposal.save(update_fields=["status", "updated_at"])
    ProposalStatusTransition.objects.create(
        proposal=proposal,
        from_status=previous_proposal_status,
        to_status=ProposalStatus.ACCEPTED.value,
        actor=proposal.updated_by,
        notes="Kiosk finalize",
    )
    record_audit(
        organization=proposal.organization,
        actor=proposal.updated_by,
        action="proposal.kiosk_finalize",
        target=proposal,
        before={"status": previous_proposal_status},
        after={"status": proposal.status},
    )

    for sheet in attached_specs:
        if sheet.status == SpecificationStatus.ACCEPTED:
            continue
        previous_sheet_status = sheet.status
        sheet.status = SpecificationStatus.ACCEPTED
        sheet.save(update_fields=["status", "updated_at"])
        SpecificationTransition.objects.create(
            sheet=sheet,
            from_status=previous_sheet_status,
            to_status=SpecificationStatus.ACCEPTED,
            actor=sheet.updated_by,
            notes="Kiosk finalize (via proposal)",
        )
        record_audit(
            organization=sheet.organization,
            actor=sheet.updated_by,
            action="spec_sheet.kiosk_finalize",
            target=sheet,
            before={"status": previous_sheet_status},
            after={"status": sheet.status, "proposal_id": str(proposal.id)},
        )

        # Mirror the spec-only kiosk path's roadmap-chip rule (see
        # ``accept_as_customer`` in apps.specifications.services): a
        # customer-signed draft moves the formulation chip from
        # ``in_development`` → ``pilot``; a customer-signed final goes
        # all the way to ``approved``. Forward-only via
        # :func:`_maybe_advance_project_status` so a previously-
        # approved project can never slip back.
        target_status: str | None = None
        if sheet.document_kind == SpecificationDocumentKind.DRAFT:
            target_status = ProjectStatus.PILOT.value
        elif sheet.document_kind == SpecificationDocumentKind.FINAL:
            target_status = ProjectStatus.APPROVED.value
        if target_status is not None:
            _maybe_advance_project_status(
                formulation=sheet.formulation_version.formulation,
                target_status=target_status,
                actor=sheet.updated_by,
            )

    # Push the accepted status + timestamps + timeline to PSP so the
    # mirrored CO advances from :awaiting_customer_signature into
    # :proposal_accepted. The staff-side ``transition_status`` fires
    # this on every edge — the kiosk-finalize path skips that
    # machinery, so we have to plant the sync explicitly. Without
    # this call PSP's ``npd_proposal_status`` stays at "sent" even
    # after the customer has signed, and the wizard column doesn't
    # advance.
    _schedule_proposal_psp_merge(proposal)

    # Deposit gate: signing no longer materialises a placeholder
    # Payment row. Finance records the payment themselves off the
    # "Awaiting payment · Deposits" queue on ``/finance/payments``
    # once the money lands. Payment rows should represent real
    # money-in events, not "we're expecting money" placeholders.

    return {
        "status": proposal.status,
        "attached_specs": [
            {"id": str(s.id), "status": s.status} for s in attached_specs
        ],
        "already_finalized": False,
    }
