"""Tests for the spec-sheet delete gate.

Hard-deleting a director-signed or customer-signed sheet wipes the
audit trail (signatures, kiosk acceptance, transition log) — and on
multi-spec proposals, it can orphan a ``ProposalLine`` that pointed
at it. The gate restricts deletion to ``draft`` only so the audit
trail outlives any reviewer interaction.

Three contracts pinned:

* :func:`delete_sheet` raises :class:`SpecificationDeletionLocked`
  for every non-draft status.
* The endpoint surfaces the exception as
  ``409 specification_deletion_locked`` instead of silently
  succeeding (the previous behaviour) or producing a 403.
* Draft sheets still delete cleanly so the gate doesn't break the
  expected scientist workflow.
"""

from __future__ import annotations

import pytest
from django.urls import reverse
from rest_framework import status as http_status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.specifications.models import (
    SpecificationSheet,
    SpecificationStatus,
)
from apps.specifications.services import (
    SpecificationDeletionLocked,
    delete_sheet,
)
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# delete_sheet service guard
# ---------------------------------------------------------------------------


class TestDeleteSheetService:
    def test_deletes_draft(self) -> None:
        sheet = SpecificationSheetFactory(status=SpecificationStatus.DRAFT)
        sheet_id = sheet.pk
        outcome = delete_sheet(sheet=sheet, actor=sheet.organization.created_by)
        assert outcome["target_id"] == str(sheet_id)
        assert not SpecificationSheet.objects.filter(pk=sheet_id).exists()

    @pytest.mark.parametrize(
        "locked_status",
        [
            SpecificationStatus.IN_REVIEW,
            SpecificationStatus.APPROVED,
            SpecificationStatus.SENT,
            SpecificationStatus.ACCEPTED,
            SpecificationStatus.REJECTED,
        ],
    )
    def test_blocks_every_non_draft_status(self, locked_status: str) -> None:
        # Each status carries either a director signature
        # (approved/sent), a customer signature (accepted), a
        # terminal audit trail (rejected), or a pending review
        # (in_review). Hard-deleting any of them would wipe state
        # that other rows depend on.
        sheet = SpecificationSheetFactory(status=locked_status)
        with pytest.raises(SpecificationDeletionLocked):
            delete_sheet(
                sheet=sheet, actor=sheet.organization.created_by
            )
        # Critical: the guard runs before the DELETE so the row is
        # still around for the operator to revert + retry.
        assert SpecificationSheet.objects.filter(pk=sheet.pk).exists()


# ---------------------------------------------------------------------------
# API endpoint
# ---------------------------------------------------------------------------


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


def _login(client: APIClient, user) -> None:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )


def _spec_detail_url(org_id, sheet_id) -> str:
    return f"/api/organizations/{org_id}/specifications/{sheet_id}/"


class TestDeleteSpecEndpoint:
    def test_204_on_draft(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory(created_by=owner)
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.DRAFT
        )
        _login(api_client, owner)

        response = api_client.delete(_spec_detail_url(org.id, sheet.id))
        assert response.status_code == http_status.HTTP_204_NO_CONTENT
        assert not SpecificationSheet.objects.filter(pk=sheet.pk).exists()

    def test_409_on_approved(self, api_client: APIClient) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory(created_by=owner)
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.APPROVED
        )
        _login(api_client, owner)

        response = api_client.delete(_spec_detail_url(org.id, sheet.id))
        assert response.status_code == http_status.HTTP_409_CONFLICT
        assert response.data["code"] == "specification_deletion_locked"
        # Defense in depth — the row must survive the 409.
        assert SpecificationSheet.objects.filter(pk=sheet.pk).exists()

    def test_409_on_accepted(self, api_client: APIClient) -> None:
        # The customer-signed case the user reported. Wiping an
        # accepted sheet loses the kiosk acceptance signature plus
        # any proposal-side history that pointed at it.
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = OrganizationFactory(created_by=owner)
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.ACCEPTED
        )
        _login(api_client, owner)

        response = api_client.delete(_spec_detail_url(org.id, sheet.id))
        assert response.status_code == http_status.HTTP_409_CONFLICT
        assert response.data["code"] == "specification_deletion_locked"
        assert SpecificationSheet.objects.filter(pk=sheet.pk).exists()
