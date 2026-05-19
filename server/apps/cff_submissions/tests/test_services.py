"""Unit tests for the CFF intake service layer (per-org config).

Two areas under coverage:

1. **Import** — that a re-import of the same submission doesn't
   duplicate, that a status / field flip on the Wix side is
   mirrored locally, that an unknown status downgrades to
   ``UNKNOWN`` instead of crashing the loop, and that the field-
   label cache is populated from the schema fetch.
2. **Assignment** — that you can't attach a CFF to a project in a
   different organisation, and that detachment clears the link but
   preserves audit information.

The Wix HTTP client is mocked at the ``iter_submissions`` /
``get_form`` boundary so tests never touch the network. The
encryption layer is exercised end-to-end against a real
:class:`Organization` so the round-trip through
:func:`set_wix_cff_config` → :func:`get_wix_cff_config` is real.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.cff_submissions.integration import (
    WixCFFNotConfigured,
    set_wix_cff_config,
)
from apps.cff_submissions.models import (
    CFFSubmission,
    CFFSubmissionStatus,
    WixFormSchemaCache,
)
from apps.cff_submissions.services import (
    CFFAssignmentError,
    assign_to_project,
    create_project_from_cff,
    import_cff_submissions_for_org,
    unassign,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.models import Membership
from apps.organizations.tests.factories import OrganizationFactory


FORM_ID = "bec673ee-0020-4c34-a09a-8332356548af"
NAMESPACE = "wix.form_app.form"


def _make_wix_submission(
    *,
    submission_id: str | None = None,
    status: str = "CONFIRMED",
    created: str = "2026-05-01T10:00:00.000Z",
    updated: str | None = None,
    email: str = "client@example.com",
) -> dict:
    """Shape-faithful Wix submission dict.

    Mirrors the real Wix Query Submissions response shape we
    confirmed against the live API during integration validation.
    """

    return {
        "id": submission_id or str(uuid.uuid4()),
        "formId": FORM_ID,
        "namespace": NAMESPACE,
        "status": status,
        "createdDate": created,
        "updatedDate": updated or created,
        "submissions": {
            "email_fc7d": email,
            "market_segment": "Food Manufacturing",
        },
    }


@pytest.fixture
def org_with_wix(db):
    """Org with a live Wix CFF integration.

    The encryption layer is exercised against the real cryptography
    module so any future tampering with ``encrypt_secret`` /
    ``decrypt_secret`` surfaces here.
    """

    org = OrganizationFactory()
    actor = UserFactory()
    set_wix_cff_config(
        organization=org,
        actor=actor,
        enabled=True,
        api_key="fake-api-key",
        site_id="fake-site-id",
        form_id=FORM_ID,
        namespace=NAMESPACE,
    )
    org.refresh_from_db()
    return org


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestImport:
    def test_first_import_creates_rows(self, org_with_wix):
        payloads = [
            _make_wix_submission(email="alpha@x.test"),
            _make_wix_submission(email="beta@x.test"),
        ]
        with _stub_wix(payloads):
            result = import_cff_submissions_for_org(organization=org_with_wix)

        assert result.fetched == 2
        assert result.created == 2
        assert result.updated == 0
        assert CFFSubmission.objects.filter(organization=org_with_wix).count() == 2

    def test_re_import_does_not_duplicate(self, org_with_wix):
        wix_id = str(uuid.uuid4())
        payload = _make_wix_submission(submission_id=wix_id)
        with _stub_wix([payload]):
            import_cff_submissions_for_org(organization=org_with_wix)
            import_cff_submissions_for_org(organization=org_with_wix)

        assert CFFSubmission.objects.filter(wix_submission_id=wix_id).count() == 1

    def test_status_flip_is_mirrored(self, org_with_wix):
        wix_id = str(uuid.uuid4())
        with _stub_wix(
            [_make_wix_submission(submission_id=wix_id, status="PENDING")]
        ):
            import_cff_submissions_for_org(organization=org_with_wix)
        with _stub_wix(
            [_make_wix_submission(submission_id=wix_id, status="CONFIRMED")]
        ):
            import_cff_submissions_for_org(organization=org_with_wix)

        row = CFFSubmission.objects.get(wix_submission_id=wix_id)
        assert row.wix_status == CFFSubmissionStatus.CONFIRMED

    def test_unknown_status_downgrades(self, org_with_wix):
        wix_id = str(uuid.uuid4())
        with _stub_wix(
            [_make_wix_submission(submission_id=wix_id, status="SOME_NEW_WIX_STATE")]
        ):
            result = import_cff_submissions_for_org(organization=org_with_wix)

        assert result.created == 1
        row = CFFSubmission.objects.get(wix_submission_id=wix_id)
        assert row.wix_status == CFFSubmissionStatus.UNKNOWN

    def test_disabled_integration_raises(self, db):
        org = OrganizationFactory()
        # Default config = empty dict = disabled.
        with pytest.raises(WixCFFNotConfigured):
            import_cff_submissions_for_org(organization=org)

    def test_field_label_cache_is_populated(self, org_with_wix):
        with _stub_wix(
            [_make_wix_submission()],
            schema={
                "form": {
                    "fields": [
                        {"target": "email_fc7d", "label": "Email"},
                        {"target": "market_segment", "label": "Market segment"},
                    ]
                }
            },
        ):
            import_cff_submissions_for_org(organization=org_with_wix)

        cache = WixFormSchemaCache.objects.get(
            wix_form_id=FORM_ID, wix_namespace=NAMESPACE,
        )
        assert cache.field_labels == {
            "email_fc7d": "Email",
            "market_segment": "Market segment",
        }


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestAssignment:
    def test_assign_records_audit_fields(self, db):
        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        project = FormulationFactory(organization=org)
        actor = UserFactory()

        assign_to_project(
            submission=submission, project=project, actor=actor,
        )
        submission.refresh_from_db()

        assert submission.project_id == project.id
        assert submission.assigned_by_id == actor.id
        assert submission.assigned_at is not None

    def test_cross_org_assignment_is_rejected(self, db):
        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        other_org = OrganizationFactory()
        foreign_project = FormulationFactory(organization=other_org)
        actor = UserFactory()

        with pytest.raises(CFFAssignmentError):
            assign_to_project(
                submission=submission, project=foreign_project, actor=actor,
            )

    def test_unassign_clears_project_but_keeps_actor_audit(self, db):
        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        project = FormulationFactory(organization=org)
        first_actor = UserFactory()
        second_actor = UserFactory()

        assign_to_project(
            submission=submission, project=project, actor=first_actor,
        )
        unassign(submission=submission, actor=second_actor)
        submission.refresh_from_db()

        assert submission.project_id is None
        # Detach is itself an audited write — last actor wins.
        assert submission.assigned_by_id == second_actor.id


# ---------------------------------------------------------------------------
# Create project from CFF (sales-person auto-assignment)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestCreateProjectFromCFF:
    def test_creates_project_attaches_cff_and_auto_assigns_sales_person(
        self, db,
    ):
        org = OrganizationFactory()
        # The triager (actor) — owner so they bypass capability checks.
        actor = org.created_by
        # The sales rep the CFF should match — must be a member of
        # the org for the auto-assign to land.
        sales_rep = UserFactory(email="rep@vita.test")
        Membership.objects.create(user=sales_rep, organization=org)

        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "rep@vita.test",
            },
        )

        result = create_project_from_cff(
            submission=submission,
            actor=actor,
            name="Vit C Capsule",
            code="VC-100",
        )

        assert result.project.organization_id == org.id
        assert result.project.name == "Vit C Capsule"
        assert result.project.sales_person_id == sales_rep.id
        result.submission.refresh_from_db()
        assert result.submission.project_id == result.project.id
        assert result.auto_assigned_sales_person_id == str(sales_rep.id)
        assert result.cff_sales_person_email_hint == "rep@vita.test"

    def test_no_matching_member_still_creates_and_attaches(self, db):
        org = OrganizationFactory()
        actor = org.created_by

        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "nobody@vita.test",
            },
        )

        result = create_project_from_cff(
            submission=submission,
            actor=actor,
            name="Vit D",
            code="VD-001",
        )

        # Project + attachment still created; only the sales auto-
        # assign was skipped.
        assert result.project.sales_person_id is None
        assert result.auto_assigned_sales_person_id is None
        # The email harvested from the CFF is still surfaced so the
        # UI can show "tried to match: nobody@vita.test".
        assert result.cff_sales_person_email_hint == "nobody@vita.test"
        result.submission.refresh_from_db()
        assert result.submission.project_id == result.project.id

    def test_case_insensitive_email_match(self, db):
        org = OrganizationFactory()
        actor = org.created_by
        sales_rep = UserFactory(email="rep@VITA.test")
        Membership.objects.create(user=sales_rep, organization=org)

        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "REP@vita.test",
            },
        )

        result = create_project_from_cff(
            submission=submission,
            actor=actor,
            name="Multivit",
            code="MV-1",
        )
        assert result.project.sales_person_id == sales_rep.id

    def test_caller_without_cap_skips_sales_assignment(self, db):
        org = OrganizationFactory()
        actor = org.created_by
        sales_rep = UserFactory(email="rep@vita.test")
        Membership.objects.create(user=sales_rep, organization=org)

        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "rep@vita.test",
            },
        )

        result = create_project_from_cff(
            submission=submission,
            actor=actor,
            name="Mag B",
            code="MB-7",
            can_assign_sales_person=False,
        )

        # Project + attachment created; sales person deliberately
        # not auto-assigned because the caller's role doesn't have
        # the cap.
        assert result.project.sales_person_id is None
        assert result.auto_assigned_sales_person_id is None
        # The email hint is still surfaced so the UI can prompt an
        # admin to assign manually.
        assert result.cff_sales_person_email_hint == "rep@vita.test"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_submission_row(*, org, extra_fields: dict | None = None) -> CFFSubmission:
    submissions: dict = {"email_fc7d": "client@example.com"}
    if extra_fields:
        submissions.update(extra_fields)
    return CFFSubmission.objects.create(
        organization=org,
        wix_submission_id=uuid.uuid4(),
        wix_form_id=FORM_ID,
        wix_namespace=NAMESPACE,
        wix_status=CFFSubmissionStatus.CONFIRMED,
        wix_created_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        wix_updated_date=datetime(2026, 5, 1, tzinfo=timezone.utc),
        raw_payload={"submissions": submissions},
    )


class _StubClient:
    """Drop-in for :class:`WixClient` that yields pre-set payloads.

    Only the two methods the importer touches are implemented; any
    other call raises so a future regression that starts using a
    new endpoint surfaces loudly in the test suite.
    """

    def __init__(self, submissions, schema):
        self._submissions = submissions
        self._schema = schema

    def iter_submissions(self, *, form_id, namespace, page_size=100):
        for sub in self._submissions:
            yield sub

    def get_form(self, form_id):
        return self._schema


def _stub_wix(submissions, schema=None):
    """Patch the :class:`WixClient` constructor for the duration of a test.

    The importer instantiates :class:`WixClient` directly with the
    plaintext credentials it just decrypted; we replace the
    constructor so no real HTTP call is made.
    """

    if schema is None:
        schema = {"form": {"fields": []}}
    stub = _StubClient(submissions, schema)
    return patch(
        "apps.cff_submissions.services.WixClient",
        return_value=stub,
    )
