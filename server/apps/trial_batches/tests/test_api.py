"""Integration tests for the trial-batches API."""

from __future__ import annotations

import csv
import io
import json
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
from apps.formulations.services import replace_lines, save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)
from apps.trial_batches.services import create_batch


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------


def _list_url(org_id: str, formulation_id: str) -> str:
    return reverse(
        "trial_batches:trial-batch-list",
        kwargs={"org_id": org_id, "formulation_id": formulation_id},
    )


def _detail_url(org_id: str, batch_id: str) -> str:
    return reverse(
        "trial_batches:trial-batch-detail",
        kwargs={"org_id": org_id, "batch_id": batch_id},
    )


def _render_url(org_id: str, batch_id: str) -> str:
    return reverse(
        "trial_batches:trial-batch-render",
        kwargs={"org_id": org_id, "batch_id": batch_id},
    )


def _bom_url(org_id: str, batch_id: str) -> str:
    return reverse(
        "trial_batches:trial-batch-bom",
        kwargs={"org_id": org_id, "batch_id": batch_id},
    )


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _grant(user: Any, org: Any, capabilities: list[str]) -> None:
    """Non-owner membership with the given ``formulations`` capabilities —
    trial batches piggyback on the formulations permission module."""

    MembershipFactory(
        user=user,
        organization=org,
        is_owner=False,
        permissions={"formulations": capabilities},
    )


def _seed_capsule_version(org):
    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        name="Test Raw",
        attributes={
            "type": "Others",
            "purity": "1",
            "ingredient_list_name": "Test Ingredient",
        },
    )
    formulation = FormulationFactory(
        organization=org, dosage_form="capsule", capsule_size="double_00"
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
    )
    return save_version(formulation=formulation, actor=org.created_by)


# ---------------------------------------------------------------------------
# List + create
# ---------------------------------------------------------------------------


class TestListCreate:
    def test_owner_can_create_batch(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        client = _login(APIClient(), org.created_by)
        response = client.post(
            _list_url(str(org.id), str(version.formulation_id)),
            {
                "formulation_version_id": str(version.id),
                "batch_size_units": 500,
                "label": "Pilot",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["batch_size_units"] == 500
        assert response.data["label"] == "Pilot"

    def test_list_returns_only_this_formulation_batches(self) -> None:
        org = OrganizationFactory()
        version_a = _seed_capsule_version(org)
        version_b = _seed_capsule_version(org)
        create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version_a.id,
            batch_size_units=100,
        )
        create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version_b.id,
            batch_size_units=200,
        )
        client = _login(APIClient(), org.created_by)
        response = client.get(_list_url(str(org.id), str(version_a.formulation_id)))
        assert response.status_code == status.HTTP_200_OK
        assert len(response.data) == 1

    def test_rejects_invalid_batch_size(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        client = _login(APIClient(), org.created_by)
        response = client.post(
            _list_url(str(org.id), str(version.formulation_id)),
            {"formulation_version_id": str(version.id), "batch_size_units": 0},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_non_member_cannot_access(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        outsider = UserFactory()
        client = _login(APIClient(), outsider)
        response = client.get(
            _list_url(str(org.id), str(version.formulation_id))
        )
        # Unknown-org to a non-member is a 404 (not 403) per the
        # HasFormulationsPermission hiding rule.
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_read_only_user_cannot_create(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        reader = UserFactory()
        _grant(reader, org, ["view"])
        client = _login(APIClient(), reader)
        response = client.post(
            _list_url(str(org.id), str(version.formulation_id)),
            {"formulation_version_id": str(version.id), "batch_size_units": 500},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Detail
# ---------------------------------------------------------------------------


class TestDetail:
    def test_cross_org_access_is_404(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        other_version = _seed_capsule_version(other_org)
        batch = create_batch(
            organization=other_org,
            actor=other_org.created_by,
            formulation_version_id=other_version.id,
            batch_size_units=500,
        )
        client = _login(APIClient(), my_org.created_by)
        response = client.get(_detail_url(str(my_org.id), str(batch.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_patch_updates_label(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        client = _login(APIClient(), org.created_by)
        response = client.patch(
            _detail_url(str(org.id), str(batch.id)),
            {"label": "Final pilot"},
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.data["label"] == "Final pilot"

    def test_delete_requires_admin(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        writer = UserFactory()
        _grant(writer, org, ["view", "edit"])
        client = _login(APIClient(), writer)
        response = client.delete(_detail_url(str(org.id), str(batch.id)))
        assert response.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Render + BOM export
# ---------------------------------------------------------------------------


class TestRender:
    def test_render_shape(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        client = _login(APIClient(), org.created_by)
        response = client.get(_render_url(str(org.id), str(batch.id)))
        assert response.status_code == status.HTTP_200_OK
        body = response.data
        assert body["batch_size_units"] == 500
        assert body["units_per_pack"] == 60
        assert body["total_units_in_batch"] == 30_000
        assert isinstance(body["entries"], list)
        assert body["entries"], "expected at least the active + shell rows"


class TestBOMExport:
    def test_csv_export_header_and_rows(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        client = _login(APIClient(), org.created_by)
        response = client.get(_bom_url(str(org.id), str(batch.id)))
        assert response.status_code == status.HTTP_200_OK
        assert response["Content-Type"].startswith("text/csv")
        assert "attachment" in response["Content-Disposition"]
        # Parse the CSV and confirm we got a header + data rows.
        reader = csv.DictReader(io.StringIO(response.content.decode("utf-8")))
        rows = list(reader)
        assert len(rows) >= 2  # active + shell at minimum
        # The shell row uses the ``each`` UOM — procurement orders
        # shells by count, not weight.
        shell_rows = [r for r in rows if r["category"] == "shell"]
        assert len(shell_rows) == 1
        assert shell_rows[0]["quantity_unit"] == "each"

    def test_json_export_carries_metadata_plus_lines(self) -> None:
        org = OrganizationFactory()
        version = _seed_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        client = _login(APIClient(), org.created_by)
        response = client.get(
            f"{_bom_url(str(org.id), str(batch.id))}?format=json"
        )
        assert response.status_code == status.HTTP_200_OK
        assert response["Content-Type"].startswith("application/json")
        body = json.loads(response.content.decode("utf-8"))
        assert set(body.keys()) == {"batch", "totals", "lines"}
        assert body["batch"]["batch_size_packs"] == 500
        assert body["totals"]["shells_per_batch"] == 30_000

    def test_bom_export_cross_org_is_404(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        other_version = _seed_capsule_version(other_org)
        batch = create_batch(
            organization=other_org,
            actor=other_org.created_by,
            formulation_version_id=other_version.id,
            batch_size_units=500,
        )
        client = _login(APIClient(), my_org.created_by)
        response = client.get(_bom_url(str(my_org.id), str(batch.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND
