"""Portal cart checkout — orchestrate proposal + payments split.

Called from ``POST /api/portal/checkout/`` when a marketing-site
customer clicks *Place order* on ``/cart``. Splits the cart by
line kind:

* ``product`` lines → each gets its OWN draft :class:`Proposal`
  with ``template_type=READY_TO_GO`` and a per-order clone of the
  formulation's FINAL spec sheet. One line per proposal so a
  customer picking two combos of the same SKU produces two
  independent quotes (different packaging → different signed
  spec + different deposit gate). Status stays ``DRAFT`` — sales
  owns Send.

* ``sample`` lines → each gets an individual PENDING
  :class:`Payment` attached to the sample's formulation. Finance
  sees them in the pending-payments queue and completes method +
  external reference + amount confirmation before approving.

Customer-detail overrides captured on the checkout modal are
written to each *proposal* only — the customer's saved settings
are NOT PATCHed silently. Changing saved defaults still goes
through ``/portal/settings``.

Mirrors the pattern of
:func:`apps.cff_submissions.services.create_portal_rtg_submission`
(which handles single-line RTG portal submits) but scales to the
multi-line cart case by fanning out to one Proposal per line.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone as django_timezone

from apps.client_portal.models import ClientAccount
from apps.formulations.models import (
    Formulation,
    FormulationVersion,
    PackagingCombo,
)
from apps.payments.constants import PaymentKind, PaymentMethod
from apps.payments.services import record_payment
from apps.proposals.models import (
    Proposal,
    ProposalLine,
    ProposalStatus,
    ProposalTemplateType,
)
from apps.proposals.services import (
    _generate_unique_code,
    compute_material_cost_per_pack,
)
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)
from apps.specifications.services import PACKAGING_SLOT_TYPES


CartKind = Literal["product", "sample"]


class CheckoutError(Exception):
    """Raised on invalid checkout input.

    ``code`` mirrors the shape of the other portal service errors
    so the DRF view can convert it into a ``{code, message}`` 4xx
    without a special case per subclass.
    """

    code: str = "checkout_invalid"


@dataclass(frozen=True)
class CheckoutLineInput:
    kind: CartKind
    formulation_id: str
    quantity: int
    unit_price: Decimal
    currency_code: str
    packaging_combo_id: str | None


@dataclass(frozen=True)
class CheckoutInput:
    lines: list[CheckoutLineInput]
    name: str
    company: str
    phone: str
    invoice_address: str
    delivery_address: str


@dataclass(frozen=True)
class CheckoutResult:
    #: One proposal per product cart line. Empty when the checkout was
    #: samples-only. Order matches the incoming ``payload.lines`` order
    #: so a FE deep-link like ``/portal/orders/#PROP-0010`` can walk the
    #: list in the same sequence the customer saw at cart time.
    proposal_ids: list[str] = field(default_factory=list)
    payment_ids: list[str] = field(default_factory=list)


@transaction.atomic
def place_portal_checkout(
    *,
    account: ClientAccount,
    payload: CheckoutInput,
) -> CheckoutResult:
    """Route each line to its correct destination.

    Product lines fan out to one Proposal per line so a customer
    ordering the same SKU in two different packaging combos gets
    two independent quotes (each with its own signed spec sheet
    and deposit gate). Sample lines each get one PENDING payment.
    """

    customer = account.customer
    if customer is None:
        exc = CheckoutError(
            "Your account isn't linked to a customer record.",
        )
        exc.code = "no_customer"
        raise exc

    if not payload.lines:
        exc = CheckoutError("Your cart is empty.")
        exc.code = "empty_cart"
        raise exc

    product_lines = [l for l in payload.lines if l.kind == "product"]
    sample_lines = [l for l in payload.lines if l.kind == "sample"]

    proposal_ids: list[str] = []
    for line in product_lines:
        proposal = _create_line_proposal(
            customer=customer,
            line=line,
            payload=payload,
        )
        proposal_ids.append(str(proposal.pk))

    payment_ids: list[str] = []
    for line in sample_lines:
        payment = _create_sample_payment(customer=customer, line=line)
        payment_ids.append(str(payment.pk))

    return CheckoutResult(proposal_ids=proposal_ids, payment_ids=payment_ids)


# ---------------------------------------------------------------------------
# Product path — one Proposal per cart line, each with its own spec clone
# ---------------------------------------------------------------------------


def _create_line_proposal(
    *,
    customer,
    line: CheckoutLineInput,
    payload: CheckoutInput,
) -> Proposal:
    """One draft RTG :class:`Proposal` for a single cart line.

    Each cart line gets its own quote so a customer picking two
    packaging combos of the same SKU ends up with two independent
    proposals — separate signed spec sheets, separate deposit gates,
    separate accept flows. Merging them into a bundled proposal
    would force the customer to accept-or-reject both packagings
    together and would push the picked combo onto a single spec
    sheet slot (which can only carry one combination).
    """

    formulation = _resolve_formulation(line.formulation_id)
    version = _resolve_version(formulation)
    combo = (
        _resolve_combo(line.packaging_combo_id)
        if line.packaging_combo_id
        else None
    )
    proposal_actor = _resolve_actor(customer)

    # Cost + margin resolution mirrors ``apps.proposals.services
    # .create_proposal``: prefer the director-signed spec sheet's
    # numbers (that's the "single source of truth" the sales team
    # agreed on) and fall back to the raw-material roll-up when the
    # spec has none. Without this the finance edit table renders
    # blank UNIT COST / MARGIN % on every storefront quote because
    # the raw materials on most RTG SKUs aren't costed line-by-line
    # in the ingredient catalogue.
    template_sheet = _find_template_final_sheet(formulation)
    material_cost = _resolve_material_cost(version, template_sheet)
    material_cost_positive = (
        material_cost if material_cost and material_cost > 0 else None
    )
    margin_percent = (
        template_sheet.margin_percent if template_sheet is not None else None
    )

    proposal = Proposal.objects.create(
        organization=customer.organization,
        formulation_version=version,
        customer=customer,
        code=_generate_unique_code(customer.organization),
        template_type=ProposalTemplateType.READY_TO_GO,
        status=ProposalStatus.DRAFT,
        # Denormalized customer fields — the modal captured these
        # for THIS order. We do NOT write them back to Customer or
        # ClientAccount (that's an explicit /portal/settings action).
        customer_name=payload.name or (customer.name or ""),
        customer_email=customer.email or "",
        customer_phone=payload.phone or (getattr(customer, "phone", "") or ""),
        customer_company=payload.company or (customer.company or ""),
        invoice_address=payload.invoice_address,
        delivery_address=payload.delivery_address,
        dear_name=payload.name or (customer.name or ""),
        reference="",  # populated below once code exists on the row
        currency=(line.currency_code or "GBP").upper()[:3],
        quantity=max(1, line.quantity),
        unit_price=line.unit_price,
        material_cost_per_pack=material_cost_positive,
        margin_percent=margin_percent,
        cover_notes=(
            "Auto-drafted from the storefront cart. Review the line "
            "and packaging combo below before hitting Send."
        ),
        created_by=proposal_actor,
        updated_by=proposal_actor,
    )
    proposal.reference = proposal.code
    proposal.save(update_fields=["reference"])

    # Attach a per-order clone of the formulation's FINAL sheet with
    # the customer's chosen combo baked into its packaging slots.
    # ``Proposal.specification_sheet`` is OneToOne — sharing the
    # template with two customers would race on customer-accept.
    # The clone inherits the pre-signed template's approved status
    # (prep + director signatures) so sales / the kiosk can render
    # both docs together at Send time.
    cloned_sheet = _clone_final_sheet_for_checkout(
        formulation=formulation,
        formulation_version=version,
        proposal=proposal,
        actor=proposal_actor,
        payload=payload,
        combo=combo,
        template=template_sheet,
    )
    if cloned_sheet is not None:
        proposal.specification_sheet = cloned_sheet
        proposal.save(update_fields=["specification_sheet"])

    ProposalLine.objects.create(
        proposal=proposal,
        formulation_version=version,
        specification_sheet=cloned_sheet,
        product_code=formulation.code or "",
        description=_line_description(formulation, combo),
        quantity=max(1, line.quantity),
        unit_cost=material_cost_positive,
        unit_price=line.unit_price,
        display_order=0,
        selected_packaging_combo=combo,
    )
    return proposal


def _resolve_material_cost(
    version: FormulationVersion,
    sheet: SpecificationSheet | None,
) -> Decimal:
    """Prefer the spec sheet's signed cost, fall back to the raw-
    material roll-up.

    Spec sheets carry an explicit ``unit_cost`` the director enters
    (or derived at signing time via ``final_price × (1 − margin/100)``
    for legacy sheets that only stored the price). That number is
    the "single source of truth" the sales team agreed on and is
    the one that actually feeds the customer's quote — the raw-
    material roll-up is only useful as a fallback for SKUs where
    the director hasn't yet signed a costed spec.
    """

    if sheet is not None:
        if sheet.unit_cost is not None:
            return Decimal(sheet.unit_cost)
        margin = sheet.margin_percent
        final_price = sheet.final_price
        if final_price is not None and margin is not None:
            margin_dec = Decimal(margin)
            if margin_dec < Decimal("100"):
                factor = (Decimal("100") - margin_dec) / Decimal("100")
                return (Decimal(final_price) * factor).quantize(Decimal("0.0001"))
    return compute_material_cost_per_pack(version)


# ---------------------------------------------------------------------------
# Sample path — one PENDING Payment per sample line
# ---------------------------------------------------------------------------


def _create_sample_payment(*, customer, line: CheckoutLineInput):
    """Drop a ``PENDING`` :class:`Payment` for finance to complete."""

    formulation = _resolve_formulation(line.formulation_id)
    actor = _resolve_actor(customer)
    return record_payment(
        actor=actor,
        amount=line.unit_price,
        paid_at=django_timezone.now(),
        # FINAL is the per-formulation payment kind (matches the
        # sample-shipping flow). DEPOSIT is for proposal-bundle
        # advance payments — not what a sample kit needs.
        kind=PaymentKind.FINAL,
        formulation=formulation,
        # Storefront RTG SKUs aren't linked to a specific customer,
        # so ``record_payment``'s default resolver would leave the
        # column blank on sample rows. Pass the checkout account's
        # customer explicitly so finance sees the buyer on the card.
        customer=customer,
        # Placeholder method — finance flips this to the actual
        # method (Stripe, card link, cash on delivery) when they
        # process the transfer. Bank transfer is the shop's default
        # per company settings.
        method=PaymentMethod.BANK_TRANSFER,
        currency=(line.currency_code or "GBP").upper()[:3],
        notes=(
            f"Sample kit requested by {customer.email or 'portal customer'} "
            f"via storefront checkout. Awaiting finance confirmation."
        ),
    )


# ---------------------------------------------------------------------------
# Small resolvers
# ---------------------------------------------------------------------------


def _resolve_formulation(formulation_id: str) -> Formulation:
    try:
        return Formulation.objects.get(pk=UUID(str(formulation_id)))
    except (Formulation.DoesNotExist, ValueError, TypeError) as exc:
        err = CheckoutError(f"Unknown product ({formulation_id}).")
        err.code = "unknown_formulation"
        raise err from exc


def _resolve_version(formulation: Formulation) -> FormulationVersion:
    """Prefer the pinned approved version, fall back to any version.

    Approval on a Formulation lives on ``approved_version_number``
    (not on a boolean flag per version — see the RTG portal-submit
    service which uses this exact pattern). Falling back to the
    latest version keeps a mis-configured RTG (published without a
    signed approval) from 500-ing the checkout; staff can retriage.
    """

    approved_number = getattr(formulation, "approved_version_number", None)
    version: FormulationVersion | None = None
    if approved_number is not None:
        version = (
            FormulationVersion.objects
            .filter(formulation=formulation, version_number=approved_number)
            .first()
        )
    if version is None:
        version = (
            FormulationVersion.objects
            .filter(formulation=formulation)
            .order_by("-version_number")
            .first()
        )
    if version is None:
        err = CheckoutError(
            f"{formulation.name or 'This product'} isn't ready to quote yet.",
        )
        err.code = "no_version"
        raise err
    return version


def _resolve_combo(combo_id: str) -> PackagingCombo | None:
    try:
        return PackagingCombo.objects.filter(pk=UUID(str(combo_id))).first()
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Spec sheet clone — per-order copy of the RTG formulation's FINAL sheet
# ---------------------------------------------------------------------------


# Content fields we carry over verbatim from the template into the
# customer's copy. Kept as a tuple so the intent is obvious and a
# newly-added SpecificationSheet column doesn't silently sneak in.
_SHEET_CONTENT_FIELDS: tuple[str, ...] = (
    "unit_quantity",
    "food_contact_status",
    "shelf_life",
    "storage_conditions",
    "weight_uniformity",
    "total_weight_label",
    "margin_percent",
    "cover_notes",
    "limits_override",
    "snapshot_overrides",
    "section_visibility",
    "section_order",
    "packaging_lid_id",
    "packaging_container_id",
    "packaging_label_id",
    "packaging_antitemper_id",
    # Prepared-by + director signatures ride along so the clone
    # renders as director-approved out of the gate — the template's
    # signatures represent the SKU-level sign-off, not a per-customer
    # act, so re-signing per checkout would be theatre.
    "prepared_by_user_id",
    "prepared_by_signed_at",
    "prepared_by_signature_image",
    "director_user_id",
    "director_signed_at",
    "director_signature_image",
)


def _find_template_final_sheet(formulation: Formulation) -> SpecificationSheet | None:
    """Latest untainted FINAL sheet on any version of this formulation.

    RTG SKUs are expected to have exactly one FINAL template — the
    ``create_sheet`` service enforces that singleton on the create
    surface. Per-order clones also carry ``document_kind=FINAL`` so
    a naive ``order_by(-updated_at).first()`` would pick the most
    recent clone and start suffixing ``-ORDER-1-ORDER-1-...`` on the
    already-cloned code. The distinguishing signal is ``client_name``:
    templates are unbound to any customer (blank), clones inherit the
    checkout modal's customer identity. Filtering to blank client
    names restores the "one template per SKU" invariant regardless
    of how many orders have been placed.
    """

    return (
        SpecificationSheet.objects
        .filter(
            formulation_version__formulation_id=formulation.id,
            document_kind=SpecificationDocumentKind.FINAL,
            client_name="",
        )
        .order_by("-updated_at")
        .first()
    )


def _next_checkout_sheet_code(*, organization, base: str) -> str:
    """Pick a per-org-unique ``-ORDER-<n>`` suffix on ``base``.

    Mirrors the ``-FINAL`` sibling in the specifications service —
    walk suffixes until a free slot appears. Blank base ⇒ blank
    code, matches ``create_sheet`` fallback behaviour.
    """

    base = (base or "").strip()
    if not base:
        return ""
    idx = 1
    while True:
        candidate = f"{base}-ORDER-{idx}"
        if not SpecificationSheet.objects.filter(
            organization=organization, code=candidate
        ).exists():
            return candidate
        idx += 1


def _clone_final_sheet_for_checkout(
    *,
    formulation: Formulation,
    formulation_version: FormulationVersion,
    proposal: Proposal,
    actor,
    payload: CheckoutInput,
    combo: PackagingCombo | None = None,
    template: SpecificationSheet | None = None,
) -> SpecificationSheet | None:
    """Fresh customer-specific FINAL sheet for a portal checkout.

    When ``combo`` is passed we resolve its items into the sheet's
    four packaging slots (lid / container / label / antitemper) so
    the rendered sheet shows the concrete packaging the customer
    picked instead of the "chosen per order — see proposal"
    placeholder RTG templates carry.

    ``template`` is optional — callers that already looked the
    template up (e.g. for cost resolution) pass it in to avoid a
    second query. When absent we look it up here.

    Returns ``None`` when the SKU has no FINAL template yet — the
    proposal is still created (sales will notice the missing sheet
    on the row) rather than blocking the whole checkout on staff
    misconfiguration.
    """

    if template is None:
        template = _find_template_final_sheet(formulation)
    if template is None:
        return None

    kwargs = {field: getattr(template, field) for field in _SHEET_CONTENT_FIELDS}
    kwargs.update(
        organization=formulation.organization,
        formulation_version=formulation_version,
        code=_next_checkout_sheet_code(
            organization=formulation.organization,
            base=(template.code or formulation.code or "").strip(),
        ),
        # Client identity from the checkout modal (mirrors the
        # proposal header we already wrote above).
        client_name=payload.name or proposal.customer_name,
        client_email=proposal.customer_email,
        client_company=payload.company or proposal.customer_company,
        # Final price on the sheet mirrors the proposal-level unit
        # price so a printed sheet matches the quote number.
        final_price=proposal.unit_price,
        document_kind=SpecificationDocumentKind.FINAL,
        # APPROVED = signed by prep + director. Customer signature
        # will flip it to ACCEPTED via the kiosk at Send time —
        # blank customer_* signer fields on purpose.
        status=SpecificationStatus.APPROVED,
        created_by=actor,
        updated_by=actor,
    )
    if combo is not None:
        # Wipe any packaging FKs inherited from the template BEFORE
        # applying the combo. Template RTG sheets sometimes carry
        # stray packaging picks from dev seeds — without this reset,
        # a pouch combo (container + label only) would silently keep
        # the template's bottle-lid and render "Lid: Closure Miron"
        # alongside "Pouch: Stand-Up 110x190" on the customer's spec.
        kwargs.update(
            packaging_lid_id=None,
            packaging_container_id=None,
            packaging_label_id=None,
            packaging_antitemper_id=None,
        )
        kwargs.update(_packaging_slots_from_combo(combo))
    return SpecificationSheet.objects.create(**kwargs)


# Keywords that map an item's ``name`` into a packaging slot when
# the item's ``attributes.packaging_type`` isn't set. Same shape as
# the regenerate-sheet resolver in ``specifications.services`` — kept
# in sync deliberately so a combo item and a manual packaging line
# resolve to the same slot.
_PACKAGING_KEYWORD_SLOTS: tuple[tuple[str, str], ...] = (
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


def _packaging_slots_from_combo(combo: PackagingCombo) -> dict:
    """Map a combo's items into ``packaging_*_id`` FK kwargs.

    Prefers the item's ``attributes.packaging_type`` (canonical) and
    falls back to a keyword match on the item name so a combo whose
    items were seeded without the attribute still resolves. First
    item wins per slot — combos should have at most one item per
    slot, but a badly-authored combo won't overwrite an earlier
    slot silently.
    """

    slot_for_type = {ptype: slot for slot, ptype in PACKAGING_SLOT_TYPES.items()}
    resolved: dict[str, int] = {}
    for row in combo.items.select_related("item").order_by("sort_order", "id"):
        item = row.item
        if item is None:
            continue
        attrs = item.attributes or {}
        slot: str | None = None
        packaging_type = attrs.get("packaging_type")
        if packaging_type:
            slot = slot_for_type.get(packaging_type)
        if slot is None:
            lower_name = (item.name or "").lower()
            for keyword, slot_candidate in _PACKAGING_KEYWORD_SLOTS:
                if keyword in lower_name:
                    slot = slot_candidate
                    break
        if slot and slot not in resolved:
            resolved[slot] = item.pk
    return {f"{slot}_id": item_id for slot, item_id in resolved.items()}


def _resolve_actor(customer):
    """Pick a staff user for the FK-required ``created_by``/``updated_by``.

    Prefer the customer's account manager / sales person, fall back
    to the earliest-joined active member of the customer's org so
    the row always lands. The audit trail records the true portal
    account via ``customer`` FK on the proposal + the notes field.
    """

    User = get_user_model()
    actor = (
        getattr(customer, "account_manager", None)
        or getattr(customer, "sales_person", None)
    )
    if actor is None:
        actor = (
            User.objects
            .filter(
                memberships__organization_id=customer.organization_id,
                is_active=True,
            )
            .order_by("date_joined")
            .first()
        )
    if actor is None:
        err = CheckoutError(
            "No staff member is available to review this order.",
        )
        err.code = "no_actor"
        raise err
    return actor


def _line_description(formulation: Formulation, combo) -> str:
    base = formulation.name or "Ready-to-Go product"
    if combo is None:
        return base
    combo_items = [
        (row.item.name or "").strip()
        for row in combo.items.select_related("item").all()
        if row.item_id
    ]
    combo_items = [n for n in combo_items if n]
    packaging = combo.name or "Standard packaging"
    if combo_items:
        return f"{base} · {packaging} ({', '.join(combo_items)})"
    return f"{base} · {packaging}"


__all__ = [
    "CartKind",
    "CheckoutError",
    "CheckoutInput",
    "CheckoutLineInput",
    "CheckoutResult",
    "place_portal_checkout",
]
