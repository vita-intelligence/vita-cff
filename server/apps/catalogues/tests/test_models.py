"""Model-level tests for the catalogues app."""

from __future__ import annotations

from decimal import Decimal

import pytest
from django.db import IntegrityError

from apps.catalogues.models import (
    PACKAGING_SLUG,
    RAW_MATERIALS_SLUG,
    Catalogue,
    Item,
)
from apps.catalogues.tests.factories import (
    CatalogueFactory,
    ItemFactory,
    packaging_catalogue,
    raw_materials_catalogue,
)
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


class TestCatalogueSeeding:
    def test_new_organization_has_system_catalogues(self) -> None:
        org = OrganizationFactory()
        slugs = set(
            Catalogue.objects.filter(organization=org).values_list("slug", flat=True)
        )
        assert slugs == {RAW_MATERIALS_SLUG, PACKAGING_SLUG}

    def test_system_catalogues_are_marked_is_system(self) -> None:
        org = OrganizationFactory()
        assert raw_materials_catalogue(org).is_system is True
        assert packaging_catalogue(org).is_system is True

    def test_slug_unique_per_organization(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(IntegrityError):
            Catalogue.objects.create(
                organization=org,
                slug=RAW_MATERIALS_SLUG,
                name="Duplicate",
                is_system=False,
            )

    def test_same_slug_across_organizations(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        # Both orgs get their own raw_materials row — the unique
        # constraint is per-organization, not global.
        assert raw_materials_catalogue(org_a).pk != raw_materials_catalogue(org_b).pk


class TestItemModel:
    def test_str_returns_name(self) -> None:
        item = ItemFactory(name="Vitamin C")
        assert str(item) == "Vitamin C"

    def test_defaults(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        item = Item.objects.create(
            catalogue=catalogue,
            name="Default",
            created_by=org.created_by,
            updated_by=org.created_by,
        )
        assert item.internal_code == ""
        assert item.unit == ""
        assert item.base_price is None
        assert item.is_archived is False
        assert item.attributes == {}

    def test_internal_code_unique_per_catalogue(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, internal_code="SKU-1")
        with pytest.raises(IntegrityError):
            Item.objects.create(
                catalogue=catalogue,
                name="Duplicate",
                internal_code="SKU-1",
                created_by=org.created_by,
                updated_by=org.created_by,
            )

    def test_internal_code_can_repeat_across_catalogues(self) -> None:
        org = OrganizationFactory()
        ItemFactory(catalogue=raw_materials_catalogue(org), internal_code="SHARED")
        # Same code is fine in a different catalogue within the same org.
        ItemFactory(catalogue=packaging_catalogue(org), internal_code="SHARED")

    def test_empty_internal_codes_can_repeat(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, internal_code="")
        # No unique violation on empty strings thanks to the partial index.
        ItemFactory(catalogue=catalogue, internal_code="")

    def test_base_price_accepts_none(self) -> None:
        item = ItemFactory(base_price=None)
        item.refresh_from_db()
        assert item.base_price is None

    def test_base_price_precision(self) -> None:
        item = ItemFactory(base_price=Decimal("1234.5678"))
        item.refresh_from_db()
        assert item.base_price == Decimal("1234.5678")
