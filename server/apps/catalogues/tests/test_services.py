"""Service-layer tests for the catalogues app."""

from __future__ import annotations

import pytest

from apps.catalogues.models import Catalogue
from apps.catalogues.services import (
    CatalogueIsSystem,
    CatalogueNotFound,
    CatalogueSlugConflict,
    CatalogueSlugInvalid,
    ItemInternalCodeConflict,
    ItemNotFound,
    archive_item,
    create_catalogue,
    create_item,
    delete_catalogue,
    get_catalogue,
    get_item,
    list_catalogues,
    list_items,
    update_catalogue,
    update_item,
)
from apps.catalogues.tests.factories import (
    CatalogueFactory,
    ItemFactory,
    packaging_catalogue,
    raw_materials_catalogue,
)
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


class TestCreateCatalogue:
    def test_creates_non_system_catalogue(self) -> None:
        org = OrganizationFactory()
        catalogue = create_catalogue(
            organization=org,
            slug="equipment",
            name="Equipment",
            description="Machines.",
        )
        assert catalogue.slug == "equipment"
        assert catalogue.is_system is False
        assert catalogue.description == "Machines."

    def test_rejects_invalid_slug(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(CatalogueSlugInvalid):
            create_catalogue(
                organization=org, slug="Has Spaces", name="Nope"
            )

    def test_rejects_duplicate_slug(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(CatalogueSlugConflict):
            # raw_materials is seeded automatically
            create_catalogue(
                organization=org, slug="raw_materials", name="Nope"
            )


class TestListCatalogues:
    def test_returns_system_catalogues_by_default(self) -> None:
        org = OrganizationFactory()
        slugs = [c.slug for c in list_catalogues(organization=org)]
        assert "raw_materials" in slugs
        assert "packaging" in slugs

    def test_scoped_to_organization(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        ids = {c.id for c in list_catalogues(organization=org_a)}
        assert raw_materials_catalogue(org_a).id in ids
        assert raw_materials_catalogue(org_b).id not in ids


class TestGetCatalogue:
    def test_returns_by_slug(self) -> None:
        org = OrganizationFactory()
        got = get_catalogue(organization=org, slug="raw_materials")
        assert got.slug == "raw_materials"

    def test_raises_on_missing_slug(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(CatalogueNotFound):
            get_catalogue(organization=org, slug="nonexistent")


class TestUpdateCatalogue:
    def test_updates_name_and_description(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        updated = update_catalogue(
            catalogue=catalogue, name="RM", description="Ingredients only."
        )
        assert updated.name == "RM"
        assert updated.description == "Ingredients only."


class TestDeleteCatalogue:
    def test_cannot_delete_system_catalogue(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(CatalogueIsSystem):
            delete_catalogue(catalogue=raw_materials_catalogue(org))

    def test_can_delete_custom_catalogue(self) -> None:
        custom = CatalogueFactory(slug="custom_1")
        catalogue_id = custom.id
        delete_catalogue(catalogue=custom)
        assert not Catalogue.objects.filter(id=catalogue_id).exists()


class TestCreateItem:
    def test_creates_item_with_actor_audit(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        item = create_item(
            catalogue=catalogue,
            actor=org.created_by,
            name="Vitamin C",
        )
        assert item.catalogue == catalogue
        assert item.created_by == org.created_by
        assert item.updated_by == org.created_by

    def test_internal_code_conflict_raises(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        create_item(
            catalogue=catalogue,
            actor=org.created_by,
            name="First",
            internal_code="DUP-1",
        )
        with pytest.raises(ItemInternalCodeConflict):
            create_item(
                catalogue=catalogue,
                actor=org.created_by,
                name="Second",
                internal_code="DUP-1",
            )

    def test_empty_internal_code_does_not_conflict(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        create_item(catalogue=catalogue, actor=org.created_by, name="A")
        create_item(catalogue=catalogue, actor=org.created_by, name="B")

    def test_conflict_is_per_catalogue_not_per_org(self) -> None:
        org = OrganizationFactory()
        create_item(
            catalogue=raw_materials_catalogue(org),
            actor=org.created_by,
            name="Raw",
            internal_code="SHARED",
        )
        # Same code in a different catalogue is allowed.
        create_item(
            catalogue=packaging_catalogue(org),
            actor=org.created_by,
            name="Pack",
            internal_code="SHARED",
        )


class TestListItems:
    def test_scoped_to_catalogue(self) -> None:
        org = OrganizationFactory()
        raw = raw_materials_catalogue(org)
        packaging = packaging_catalogue(org)
        ItemFactory(catalogue=raw, name="Raw thing")
        ItemFactory(catalogue=packaging, name="Pack thing")

        raw_names = [i.name for i in list_items(catalogue=raw)]
        assert raw_names == ["Raw thing"]

    def test_hides_archived_by_default(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, name="Active")
        ItemFactory(catalogue=catalogue, name="Archived", is_archived=True)

        names = [i.name for i in list_items(catalogue=catalogue)]
        assert names == ["Active"]


class TestGetItem:
    def test_returns_item_in_catalogue(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        item = ItemFactory(catalogue=catalogue)
        got = get_item(catalogue=catalogue, item_id=item.id)
        assert got.pk == item.pk

    def test_raises_when_item_belongs_to_other_catalogue(self) -> None:
        org = OrganizationFactory()
        raw = raw_materials_catalogue(org)
        packaging = packaging_catalogue(org)
        item = ItemFactory(catalogue=raw)
        with pytest.raises(ItemNotFound):
            get_item(catalogue=packaging, item_id=item.id)


class TestUpdateItem:
    def test_partial_update_applies(self) -> None:
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org), name="Old")
        updated = update_item(item=item, actor=org.created_by, name="New")
        assert updated.name == "New"

    def test_internal_code_conflict_on_update(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        ItemFactory(catalogue=catalogue, internal_code="DUP-1")
        other = ItemFactory(catalogue=catalogue, internal_code="OK-2")
        with pytest.raises(ItemInternalCodeConflict):
            update_item(item=other, actor=org.created_by, internal_code="DUP-1")

    def test_updating_to_own_code_is_a_noop(self) -> None:
        org = OrganizationFactory()
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org), internal_code="KEEP-1"
        )
        update_item(item=item, actor=org.created_by, internal_code="KEEP-1")


class TestArchiveItem:
    def test_sets_archived_flag(self) -> None:
        org = OrganizationFactory()
        item = ItemFactory(catalogue=raw_materials_catalogue(org))
        archive_item(item=item, actor=org.created_by)
        item.refresh_from_db()
        assert item.is_archived is True
