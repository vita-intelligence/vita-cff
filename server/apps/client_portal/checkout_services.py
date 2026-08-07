"""Portal cart checkout — orchestrate proposal + payments split.

Called from ``POST /api/portal/checkout/`` when a marketing-site
customer clicks *Place order* on ``/cart``. Splits the cart by
line kind:

* ``product`` lines → merged into ONE draft :class:`Proposal` with
  ``template_type=READY_TO_GO``. Each line becomes a
  :class:`ProposalLine` with the customer's picked packaging combo
  attached. Status stays ``DRAFT`` — sales owns Send.

* ``sample`` lines → each gets an individual PENDING
  :class:`Payment` attached to the sample's formulation. Finance
  sees them in the pending-payments queue and completes method +
  external reference + amount confirmation before approving.

Customer-detail overrides captured on the checkout modal are
written to the *proposal* only — the customer's saved settings are
NOT PATCHed silently. Changing saved defaults still goes through
``/portal/settings``.

Mirrors the pattern of
:func:`apps.cff_submissions.services.create_portal_rtg_submission`
(which handles single-line RTG portal submits) but scales to the
multi-line cart case.
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
from apps.proposals.services import _generate_unique_code


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
    proposal_id: str | None
    payment_ids: list[str] = field(default_factory=list)


@transaction.atomic
def place_portal_checkout(
    *,
    account: ClientAccount,
    payload: CheckoutInput,
) -> CheckoutResult:
    """Route each line to its correct destination."""

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

    proposal_id: str | None = None
    if product_lines:
        proposal = _create_batch_proposal(
            customer=customer,
            product_lines=product_lines,
            payload=payload,
        )
        proposal_id = str(proposal.pk)

    payment_ids: list[str] = []
    for line in sample_lines:
        payment = _create_sample_payment(customer=customer, line=line)
        payment_ids.append(str(payment.pk))

    return CheckoutResult(proposal_id=proposal_id, payment_ids=payment_ids)


# ---------------------------------------------------------------------------
# Product path — one Proposal per checkout, N ProposalLines with combos
# ---------------------------------------------------------------------------


def _create_batch_proposal(
    *,
    customer,
    product_lines: list[CheckoutLineInput],
    payload: CheckoutInput,
) -> Proposal:
    """One draft RTG :class:`Proposal` with N :class:`ProposalLine` rows.

    The proposal-level ``formulation_version`` FK is required, so we
    pin it to the first product's version. Per-line versions still
    carry their own linkage on each ``ProposalLine.formulation_version``
    so multi-SKU quotes render correctly.
    """

    # Anchor formulation = first product. Everything on the Proposal
    # header inherits from this (currency, version). Individual lines
    # carry their own version + combo below.
    first_line = product_lines[0]
    first_formulation = _resolve_formulation(first_line.formulation_id)
    first_version = _resolve_version(first_formulation)
    proposal_actor = _resolve_actor(customer)

    proposal = Proposal.objects.create(
        organization=customer.organization,
        formulation_version=first_version,
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
        currency=(first_line.currency_code or "GBP").upper()[:3],
        quantity=max(1, sum(l.quantity for l in product_lines)),
        unit_price=first_line.unit_price,
        cover_notes=(
            "Auto-drafted from the storefront cart. Review the lines "
            "and packaging combos below before hitting Send."
        ),
        created_by=proposal_actor,
        updated_by=proposal_actor,
    )
    proposal.reference = proposal.code
    proposal.save(update_fields=["reference"])

    for idx, line in enumerate(product_lines):
        formulation = (
            first_formulation
            if idx == 0
            else _resolve_formulation(line.formulation_id)
        )
        version = (
            first_version
            if idx == 0
            else _resolve_version(formulation)
        )
        combo = (
            _resolve_combo(line.packaging_combo_id)
            if line.packaging_combo_id
            else None
        )
        ProposalLine.objects.create(
            proposal=proposal,
            formulation_version=version,
            product_code=formulation.code or "",
            description=_line_description(formulation, combo),
            quantity=max(1, line.quantity),
            unit_price=line.unit_price,
            display_order=idx,
            selected_packaging_combo=combo,
        )
    return proposal


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
