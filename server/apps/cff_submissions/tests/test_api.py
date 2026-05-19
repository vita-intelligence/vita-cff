"""REST API tests for the CFF submissions surface.

Coverage focuses on the RBAC envelope, not on service-layer logic
(that's covered in :mod:`test_services`). Each endpoint is tested
for:

* Authorised happy path.
* Caller without the required capability → 403.
* Caller outside the org → 404 (no existence leak).
* Owner-only endpoints reject non-owner callers.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.integration import set_wix_cff_config
from apps.cff_submissions.models import CFFSubmission, CFFSubmissionStatus
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)


FORM_ID = "bec673ee-0020-4c34-a09a-8332356548af"
SITE_ID = "c0d9135f-baa5-4029-baec-42521e033385"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _login(client: APIClient, user) -> APIClient:
    client.force_authenticate(user=user)
    return client


@pytest.fixture
def workspace(db):
    """Org + owner + two non-owner members (with / without the
    ``view`` cap), plus one assigned and one unassigned CFF row.
    """

    org = OrganizationFactory()
    owner = org.created_by

    viewer = UserFactory(email="viewer@vita.test")
    MembershipFactory(
        user=viewer,
        organization=org,
        permissions={"cff_submissions": ["view"]},
    )
    triager = UserFactory(email="triager@vita.test")
    MembershipFactory(
        user=triager,
        organization=org,
        permissions={"cff_submissions": ["view", "assign_project"]},
    )
    no_perm_member = UserFactory(email="noperm@vita.test")
    MembershipFactory(
        user=no_perm_member, organization=org, permissions={},
    )

    project = FormulationFactory(organization=org)
    assigned = _make_row(org=org, project=project)
    unassigned = _make_row(org=org)

    return {
        "org": org,
        "owner": owner,
        "viewer": viewer,
        "triager": triager,
        "no_perm_member": no_perm_member,
        "project": project,
        "assigned": assigned,
        "unassigned": unassigned,
    }


def _make_row(*, org, project=None) -> CFFSubmission:
    return CFFSubmission.objects.create(
        organization=org,
        wix_submission_id=uuid.uuid4(),
        wix_form_id=FORM_ID,
        wix_namespace="wix.form_app.form",
        wix_status=CFFSubmissionStatus.CONFIRMED,
        wix_created_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        wix_updated_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        raw_payload={"submissions": {"email_fc7d": "client@example.com"}},
        project=project,
    )


# ---------------------------------------------------------------------------
# List
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestList:
    def test_viewer_sees_every_cff_in_org(self, workspace):
        url = reverse(
            "cff_submissions:list", kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), workspace["viewer"])
        response = client.get(url)
        assert response.status_code == status.HTTP_200_OK
        # Cursor pagination doesn't return a total ``count`` (would
        # require a separate COUNT query) — assert on the page size.
        assert len(response.json()["results"]) == 2

    def test_member_without_view_capability_is_forbidden(self, workspace):
        url = reverse(
            "cff_submissions:list", kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), workspace["no_perm_member"])
        response = client.get(url)
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_outsider_gets_404(self, workspace):
        outsider = UserFactory(email="outsider@elsewhere.test")
        url = reverse(
            "cff_submissions:list", kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), outsider)
        response = client.get(url)
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_assigned_filter(self, workspace):
        url = reverse(
            "cff_submissions:list", kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), workspace["viewer"])
        response = client.get(url, {"assigned": "false"})
        results = response.json()["results"]
        assert len(results) == 1
        assert results[0]["id"] == str(workspace["unassigned"].id)


# ---------------------------------------------------------------------------
# Assign / unassign
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAssign:
    def test_triager_can_assign(self, workspace):
        url = reverse(
            "cff_submissions:assign",
            kwargs={
                "org_id": workspace["org"].id,
                "submission_id": workspace["unassigned"].id,
            },
        )
        client = _login(APIClient(), workspace["triager"])
        response = client.post(
            url, {"project_id": str(workspace["project"].id)}, format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        workspace["unassigned"].refresh_from_db()
        assert workspace["unassigned"].project_id == workspace["project"].id

    def test_viewer_cannot_assign(self, workspace):
        url = reverse(
            "cff_submissions:assign",
            kwargs={
                "org_id": workspace["org"].id,
                "submission_id": workspace["unassigned"].id,
            },
        )
        client = _login(APIClient(), workspace["viewer"])
        response = client.post(
            url, {"project_id": str(workspace["project"].id)}, format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_cross_org_project_returns_404(self, workspace):
        foreign_org = OrganizationFactory()
        foreign_project = FormulationFactory(organization=foreign_org)
        url = reverse(
            "cff_submissions:assign",
            kwargs={
                "org_id": workspace["org"].id,
                "submission_id": workspace["unassigned"].id,
            },
        )
        client = _login(APIClient(), workspace["triager"])
        response = client.post(
            url, {"project_id": str(foreign_project.id)}, format="json",
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_unassign(self, workspace):
        url = reverse(
            "cff_submissions:unassign",
            kwargs={
                "org_id": workspace["org"].id,
                "submission_id": workspace["assigned"].id,
            },
        )
        client = _login(APIClient(), workspace["triager"])
        response = client.post(url)
        assert response.status_code == status.HTTP_200_OK
        workspace["assigned"].refresh_from_db()
        assert workspace["assigned"].project_id is None


# ---------------------------------------------------------------------------
# Integration settings (owner-only)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestIntegrationSettings:
    def test_owner_can_save_config(self, workspace):
        url = reverse(
            "cff_submissions:integration",
            kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), workspace["owner"])
        response = client.put(
            url,
            {
                "enabled": True,
                "site_id": SITE_ID,
                "form_id": FORM_ID,
                "namespace": "wix.form_app.form",
                "api_key": "fresh-key",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        # Plaintext key MUST NOT come back on the wire.
        assert "api_key" not in body
        assert body["has_api_key"] is True

    def test_non_owner_cannot_save_config(self, workspace):
        url = reverse(
            "cff_submissions:integration",
            kwargs={"org_id": workspace["org"].id},
        )
        # Triager has the assign cap but is not an owner.
        client = _login(APIClient(), workspace["triager"])
        response = client.put(
            url,
            {
                "enabled": True,
                "site_id": SITE_ID,
                "form_id": FORM_ID,
                "namespace": "wix.form_app.form",
                "api_key": "x",
            },
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_get_returns_has_api_key_flag(self, workspace):
        actor = workspace["owner"]
        set_wix_cff_config(
            organization=workspace["org"],
            actor=actor,
            enabled=True,
            api_key="x",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        url = reverse(
            "cff_submissions:integration",
            kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), workspace["owner"])
        response = client.get(url)
        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["has_api_key"] is True
        assert "api_key" not in body

    def test_delete_clears_config(self, workspace):
        set_wix_cff_config(
            organization=workspace["org"],
            actor=workspace["owner"],
            enabled=True,
            api_key="x",
            site_id=SITE_ID,
            form_id=FORM_ID,
            namespace="wix.form_app.form",
        )
        url = reverse(
            "cff_submissions:integration",
            kwargs={"org_id": workspace["org"].id},
        )
        client = _login(APIClient(), workspace["owner"])
        response = client.delete(url)
        assert response.status_code == status.HTTP_200_OK
        workspace["org"].refresh_from_db()
        assert workspace["org"].wix_cff_config == {}
