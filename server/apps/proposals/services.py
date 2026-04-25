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
import uuid
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction
from django.db.models import QuerySet
from django.utils import timezone

from apps.audit.services import record as record_audit, snapshot
from apps.formulations.models import Formulation, FormulationVersion
from apps.organizations.models import Organization
from apps.proposals.models import (
    Proposal,
    ProposalLine,
    ProposalStatus,
    ProposalStatusTransition,
    ProposalTemplateType,
)
from apps.specifications.models import SpecificationSheet
from config.signatures import SignatureImageInvalid, validate_signature_image


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ProposalNotFound(Exception):
    code = "proposal_not_found"


class FormulationVersionNotInOrg(Exception):
    code = "formulation_version_not_in_org"


class SpecificationSheetNotInOrg(Exception):
    code = "specification_sheet_not_in_org"


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
) -> QuerySet[Proposal]:
    """Return the org's proposals, newest first.

    ``formulation_id`` scopes down to one project's proposals so the
    project workspace's panel can render without a second query.
    """

    queryset = Proposal.objects.filter(organization=organization)
    if formulation_id is not None:
        queryset = queryset.filter(
            formulation_version__formulation_id=formulation_id
        )
    return queryset.select_related(
        "formulation_version__formulation",
        "specification_sheet",
        "created_by",
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
    material_cost_per_pack: Decimal | None = None,
    cover_notes: str = "",
    valid_until: Any = None,
) -> Proposal:
    """Plan a new proposal against a saved formulation version.

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

    sheet: SpecificationSheet | None = None
    if specification_sheet_id is not None:
        sheet = (
            SpecificationSheet.objects.filter(id=specification_sheet_id).first()
        )
        if sheet is None or sheet.organization_id != organization.id:
            raise SpecificationSheetNotInOrg()

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
    if unit_price is None:
        unit_price = suggest_unit_price(material_cost, margin_percent)

    if valid_until is None:
        valid_until = (timezone.now().date() + timedelta(days=14))

    proposal = Proposal.objects.create(
        organization=organization,
        formulation_version=version,
        specification_sheet=sheet,
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
    "material_cost_per_pack",
    "cover_notes",
    "valid_until",
    "template_type",
)


@transaction.atomic
def update_proposal(
    *, proposal: Proposal, actor: Any, **changes: Any
) -> Proposal:
    before = snapshot(proposal)

    # ``specification_sheet_id`` / ``customer_id`` are FKs, not free
    # fields. Pop them off ``changes`` so the flat-loop below doesn't
    # try to setattr them as strings. ``None`` detaches the link.
    if "specification_sheet_id" in changes:
        sheet_id = changes.pop("specification_sheet_id")
        if sheet_id is None:
            proposal.specification_sheet = None
        else:
            sheet = SpecificationSheet.objects.filter(id=sheet_id).first()
            if sheet is None or sheet.organization_id != proposal.organization_id:
                raise SpecificationSheetNotInOrg()
            proposal.specification_sheet = sheet
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
        sheet = SpecificationSheet.objects.filter(
            id=specification_sheet_id
        ).first()
        if sheet is None or sheet.organization_id != proposal.organization_id:
            raise SpecificationSheetNotInOrg()

    if display_order is None:
        display_order = proposal.lines.count()

    line = ProposalLine.objects.create(
        proposal=proposal,
        formulation_version=version,
        specification_sheet=sheet,
        product_code=product_code,
        description=description,
        quantity=max(1, int(quantity)),
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
    line = proposal.lines.filter(id=line_id).first()
    if line is None:
        raise ProposalLineNotFound()

    # ``specification_sheet_id`` needs the cross-tenant FK check; the
    # rest is a flat setattr loop over the model's writable columns.
    if "specification_sheet_id" in changes:
        sheet_id = changes.pop("specification_sheet_id")
        if sheet_id is None:
            line.specification_sheet = None
        else:
            sheet = SpecificationSheet.objects.filter(id=sheet_id).first()
            if sheet is None or sheet.organization_id != proposal.organization_id:
                raise SpecificationSheetNotInOrg()
            line.specification_sheet = sheet

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
        "customer_name",
        "customer_email",
        "sales_person",
        "lines",
    ),
    (ProposalStatus.IN_REVIEW.value, ProposalStatus.APPROVED.value): (
        "customer_name",
        "customer_email",
        "sales_person",
        "lines",
    ),
    (ProposalStatus.APPROVED.value, ProposalStatus.SENT.value): (
        "customer_name",
        "customer_email",
        "dear_name",
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

    proposal.status = to_status
    proposal.updated_by = actor
    proposal.save()

    # When the proposal is sent to the client, pull every attached
    # spec into ``SENT`` alongside it. The kiosk signs the whole
    # bundle at once and gates on each document being ``SENT``, so
    # leaving a bundled spec in ``DRAFT`` / ``APPROVED`` would
    # silently lock the client out of signing that document.
    if to_status == ProposalStatus.SENT.value:
        _promote_attached_specs_to_sent(proposal=proposal, actor=actor)

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
    return proposal


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


@transaction.atomic
def capture_customer_signature_on_proposal(
    *,
    proposal: Proposal,
    signer_name: str,
    signer_email: str,
    signer_company: str,
    signature_image: str,
) -> Proposal:
    """Record a customer signature on the proposal without moving it
    to ``accepted``. Used by the proposal-centric kiosk where many
    documents are signed before any advances — a partial sign must
    not push the proposal to terminal state.

    Idempotent: resigning overwrites the stored image and timestamp so
    a client who scribbled the first time can redraw without us
    needing a separate "reset signature" endpoint.
    """

    if proposal.status != ProposalStatus.SENT.value:
        raise InvalidProposalTransition()

    normalised_image = validate_signature_image(signature_image)
    name = (signer_name or "").strip()
    if not name:
        raise SignatureRequired()

    proposal.customer_signer_name = name
    proposal.customer_signer_email = (signer_email or "").strip()
    proposal.customer_signer_company = (signer_company or "").strip()
    proposal.customer_signature_image = normalised_image
    proposal.customer_signed_at = timezone.now()
    proposal.save(
        update_fields=[
            "customer_signer_name",
            "customer_signer_email",
            "customer_signer_company",
            "customer_signature_image",
            "customer_signed_at",
            "updated_at",
        ]
    )
    record_audit(
        organization=proposal.organization,
        actor=proposal.updated_by,
        action="proposal.kiosk_sign",
        target=proposal,
        after={"signer_name": name},
    )
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
    sheet.save(
        update_fields=[
            "customer_name",
            "customer_email",
            "customer_company",
            "customer_signature_image",
            "customer_signed_at",
            "updated_at",
        ]
    )
    record_audit(
        organization=sheet.organization,
        actor=sheet.updated_by,
        action="spec_sheet.kiosk_sign",
        target=sheet,
        after={"signer_name": name, "proposal_id": str(proposal.id)},
    )
    return sheet


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

    from apps.specifications.models import (
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

    return {
        "status": proposal.status,
        "attached_specs": [
            {"id": str(s.id), "status": s.status} for s in attached_specs
        ],
        "already_finalized": False,
    }
