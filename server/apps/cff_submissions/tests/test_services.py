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
    LAZY_POLL_INTERVAL_SECONDS,
    assign_to_project,
    create_project_from_cff,
    ensure_fresh_submissions,
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
# Lazy poll (ensure_fresh_submissions)
# ---------------------------------------------------------------------------


@pytest.mark.django_db
class TestEnsureFreshSubmissions:
    """Coverage for the inbox page's on-demand Wix refresh.

    The helper is intentionally swallowing exceptions and updating
    state via row locks; tests assert the observable contract (does
    it poll? does the timestamp move?) rather than internal call
    ordering.
    """

    def _now_iso(self):
        from django.utils import timezone
        return timezone.now().isoformat()

    def _stamp(self, org, seconds_ago):
        from datetime import timedelta
        from django.utils import timezone
        raw = dict(org.wix_cff_config or {})
        raw["last_poll_at"] = (
            timezone.now() - timedelta(seconds=seconds_ago)
        ).isoformat()
        org.wix_cff_config = raw
        org.save(update_fields=["wix_cff_config", "updated_at"])

    def test_disabled_org_is_a_no_op(self, db):
        org = OrganizationFactory()  # no wix_cff_config set
        with patch(
            "apps.cff_submissions.services.import_cff_submissions_for_org"
        ) as mock_import:
            ensure_fresh_submissions(organization=org)
        mock_import.assert_not_called()

    def test_fresh_stamp_skips_the_poll(self, org_with_wix):
        # Stamp at "1 second ago" — well inside the 5-min window.
        self._stamp(org_with_wix, seconds_ago=1)
        with patch(
            "apps.cff_submissions.services.import_cff_submissions_for_org"
        ) as mock_import:
            ensure_fresh_submissions(organization=org_with_wix)
        mock_import.assert_not_called()

    def test_stale_stamp_triggers_poll(self, org_with_wix):
        self._stamp(
            org_with_wix,
            seconds_ago=LAZY_POLL_INTERVAL_SECONDS + 60,
        )
        with patch(
            "apps.cff_submissions.services.import_cff_submissions_for_org"
        ) as mock_import:
            ensure_fresh_submissions(organization=org_with_wix)
        mock_import.assert_called_once()

    def test_missing_stamp_triggers_poll(self, org_with_wix):
        # The fixture leaves ``last_poll_at`` unset; treat as stale.
        with patch(
            "apps.cff_submissions.services.import_cff_submissions_for_org"
        ) as mock_import:
            ensure_fresh_submissions(organization=org_with_wix)
        mock_import.assert_called_once()

    def test_wix_failure_is_swallowed_and_stamp_pre_advances(
        self, org_with_wix,
    ):
        """A Wix outage must NOT bubble up to the caller, and the
        pre-stamp must move forward so the next visitor doesn't
        immediately re-poll. The 5-minute pause acts as a circuit
        breaker against hammering a broken Wix tenant."""

        from apps.cff_submissions.wix_client import WixAPIError
        from django.utils import timezone

        before = timezone.now()
        with patch(
            "apps.cff_submissions.services.import_cff_submissions_for_org",
            side_effect=WixAPIError(
                "Wix returned 500", status_code=500, body="oops",
            ),
        ):
            ensure_fresh_submissions(organization=org_with_wix)

        org_with_wix.refresh_from_db()
        last = org_with_wix.wix_cff_config.get("last_poll_at")
        assert last is not None
        # Pre-stamp must be ≥ ``before``: failure path still advances
        # the cooldown so the next call within 5 min is a no-op.
        assert datetime.fromisoformat(last) >= before


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
        link = submission.assignments.get(project=project)

        assert link.project_id == project.id
        assert link.assigned_by_id == actor.id
        assert link.assigned_at is not None

    def test_assign_appends_a_second_project(self, db):
        """Many-to-many semantics: a second assign-to-project call
        adds another row instead of replacing the existing link."""

        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        first = FormulationFactory(organization=org)
        second = FormulationFactory(organization=org)
        actor = UserFactory()

        assign_to_project(submission=submission, project=first, actor=actor)
        assign_to_project(submission=submission, project=second, actor=actor)

        linked = set(submission.projects.values_list("id", flat=True))
        assert linked == {first.id, second.id}

    def test_reassigning_same_pair_is_idempotent(self, db):
        """Re-attaching the same (CFF, project) pair must not raise
        on the unique constraint — the service ``get_or_create``s
        the row and refreshes the audit timestamp."""

        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        project = FormulationFactory(organization=org)
        first_actor = UserFactory()
        second_actor = UserFactory()

        assign_to_project(
            submission=submission, project=project, actor=first_actor,
        )
        assign_to_project(
            submission=submission, project=project, actor=second_actor,
        )

        link = submission.assignments.get(project=project)
        # No duplicate row created; second actor wins the audit slot
        # because they're the most recent operator.
        assert submission.assignments.count() == 1
        assert link.assigned_by_id == second_actor.id

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

    def test_unassign_without_project_clears_every_link(self, db):
        """Default behaviour (legacy parity): omitting ``project=``
        drops every assignment the CFF holds. The detach action is
        not itself recorded on a surviving row — the audit lives on
        the deleted rows' history outside the relational table."""

        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        first = FormulationFactory(organization=org)
        second = FormulationFactory(organization=org)
        first_actor = UserFactory()
        second_actor = UserFactory()

        assign_to_project(submission=submission, project=first, actor=first_actor)
        assign_to_project(submission=submission, project=second, actor=first_actor)
        unassign(submission=submission, actor=second_actor)

        assert submission.assignments.count() == 0

    def test_unassign_one_project_keeps_other_links(self, db):
        """Passing ``project=`` removes only that one link so a CFF
        attached to multiple projects can be detached from a single
        one without nuking the rest."""

        org = OrganizationFactory()
        submission = _make_submission_row(org=org)
        first = FormulationFactory(organization=org)
        second = FormulationFactory(organization=org)
        actor = UserFactory()

        assign_to_project(submission=submission, project=first, actor=actor)
        assign_to_project(submission=submission, project=second, actor=actor)
        unassign(submission=submission, actor=actor, project=first)

        assert list(submission.projects.values_list("id", flat=True)) == [
            second.id,
        ]

    def test_attach_auto_assigns_sales_person_when_project_has_none(
        self, db,
    ):
        # The Account Manager Email on the CFF must flow onto an
        # existing bare project on attach — same behaviour as the
        # "Create project from CFF" path, but for the
        # "Assign to existing project" trigger.
        org = OrganizationFactory()
        actor = org.created_by
        sales_rep = UserFactory(email="rep@vita.test")
        Membership.objects.create(user=sales_rep, organization=org)

        project = FormulationFactory(organization=org)
        # Pre-condition: the project has no sales person — this is the
        # "empty slot" case the auto-assign should fill.
        assert project.sales_person_id is None

        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "rep@vita.test",
            },
        )

        assign_to_project(
            submission=submission,
            project=project,
            actor=actor,
            can_assign_sales_person=True,
        )
        project.refresh_from_db()
        submission.refresh_from_db()

        assert project.sales_person_id == sales_rep.id
        assert list(submission.projects.values_list("id", flat=True)) == [
            project.id,
        ]

    def test_attach_does_not_overwrite_existing_sales_person(self, db):
        # Empty-slot guard: a CFF re-attached to a project that
        # already has someone on it must NOT silently take it over.
        # Manual assignment wins; the CFF's Account Manager Email is
        # only ever a fallback for the empty case.
        org = OrganizationFactory()
        actor = org.created_by
        original_rep = UserFactory(email="original@vita.test")
        cff_rep = UserFactory(email="cff@vita.test")
        Membership.objects.create(user=original_rep, organization=org)
        Membership.objects.create(user=cff_rep, organization=org)

        project = FormulationFactory(
            organization=org, sales_person=original_rep,
        )
        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "cff@vita.test",
            },
        )

        assign_to_project(
            submission=submission,
            project=project,
            actor=actor,
            can_assign_sales_person=True,
        )
        project.refresh_from_db()

        # The original assignment survives — the CFF is the
        # secondary signal here, not the source of truth.
        assert project.sales_person_id == original_rep.id

    def test_attach_no_member_match_leaves_sales_person_empty(self, db):
        # The customer typed an email that doesn't belong to any team
        # member — attach still succeeds, project stays bare, the
        # triager can assign by hand. We avoid raising here because
        # the customer's typo shouldn't break the workflow.
        org = OrganizationFactory()
        actor = org.created_by
        project = FormulationFactory(organization=org)

        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "nobody@vita.test",
            },
        )

        assign_to_project(
            submission=submission,
            project=project,
            actor=actor,
            can_assign_sales_person=True,
        )
        project.refresh_from_db()

        assert project.sales_person_id is None

    def test_attach_does_not_auto_assign_when_flag_is_default(self, db):
        # ``can_assign_sales_person`` defaults to False so the
        # internal call from :func:`create_project_from_cff` (which
        # runs its own sales-person resolution on a freshly-created
        # project) doesn't double-assign. Direct callers that don't
        # opt in keep the legacy "attach only" behaviour.
        org = OrganizationFactory()
        actor = org.created_by
        sales_rep = UserFactory(email="rep@vita.test")
        Membership.objects.create(user=sales_rep, organization=org)

        project = FormulationFactory(organization=org)
        submission = _make_submission_row(
            org=org,
            extra_fields={
                "vita_manufacture_account_manager_email": "rep@vita.test",
            },
        )

        # No ``can_assign_sales_person`` arg — defaults to False.
        assign_to_project(
            submission=submission, project=project, actor=actor,
        )
        project.refresh_from_db()

        assert project.sales_person_id is None


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
        assert list(
            result.submission.projects.values_list("id", flat=True)
        ) == [result.project.id]
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
        assert list(
            result.submission.projects.values_list("id", flat=True)
        ) == [result.project.id]

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
