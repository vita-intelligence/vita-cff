"""Factory Boy factories for the catalogues app."""

from __future__ import annotations

from decimal import Decimal

import factory

from apps.catalogues.models import (
    PACKAGING_SLUG,
    RAW_MATERIALS_SLUG,
    Catalogue,
    Item,
)
from apps.organizations.tests.factories import OrganizationFactory


def raw_materials_catalogue(organization) -> Catalogue:
    """Return the seeded raw materials catalogue for ``organization``.

    The post-save signal on :class:`Organization` creates the two
    system catalogues automatically, so tests can just look them up.
    """

    return Catalogue.objects.get(
        organization=organization, slug=RAW_MATERIALS_SLUG
    )


def packaging_catalogue(organization) -> Catalogue:
    return Catalogue.objects.get(
        organization=organization, slug=PACKAGING_SLUG
    )


class CatalogueFactory(factory.django.DjangoModelFactory):
    """Builds a *custom* (non-system) catalogue.

    For the seeded system catalogues use :func:`raw_materials_catalogue`
    or :func:`packaging_catalogue`.
    """

    class Meta:
        model = Catalogue
        skip_postgeneration_save = True

    organization = factory.SubFactory(OrganizationFactory)
    slug = factory.Sequence(lambda n: f"custom_{n}")
    name = factory.Sequence(lambda n: f"Custom {n}")
    description = ""
    is_system = False


class ItemFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Item
        skip_postgeneration_save = True

    catalogue = factory.LazyAttribute(
        lambda obj: raw_materials_catalogue(OrganizationFactory())
    )
    name = factory.Sequence(lambda n: f"Item {n}")
    internal_code = factory.Sequence(lambda n: f"SKU-{n:04d}")
    unit = "g"
    base_price = factory.LazyFunction(lambda: Decimal("1.0000"))
    is_archived = False
    created_by = factory.SelfAttribute("catalogue.organization.created_by")
    updated_by = factory.SelfAttribute("catalogue.organization.created_by")
