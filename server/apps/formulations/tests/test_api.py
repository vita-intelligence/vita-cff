"""Integration tests for the formulations API."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.models import Formulation
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


def _list_url(org_id: str) -> str:
    return reverse("formulations:formulation-list", kwargs={"org_id": org_id})


def _detail_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-detail",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _lines_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-lines",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _compute_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-compute",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _versions_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-versions",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _rollback_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-rollback",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


@pytest.fixture
def owner_client(api_client: APIClient) -> tuple[APIClient, Any, Any]:
    user = UserFactory(
        email="owner@formulations.test", password=DEFAULT_TEST_PASSWORD
    )
    org = create_organization(user=user, name="Formulator Co")
    _login(api_client, user)
    return api_client, user, org


def _grant_formulations(user: Any, org: Any, capabilities: list[str]) -> None:
    MembershipFactory(
        user=user,
        organization=org,
        is_owner=False,
        permissions={"formulations": capabilities},
    )


class TestFormulationListCreate:
    def test_owner_creates_formulation(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        response = client.post(
            _list_url(str(org.id)),
            {
                "name": "New Product",
                "code": "NP-001",
                "dosage_form": "capsule",
                "servings_per_pack": 30,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        body = response.json()
        assert body["name"] == "New Product"
        assert body["dosage_form"] == "capsule"
        assert Formulation.objects.filter(organization=org).count() == 1

    def test_owner_lists_formulations(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        FormulationFactory(organization=org, name="A")
        FormulationFactory(organization=org, name="B")

        response = client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert set(body.keys()) == {"next", "previous", "results"}
        assert len(body["results"]) == 2

    def test_list_paginates_across_multiple_pages(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        for idx in range(75):
            FormulationFactory(
                organization=org, name=f"Formulation {idx:03d}"
            )

        first = client.get(_list_url(str(org.id)) + "?page_size=25").json()
        assert len(first["results"]) == 25
        assert first["next"] is not None

        second = client.get(first["next"]).json()
        assert len(second["results"]) == 25
        assert second["previous"] is not None

        third = client.get(second["next"]).json()
        assert len(third["results"]) == 25
        assert third["next"] is None

    def test_unauthenticated_is_rejected(self, api_client: APIClient) -> None:
        org = OrganizationFactory()
        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_sees_404(self, api_client: APIClient) -> None:
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        other_org = OrganizationFactory()
        _login(api_client, stranger)
        response = api_client.get(_list_url(str(other_org.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_member_without_permission_is_forbidden(
        self, api_client: APIClient
    ) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        MembershipFactory(user=user, organization=org, permissions={})
        _login(api_client, user)
        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_read_member_can_list(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_formulations(user, org, ["view"])
        FormulationFactory(organization=org)
        _login(api_client, user)
        response = api_client.get(_list_url(str(org.id)))
        assert response.status_code == status.HTTP_200_OK
        assert len(response.json()["results"]) == 1

    def test_read_member_cannot_create(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        _grant_formulations(user, org, ["view"])
        _login(api_client, user)
        response = api_client.post(
            _list_url(str(org.id)), {"name": "Nope"}, format="json"
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestFormulationDetail:
    def test_owner_can_update(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(organization=org, name="Old")
        response = client.patch(
            _detail_url(str(org.id), str(formulation.id)),
            {"name": "New"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        formulation.refresh_from_db()
        assert formulation.name == "New"

    def test_cross_org_lookup_is_404(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, my_org = owner_client
        other_org = OrganizationFactory()
        foreign = FormulationFactory(organization=other_org)
        response = client.get(_detail_url(str(my_org.id), str(foreign.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_delete_requires_admin(self, api_client: APIClient) -> None:
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        _grant_formulations(user, org, ["view", "edit"])
        _login(api_client, user)
        response = api_client.delete(
            _detail_url(str(org.id), str(formulation.id))
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestLinesEndpoint:
    def test_replace_lines_updates_totals(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule", capsule_size="double_00"
        )
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )

        response = client.put(
            _lines_url(str(org.id), str(formulation.id)),
            {
                "lines": [
                    {
                        "item_id": str(item.id),
                        "label_claim_mg": "500",
                        "display_order": 0,
                    }
                ]
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body["lines"]) == 1
        assert body["lines"][0]["mg_per_serving_cached"] == "500.0000"

    def test_replace_lines_rejects_foreign_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(organization=org)
        other_org = OrganizationFactory()
        foreign_item = ItemFactory(catalogue=raw_materials_catalogue(other_org))

        response = client.put(
            _lines_url(str(org.id), str(formulation.id)),
            {
                "lines": [
                    {"item_id": str(foreign_item.id), "label_claim_mg": "100"}
                ]
            },
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["lines"] == ["raw_material_not_in_org"]

    def test_replace_lines_accepts_psp_mirror_item(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        """Items in the org's ``psp_mirror`` catalogue must be
        eligible as formulation-line ingredients. This is the
        load-bearing regression guard for the "PSP powers the
        builder" flow — without it every click on a PSP row
        would blow up at the ``replace_lines`` boundary."""

        from apps.catalogues.models import Catalogue, PSP_MIRROR_SLUG
        from apps.catalogues.tests.factories import ItemFactory

        client, _, org = owner_client
        formulation = FormulationFactory(organization=org)
        # Create the mirror catalogue explicitly — mirrors the
        # lazy-create behaviour of ``mirror_psp_item`` but skips
        # the PSP HTTP round-trip.
        mirror_catalogue = Catalogue.objects.create(
            organization=org,
            slug=PSP_MIRROR_SLUG,
            name="PSP Mirror",
            is_system=True,
        )
        mirrored_item = ItemFactory(
            catalogue=mirror_catalogue,
            attributes={"purity": 1.0, "type": "Vitamin"},
        )

        response = client.put(
            _lines_url(str(org.id), str(formulation.id)),
            {
                "lines": [
                    {
                        "item_id": str(mirrored_item.id),
                        "label_claim_mg": "500",
                    }
                ]
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body["lines"]) == 1
        # Assert the line links back to the mirrored Item by DB
        # lookup rather than the exact wire key name, so a future
        # response-shape rename doesn't rot this guard silently.
        from apps.formulations.models import FormulationLine
        line = FormulationLine.objects.get(formulation=formulation)
        assert str(line.item_id) == str(mirrored_item.id)


class TestComputeEndpoint:
    def test_returns_totals_payload(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule", capsule_size="double_00"
        )
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )
        client.put(
            _lines_url(str(org.id), str(formulation.id)),
            {"lines": [{"item_id": str(item.id), "label_claim_mg": "500"}]},
            format="json",
        )

        response = client.get(_compute_url(str(org.id), str(formulation.id)))
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["total_active_mg"] == "500.0000"
        assert body["dosage_form"] == "capsule"
        assert body["size_key"] == "double_00"
        assert body["viability"]["fits"] is True
        assert "can_make" in body["viability"]["codes"]


class TestVersioning:
    def test_save_and_list_versions(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(organization=org)

        for label in ("first", "second"):
            response = client.post(
                _versions_url(str(org.id), str(formulation.id)),
                {"label": label},
                format="json",
            )
            assert response.status_code == status.HTTP_201_CREATED

        response = client.get(
            _versions_url(str(org.id), str(formulation.id))
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body) == 2
        assert body[0]["version_number"] == 2
        assert body[0]["label"] == "second"

    def test_rollback_endpoint(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(organization=org)
        catalogue = raw_materials_catalogue(org)
        item_a = ItemFactory(catalogue=catalogue, attributes={"purity": 1.0})
        item_b = ItemFactory(catalogue=catalogue, attributes={"purity": 1.0})

        # v1 with item_a
        client.put(
            _lines_url(str(org.id), str(formulation.id)),
            {"lines": [{"item_id": str(item_a.id), "label_claim_mg": "100"}]},
            format="json",
        )
        client.post(
            _versions_url(str(org.id), str(formulation.id)),
            {"label": "initial"},
            format="json",
        )

        # Edit to item_b
        client.put(
            _lines_url(str(org.id), str(formulation.id)),
            {"lines": [{"item_id": str(item_b.id), "label_claim_mg": "200"}]},
            format="json",
        )

        # Roll back to v1
        response = client.post(
            _rollback_url(str(org.id), str(formulation.id)),
            {"version_number": 1},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert len(body["lines"]) == 1
        assert body["lines"][0]["item"] == str(item_a.id)
        assert body["lines"][0]["label_claim_mg"] == "100.0000"

    def test_rollback_to_unknown_version_is_400(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(organization=org)
        response = client.post(
            _rollback_url(str(org.id), str(formulation.id)),
            {"version_number": 99},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.json()["version_number"] == [
            "formulation_version_not_found"
        ]


def _rtg_publish_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "formulations:formulation-rtg-publish",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


class TestRTGPublishParsers:
    """Regression guard: the ``rtg-publish`` endpoint must accept a
    multipart body because the FE panel POSTs a ``FormData`` payload
    with the optional hero image alongside the marketing scalars.

    Broke previously in two places at once — DRF's global
    ``DEFAULT_PARSER_CLASSES`` only carries ``JSONParser`` (so any
    ``multipart/form-data`` request bounced with 415 before the view
    ran), and the FE was hand-setting the Content-Type header
    without a boundary (so even after the parser change the body
    would fail to split). The parser opt-in is enforced here; the
    FE fix is baked into the panel component.
    """

    def test_accepts_multipart_form_data(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        client, _, org = owner_client
        formulation = FormulationFactory(
            organization=org, project_type="ready_to_go"
        )
        # ``format="multipart"`` = APIClient sends multipart/form-data
        # with the boundary set correctly. Just verifying the parser
        # doesn't bounce it as 415; unpublish is the simplest happy
        # path because it needs no marketing fields.
        response = client.patch(
            _rtg_publish_url(str(org.id), str(formulation.id)),
            {"is_rtg_published": "false"},
            format="multipart",
        )
        # Anything other than 415 means the parser accepted the body.
        # Non-owner writes still go through the same permission
        # pipeline so 200/400 both count as "parser worked".
        assert response.status_code != status.HTTP_415_UNSUPPORTED_MEDIA_TYPE
        assert response.status_code == status.HTTP_200_OK

    def test_accepts_json(
        self, owner_client: tuple[APIClient, Any, Any]
    ) -> None:
        """JSON is still valid on the same endpoint so callers that
        don't need the file upload can send a plain application/json
        patch. Multipart being added didn't kick JSON out."""

        client, _, org = owner_client
        formulation = FormulationFactory(
            organization=org, project_type="ready_to_go"
        )
        response = client.patch(
            _rtg_publish_url(str(org.id), str(formulation.id)),
            {"is_rtg_published": False},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK


class TestRTGPublishRBAC:
    """The ``rtg-publish`` endpoint moved from the ``formulations``
    module to the dedicated ``rtg_catalog`` module. These tests pin
    the new gate so a future refactor can't silently return it to
    ``formulations.edit`` — the whole point of the split was that
    a catalog manager can go live without holding recipe-edit rights.
    """

    def test_publish_requires_rtg_publish_capability(self) -> None:
        """A member with ``rtg_catalog.manage`` alone can save the
        marketing block but flipping ``is_rtg_published`` requires
        the paired ``publish`` capability. Segregation of duties:
        drafting copy vs authorising customer visibility."""

        user = UserFactory(
            email="manager@rtg.test", password=DEFAULT_TEST_PASSWORD
        )
        org = create_organization(user=user, name="Manager Co")
        # Second member with manage-only.
        author = UserFactory(email="author@rtg.test", password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=author,
            organization=org,
            permissions={"rtg_catalog": ["view", "manage"]},
        )
        formulation = FormulationFactory(
            organization=org, project_type="ready_to_go"
        )

        client = APIClient()
        _login(client, author)
        # Marketing-only edit (no ``is_rtg_published`` key) → allowed
        # on manage-only.
        r = client.patch(
            _rtg_publish_url(str(org.id), str(formulation.id)),
            {"rtg_short_description": "author drafted copy"},
            format="json",
        )
        assert r.status_code == status.HTTP_200_OK

        # Flip-to-published → requires ``publish`` cap.
        r = client.patch(
            _rtg_publish_url(str(org.id), str(formulation.id)),
            {"is_rtg_published": True},
            format="json",
        )
        assert r.status_code == status.HTTP_403_FORBIDDEN

    def test_publish_allowed_with_publish_capability(self) -> None:
        user = UserFactory(
            email="pub-owner@rtg.test", password=DEFAULT_TEST_PASSWORD
        )
        org = create_organization(user=user, name="Publisher Co")
        publisher = UserFactory(
            email="publisher@rtg.test", password=DEFAULT_TEST_PASSWORD
        )
        MembershipFactory(
            user=publisher,
            organization=org,
            permissions={"rtg_catalog": ["view", "manage", "publish"]},
        )
        formulation = FormulationFactory(
            organization=org, project_type="ready_to_go"
        )

        client = APIClient()
        _login(client, publisher)
        r = client.patch(
            _rtg_publish_url(str(org.id), str(formulation.id)),
            {"is_rtg_published": False},
            format="json",
        )
        assert r.status_code == status.HTTP_200_OK

    def test_missing_rtg_module_grant_is_forbidden(self) -> None:
        """A member with the old ``formulations.edit`` grant but no
        ``rtg_catalog`` entry at all should 403 — the migration is
        what mirrors the grants, so this test guards against someone
        deleting the migration and expecting things to still work."""

        user = UserFactory(email="fowner@rtg.test", password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=user, name="F Only Co")
        legacy = UserFactory(email="legacy@rtg.test", password=DEFAULT_TEST_PASSWORD)
        MembershipFactory(
            user=legacy,
            organization=org,
            permissions={"formulations": ["view", "edit"]},
        )
        formulation = FormulationFactory(
            organization=org, project_type="ready_to_go"
        )

        client = APIClient()
        _login(client, legacy)
        r = client.patch(
            _rtg_publish_url(str(org.id), str(formulation.id)),
            {"rtg_short_description": "should 403"},
            format="json",
        )
        assert r.status_code == status.HTTP_403_FORBIDDEN
