"""Integration tests for the product-validation API."""

from __future__ import annotations

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
from apps.product_validation.models import ValidationStatus
from apps.product_validation.services import create_validation
from apps.trial_batches.services import create_batch


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# URL helpers
# ---------------------------------------------------------------------------


def _list_url(org_id: str) -> str:
    return reverse(
        "product_validation:validation-list", kwargs={"org_id": org_id}
    )


def _detail_url(org_id: str, validation_id: str) -> str:
    return reverse(
        "product_validation:validation-detail",
        kwargs={"org_id": org_id, "validation_id": validation_id},
    )


def _stats_url(org_id: str, validation_id: str) -> str:
    return reverse(
        "product_validation:validation-stats",
        kwargs={"org_id": org_id, "validation_id": validation_id},
    )


def _status_url(org_id: str, validation_id: str) -> str:
    return reverse(
        "product_validation:validation-status",
        kwargs={"org_id": org_id, "validation_id": validation_id},
    )


def _for_batch_url(org_id: str, batch_id: str) -> str:
    return reverse(
        "product_validation:validation-for-batch",
        kwargs={"org_id": org_id, "batch_id": batch_id},
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _grant(user: Any, org: Any, capabilities: list[str]) -> None:
    MembershipFactory(
        user=user,
        organization=org,
        is_owner=False,
        permissions={"formulations": capabilities},
    )


def _batch_in_org(org):
    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        name="Test Raw",
        attributes={"type": "Others", "purity": "1"},
    )
    formulation = FormulationFactory(
        organization=org, dosage_form="capsule", capsule_size="double_00"
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
    )
    version = save_version(formulation=formulation, actor=org.created_by)
    return create_batch(
        organization=org,
        actor=org.created_by,
        formulation_version_id=version.id,
        batch_size_units=100,
    )


# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------


class TestCreate:
    def test_owner_can_create_validation(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        client = _login(APIClient(), org.created_by)
        response = client.post(
            _list_url(str(org.id)),
            {"trial_batch_id": str(batch.id)},
            format="json",
        )
        assert response.status_code == status.HTTP_201_CREATED
        assert response.data["trial_batch_id"] == str(batch.id)
        assert response.data["status"] == ValidationStatus.DRAFT

    def test_rejects_cross_org_batch(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        other_batch = _batch_in_org(other_org)
        client = _login(APIClient(), my_org.created_by)
        response = client.post(
            _list_url(str(my_org.id)),
            {"trial_batch_id": str(other_batch.id)},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["trial_batch_id"] == [
            "trial_batch_not_in_org"
        ]

    def test_rejects_duplicate(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        client = _login(APIClient(), org.created_by)
        client.post(
            _list_url(str(org.id)),
            {"trial_batch_id": str(batch.id)},
            format="json",
        )
        response = client.post(
            _list_url(str(org.id)),
            {"trial_batch_id": str(batch.id)},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["trial_batch_id"] == [
            "validation_already_exists"
        ]

    def test_read_only_user_cannot_create(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        reader = UserFactory()
        _grant(reader, org, ["view"])
        client = _login(APIClient(), reader)
        response = client.post(
            _list_url(str(org.id)),
            {"trial_batch_id": str(batch.id)},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Detail / patch / delete
# ---------------------------------------------------------------------------


class TestDetail:
    def test_patch_updates_test_payload(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        client = _login(APIClient(), org.created_by)
        response = client.patch(
            _detail_url(str(org.id), str(v.id)),
            {
                "weight_test": {
                    "target_mg": 1000,
                    "tolerance_pct": 5,
                    "samples": [990, 1005, 1010],
                    "notes": "",
                }
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.data["weight_test"]["target_mg"] == 1000
        assert response.data["weight_test"]["samples"] == [990, 1005, 1010]

    def test_cross_org_detail_is_404(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        other_batch = _batch_in_org(other_org)
        v = create_validation(
            organization=other_org,
            actor=other_org.created_by,
            trial_batch_id=other_batch.id,
        )
        client = _login(APIClient(), my_org.created_by)
        response = client.get(_detail_url(str(my_org.id), str(v.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_delete_requires_admin(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        writer = UserFactory()
        _grant(writer, org, ["view", "edit"])
        client = _login(APIClient(), writer)
        response = client.delete(_detail_url(str(org.id), str(v.id)))
        assert response.status_code == status.HTTP_403_FORBIDDEN


# ---------------------------------------------------------------------------
# Stats endpoint
# ---------------------------------------------------------------------------


class TestStats:
    def test_stats_shape_on_fresh_validation(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        client = _login(APIClient(), org.created_by)
        response = client.get(_stats_url(str(org.id), str(v.id)))
        assert response.status_code == status.HTTP_200_OK
        body = response.data
        assert set(body.keys()) == {
            "weight",
            "hardness",
            "thickness",
            "disintegration",
            "organoleptic",
            "checklist",
            "overall_passed",
        }
        # No samples entered anywhere → individual tests fall back to
        # passed=None; overall depends on checklist which is all-False.
        assert body["weight"]["passed"] is None
        assert body["checklist"]["passed"] is False


# ---------------------------------------------------------------------------
# Status transitions
# ---------------------------------------------------------------------------


_SIG_FIXTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


class TestStatus:
    def test_owner_can_advance_to_in_progress(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        client = _login(APIClient(), org.created_by)
        response = client.post(
            _status_url(str(org.id), str(v.id)),
            {
                "status": ValidationStatus.IN_PROGRESS,
                "signature_image": _SIG_FIXTURE,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        assert response.data["status"] == ValidationStatus.IN_PROGRESS
        assert response.data["scientist"] is not None
        assert response.data["scientist_signature_image"] == _SIG_FIXTURE

    def test_missing_signature_is_400(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        client = _login(APIClient(), org.created_by)
        response = client.post(
            _status_url(str(org.id), str(v.id)),
            {"status": ValidationStatus.IN_PROGRESS},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["signature_image"] == ["signature_required"]

    def test_illegal_transition_is_400(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        client = _login(APIClient(), org.created_by)
        # draft → passed is not allowed; must pass through in_progress.
        response = client.post(
            _status_url(str(org.id), str(v.id)),
            {
                "status": ValidationStatus.PASSED,
                "signature_image": _SIG_FIXTURE,
            },
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST
        assert response.data["status"] == [
            "invalid_validation_transition"
        ]


# ---------------------------------------------------------------------------
# Validation-for-batch lookup
# ---------------------------------------------------------------------------


class TestValidationForBatch:
    def test_missing_validation_is_404(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        client = _login(APIClient(), org.created_by)
        response = client.get(_for_batch_url(str(org.id), str(batch.id)))
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_returns_validation_when_present(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        client = _login(APIClient(), org.created_by)
        response = client.get(_for_batch_url(str(org.id), str(batch.id)))
        assert response.status_code == status.HTTP_200_OK
        assert response.data["id"] == str(v.id)
