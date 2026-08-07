"""Customer-order + sample-request creation service.

Called by the portal ``POST /api/portal/orders/`` endpoint after the
customer clicks Order / Request sample on a marketing-site RTG detail
page. Domain guards live here rather than in the view so tests + the
management shell hit the same rules.

Guards enforced:

  * The formulation must be a currently-published RTG on the
    customer's tenant. Anything else 400s — nobody can order a draft,
    a custom project, or a SKU from a different org.
  * For ``kind=order``: quantity ≥ published MOQ + base_price present.
  * For ``kind=sample``: sample_price present (i.e. staff opted in to
    offering samples on this SKU) + quantity forced to 1.
  * Packaging combo, when supplied, must belong to the same
    formulation.

Snapshot semantics: unit_price / currency_code / moq_snapshot copy
from the Formulation at order time and never re-read. Staff can
re-price the catalogue after an order lands without corrupting the
historical record.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from django.db import transaction

from apps.customers.models import Customer
from apps.formulations.models import (
    CustomerOrder,
    Formulation,
    PackagingCombo,
    ProjectType,
)


class CustomerOrderError(Exception):
    """Any recoverable order-creation failure — bad input, guard trip,
    stale catalogue. The view maps this to a 400 with the code +
    optional per-field errors.
    """

    code: str = "customer_order_error"
    field_errors: dict[str, str] | None = None


class RTGNotOrderable(CustomerOrderError):
    code = "rtg_not_orderable"


class InvalidQuantity(CustomerOrderError):
    code = "invalid_quantity"


class SamplesNotOffered(CustomerOrderError):
    code = "samples_not_offered"


class PackagingComboMismatch(CustomerOrderError):
    code = "packaging_combo_mismatch"


@dataclass(frozen=True)
class CustomerOrderInput:
    """Wire shape for a portal-side order/sample submission."""

    formulation_id: str
    kind: str  # "order" | "sample"
    quantity: int
    packaging_combo_id: str | None
    delivery_address: str
    notes: str


@transaction.atomic
def create_customer_order(
    *,
    client_account: Any,
    payload: CustomerOrderInput,
) -> CustomerOrder:
    """Materialise the order row after validating the request against
    the currently-published catalogue.

    ``client_account`` is the authenticated portal login (comes off
    ``request.user``). Its bound ``Customer`` is the buyer.
    """

    customer: Customer = client_account.customer
    organization = customer.organization

    # 1. Formulation must be a currently-published RTG on this org.
    formulation = (
        Formulation.objects
        .filter(
            pk=payload.formulation_id,
            organization=organization,
            is_rtg_published=True,
            project_type=ProjectType.READY_TO_GO,
        )
        .first()
    )
    if formulation is None:
        raise RTGNotOrderable(
            "This product isn't available to order right now.",
        )

    kind = (payload.kind or "").strip().lower()
    if kind not in {CustomerOrder.Kind.ORDER, CustomerOrder.Kind.SAMPLE}:
        raise CustomerOrderError("Unknown order kind.")

    # 2. Kind-specific validation.
    if kind == CustomerOrder.Kind.ORDER:
        if formulation.rtg_base_price is None:
            # Staff hasn't finished the marketing block — treat as
            # not-orderable rather than crashing on a None decimal.
            raise RTGNotOrderable(
                "Pricing for this product hasn't been finalised yet.",
            )
        moq = formulation.rtg_moq or 1
        if payload.quantity is None or payload.quantity < moq:
            exc = InvalidQuantity(
                f"Minimum order quantity is {moq} units.",
            )
            exc.field_errors = {"quantity": f"Enter at least {moq}."}
            raise exc
        unit_price = Decimal(formulation.rtg_base_price)
        quantity = int(payload.quantity)
        moq_snapshot = formulation.rtg_moq
    else:
        if formulation.rtg_sample_price is None:
            raise SamplesNotOffered(
                "Samples aren't offered for this product.",
            )
        try:
            unit_price = Decimal(formulation.rtg_sample_price)
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise CustomerOrderError("Sample price is misconfigured.") from exc
        # Samples are always a single kit — the sample_description
        # explains what's inside. Ignore whatever quantity the FE sent.
        quantity = 1
        moq_snapshot = None

    # 3. Packaging combo, if supplied, must belong to this formulation.
    combo: PackagingCombo | None = None
    if payload.packaging_combo_id:
        combo = (
            PackagingCombo.objects
            .filter(
                pk=payload.packaging_combo_id,
                formulation=formulation,
            )
            .first()
        )
        if combo is None:
            raise PackagingComboMismatch(
                "That packaging option doesn't belong to this product.",
            )

    order = CustomerOrder.objects.create(
        organization=organization,
        customer=customer,
        formulation=formulation,
        packaging_combo=combo,
        kind=kind,
        status=CustomerOrder.Status.NEW,
        quantity=quantity,
        unit_price=unit_price,
        currency_code=formulation.rtg_currency_code or "GBP",
        moq_snapshot=moq_snapshot,
        delivery_address=(payload.delivery_address or "").strip(),
        notes=(payload.notes or "").strip(),
        created_by_account=client_account,
    )
    return order
