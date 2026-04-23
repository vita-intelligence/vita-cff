"""Service layer for the customers app.

The address-book is deliberately thin: CRUD plus a search helper the
proposal picker hits to populate its typeahead. Keeping this module
tiny lets us evolve ``Customer`` without touching proposal code.
"""

from __future__ import annotations

from typing import Any

from django.db import transaction
from django.db.models import Q, QuerySet

from apps.audit.services import record as record_audit, snapshot
from apps.customers.models import Customer
from apps.organizations.models import Organization


class CustomerNotFound(Exception):
    code = "customer_not_found"


def list_customers(
    *,
    organization: Organization,
    search: str = "",
) -> QuerySet[Customer]:
    """Return the org's customers, newest first when unfiltered.

    ``search`` runs a case-insensitive prefix + substring match
    across name / company / email so the proposal picker's
    typeahead finds a client regardless of which field the user
    types first.
    """

    queryset = Customer.objects.filter(organization=organization)
    if search:
        term = search.strip()
        if term:
            queryset = queryset.filter(
                Q(name__icontains=term)
                | Q(company__icontains=term)
                | Q(email__icontains=term)
            )
    return queryset.order_by("company", "name")


def get_customer(
    *, organization: Organization, customer_id: Any
) -> Customer:
    obj = Customer.objects.filter(
        organization=organization, id=customer_id
    ).first()
    if obj is None:
        raise CustomerNotFound()
    return obj


@transaction.atomic
def create_customer(
    *,
    organization: Organization,
    actor: Any,
    name: str = "",
    company: str = "",
    email: str = "",
    phone: str = "",
    invoice_address: str = "",
    delivery_address: str = "",
    notes: str = "",
) -> Customer:
    customer = Customer.objects.create(
        organization=organization,
        name=name,
        company=company,
        email=email,
        phone=phone,
        invoice_address=invoice_address,
        delivery_address=delivery_address,
        notes=notes,
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="customer.create",
        target=customer,
        after=snapshot(customer),
    )
    return customer


_UPDATABLE_FIELDS = (
    "name",
    "company",
    "email",
    "phone",
    "invoice_address",
    "delivery_address",
    "notes",
)


@transaction.atomic
def update_customer(
    *, customer: Customer, actor: Any, **changes: Any
) -> Customer:
    before = snapshot(customer)
    for key, value in changes.items():
        if key in _UPDATABLE_FIELDS and value is not None:
            setattr(customer, key, value)
    customer.updated_by = actor
    customer.save()
    record_audit(
        organization=customer.organization,
        actor=actor,
        action="customer.update",
        target=customer,
        before=before,
        after=snapshot(customer),
    )
    return customer


@transaction.atomic
def delete_customer(*, customer: Customer, actor: Any) -> None:
    before = snapshot(customer)
    target_id = str(customer.pk)
    organization = customer.organization
    customer.delete()
    record_audit(
        organization=organization,
        actor=actor,
        action="customer.delete",
        target=None,
        target_type="customer",
        target_id=target_id,
        before=before,
    )
