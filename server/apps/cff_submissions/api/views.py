"""DRF views for the CFF submissions API.

Three surfaces:

1. **List / detail / assign / unassign** — gated on the
   ``cff_submissions`` module. Anyone with ``view`` can browse the
   intake; ``assign_project`` is required to attach a CFF to a
   project (or detach one).
2. **Field labels** — exposes the cached ``{slug: label}`` map so
   the UI can render "Email" instead of ``email_fc7d``. Read by the
   list page once and reused across rows.
3. **Integration settings** — owner-only ``GET``/``PUT``/``DELETE``
   plus a ``POST .../test/`` probe, mirroring the Dynamics +
   MRPEasy settings cards exactly.
"""

from __future__ import annotations

import logging
from typing import Any

from django.db.models import Q
from rest_framework import status
from rest_framework.exceptions import NotFound, ParseError
from rest_framework.pagination import CursorPagination
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.cff_submissions.integration import (
    WixCFFDecryptionFailed,
    WixCFFNotConfigured,
    clear_wix_cff_config,
    serialize_wix_cff_config_for_api,
    set_wix_cff_config,
)
from apps.cff_submissions.models import CFFSubmission
from apps.cff_submissions.services import (
    CFFAssignmentError,
    CFFRejectionError,
    assign_to_project,
    create_project_from_cff,
    ensure_fresh_submissions,
    get_field_labels,
    reject as reject_submission,
    unassign,
    unreject as unreject_submission,
    verify_wix_cff_connection,
)
from apps.cff_submissions.wix_client import WixAPIError
from apps.formulations.models import Formulation
from apps.formulations.services import (
    FormulationCodeConflict,
    FormulationCodeRequired,
    InvalidCapsuleSize,
    InvalidDosageForm,
    InvalidPowderType,
    InvalidTabletSize,
)
from apps.organizations.modules import (
    CFFSubmissionsCapability,
    FORMULATIONS_MODULE,
    FormulationsCapability,
)
from apps.organizations.services import get_membership, has_capability

from .permissions import HasCFFPermission, IsOrganizationOwner
from .serializers import (
    AssignToProjectRequestSerializer,
    CFFSubmissionSerializer,
    CreateProjectFromCFFRequestSerializer,
    RejectRequestSerializer,
    UnassignFromProjectRequestSerializer,
)


#: Prefetch tuple that hydrates the ``assignments`` collection used by
#: :class:`CFFSubmissionSerializer`. Pulled into a constant so every
#: view path (list, detail, assign-refresh, unassign-refresh,
#: create-from-cff refresh) loads the same chain and the serializer
#: never N+1s on a freshly-saved row.
_CFF_PREFETCH = ("assignments__project", "assignments__assigned_by")

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------


class CFFCursorPagination(CursorPagination):
    """Cursor pagination keyed on ``-wix_created_date``.

    Newest CFFs first — the default view shows recent intake at
    the top. Page size kept modest so the list scrolls without
    overwhelming the browser; the client can bump it via
    ``page_size`` up to ``max_page_size``.
    """

    ordering = "-wix_created_date"
    page_size = 25
    page_size_query_param = "page_size"
    max_page_size = 100


# ---------------------------------------------------------------------------
# Submissions list / detail
# ---------------------------------------------------------------------------


class CFFListView(APIView):
    """``GET /api/organizations/<org>/cff-submissions/``.

    Query params:

    * ``assigned`` — ``true`` / ``false`` to filter by assignment
      state. Default: no filter (every CFF in the org).
    * ``search`` — substring match against the raw JSON payload's
      serialised text. Lightweight; not full-text. Adequate for
      the volumes we see (single digits to low hundreds).
    * ``project_id`` — narrow to CFFs attached to one project.
    * ``page_size`` — see :class:`CFFCursorPagination`.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.VIEW
    pagination_class = CFFCursorPagination

    def get(self, request: Request, org_id: str) -> Response:
        # Lazy refresh: pull from Wix when ``last_poll_at`` is older
        # than the 5-min freshness window. Synchronous + bounded by
        # ``WixClient``'s own timeout; failures fall back to whatever's
        # in the DB so the inbox never breaks because Wix is down.
        ensure_fresh_submissions(organization=self.organization)
        # The lazy poll updates ``wix_cff_config`` on the org row;
        # refresh from the DB so the ``sync`` block embedded below
        # reflects the just-completed poll instead of the stale
        # snapshot the request started with.
        self.organization.refresh_from_db(fields=["wix_cff_config"])

        queryset = (
            CFFSubmission.objects
            .prefetch_related(*_CFF_PREFETCH)
            .filter(organization=self.organization)
        )
        queryset = self._filter(queryset, request)

        paginator = CFFCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = CFFSubmissionSerializer(page, many=True)
        response = paginator.get_paginated_response(serializer.data)
        # Embed sync metadata in every page so the frontend can keep
        # the "Last sync" banner in sync with the actual list refresh
        # without a second round-trip. Same shape as
        # :class:`CFFSyncStatusView` so the client can ``setQueryData``
        # the syncStatus cache directly from this payload.
        response.data["sync"] = _build_sync_payload(self.organization)
        # Per-state totals so the pipeline board's tab badges can
        # render without a second round-trip. Each column will
        # fire its own state-filtered query for the actual rows;
        # this block lets every response answer "how many total in
        # each bucket?" so any column's fetch keeps every badge
        # in step. Scoped by the current ``search`` param so a
        # narrowing search updates the badges too.
        response.data["counts"] = _compute_state_counts(
            self.organization, request
        )
        return response

    def _filter(self, queryset, request: Request):
        # ``state`` is the four-way triage filter — replaces the old
        # binary ``assigned``. Rejected CFFs never appear alongside
        # unassigned ones because the operator has already made the
        # decision to say no; they get their own tab.
        #
        #   * ``unassigned`` — in the triage queue AND not rejected.
        #     The default lens on the inbox page.
        #   * ``assigned``   — has at least one project link.
        #   * ``rejected``   — has been rejected via the reject action.
        #   * ``all``        — no filter (every CFF in the org).
        #
        # The legacy ``assigned`` query-param stays supported for one
        # release so an old bookmark keeps working — it maps onto the
        # new state values.
        state = (request.query_params.get("state") or "").strip().lower()
        if not state:
            assigned_raw = request.query_params.get("assigned")
            if assigned_raw is not None:
                value = assigned_raw.strip().lower()
                if value in {"true", "1", "yes"}:
                    state = "assigned"
                elif value in {"false", "0", "no"}:
                    state = "unassigned"

        if state == "unassigned":
            # Ready-to-Go submissions carry a ``drafted_proposal_id``
            # from the moment the customer submits — the drafted
            # proposal IS the attachment and stops them from being
            # "unassigned triage items". Exclude both attachment paths
            # (project M2M + drafted proposal FK) so RTG rows don't
            # sit forever in the unassigned tab.
            queryset = queryset.filter(
                assignments__isnull=True,
                rejected_at__isnull=True,
                drafted_proposal__isnull=True,
            )
        elif state == "assigned":
            # Mirror of the unassigned branch — an RTG row with an
            # auto-drafted proposal counts as assigned, same as a
            # Custom row with a project link.
            queryset = queryset.filter(
                Q(assignments__isnull=False)
                | Q(drafted_proposal__isnull=False),
            ).distinct()
        elif state == "rejected":
            queryset = queryset.filter(rejected_at__isnull=False)
        # ``state == "all"`` (or unknown) → no additional filter.

        project_id = request.query_params.get("project_id")
        if project_id:
            # "Show every CFF linked to this project". One-to-many on
            # the through-table; ``.distinct()`` here is defensive —
            # the (submission, project) unique constraint prevents
            # duplicates today but a future schema change shouldn't
            # quietly turn the filter into a duplicate factory.
            queryset = (
                queryset
                .filter(assignments__project_id=project_id)
                .distinct()
            )

        search = (request.query_params.get("search") or "").strip()
        if search:
            # Postgres + SQLite both support icontains on JSONField
            # via the implicit cast to text. Good enough for the
            # tiny volumes here; if we ever need real FTS we can
            # extract the relevant fields into denormalised
            # columns.
            queryset = queryset.filter(raw_payload__icontains=search)

        return queryset


class CFFDetailView(APIView):
    """``GET /api/organizations/<org>/cff-submissions/<id>/``."""

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.VIEW

    def get(self, request: Request, org_id: str, submission_id: str) -> Response:
        submission = self._get(submission_id)
        return Response(CFFSubmissionSerializer(submission).data)

    def _get(self, submission_id: str) -> CFFSubmission:
        try:
            return (
                CFFSubmission.objects
                .prefetch_related(*_CFF_PREFETCH)
                .get(id=submission_id, organization=self.organization)
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc


class CFFAssignView(APIView):
    """``POST /api/organizations/<org>/cff-submissions/<id>/assign/``."""

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.ASSIGN_PROJECT

    def post(self, request: Request, org_id: str, submission_id: str) -> Response:
        serializer = AssignToProjectRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        project_id = serializer.validated_data["project_id"]

        try:
            submission = CFFSubmission.objects.get(
                id=submission_id, organization=self.organization,
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc

        try:
            project = Formulation.objects.get(
                id=project_id, organization=self.organization,
            )
        except Formulation.DoesNotExist as exc:
            # Project missing OR belongs to a different org. Either
            # way the caller has no business assigning to it.
            raise NotFound() from exc

        try:
            assign_to_project(
                submission=submission,
                project=project,
                actor=request.user,
                # Mirror the new-project flow: pick up the customer's
                # typed ``vita_manufacture_account_manager_email`` and
                # set the project's sales person if the slot is empty.
                # ``assign_to_project`` itself enforces the empty-slot
                # guard so a project that already has someone on it
                # won't get silently reassigned.
                can_assign_sales_person=True,
            )
        except CFFAssignmentError as exc:
            return Response(
                {"detail": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Refresh to pick up the join + audit fields the service set.
        submission = (
            CFFSubmission.objects
            .prefetch_related(*_CFF_PREFETCH)
            .get(id=submission.id)
        )
        return Response(CFFSubmissionSerializer(submission).data)


class CFFUnassignView(APIView):
    """``POST /api/organizations/<org>/cff-submissions/<id>/unassign/``.

    Body shape (all fields optional):

    * ``project_id`` — when supplied, detach **only** that one
      project link, leaving the rest of the CFF's assignments
      intact. Used by the per-row detach action on the detail
      modal.
    * Omitted / ``null`` — detach **every** link the CFF holds.
      Matches the legacy single-FK ``unassign`` behaviour and is
      what the inbox-row "back to triage" button calls.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.ASSIGN_PROJECT

    def post(self, request: Request, org_id: str, submission_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        serializer = UnassignFromProjectRequestSerializer(data=body)
        serializer.is_valid(raise_exception=True)
        project_id = serializer.validated_data.get("project_id")

        try:
            submission = CFFSubmission.objects.get(
                id=submission_id, organization=self.organization,
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc

        project: Formulation | None = None
        if project_id is not None:
            try:
                project = Formulation.objects.get(
                    id=project_id, organization=self.organization,
                )
            except Formulation.DoesNotExist as exc:
                # Project missing or belongs to a different org.
                # Same 404 shape as the assign endpoint so the
                # client error path is uniform.
                raise NotFound() from exc

        unassign(submission=submission, actor=request.user, project=project)
        submission = (
            CFFSubmission.objects
            .prefetch_related(*_CFF_PREFETCH)
            .get(id=submission.id)
        )
        return Response(CFFSubmissionSerializer(submission).data)


class CFFRejectView(APIView):
    """``POST /api/organizations/<org>/cff-submissions/<id>/reject/``.

    Body: ``{"reason": "<text>"}``. Marks the submission as rejected
    with the given reason so it leaves the triage queue and files
    into the Rejected tab. Idempotent — a second call refreshes the
    stored reason + actor + timestamp on top of any existing reject.

    Gated by the same ``assign_project`` capability as assign / unassign
    — reject is just the other half of the triage decision, so anyone
    who can route a CFF can also decline one. Splitting into its own
    capability would add role-configuration noise without matching any
    org's actual permissions matrix.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.ASSIGN_PROJECT

    def post(self, request: Request, org_id: str, submission_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        serializer = RejectRequestSerializer(data=body)
        serializer.is_valid(raise_exception=True)
        reason = serializer.validated_data["reason"]

        try:
            submission = CFFSubmission.objects.get(
                id=submission_id, organization=self.organization,
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc

        try:
            reject_submission(
                submission=submission,
                actor=request.user,
                reason=reason,
            )
        except CFFRejectionError as exc:
            return Response(
                {"detail": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        submission = (
            CFFSubmission.objects
            .prefetch_related(*_CFF_PREFETCH)
            .get(id=submission.id)
        )
        return Response(CFFSubmissionSerializer(submission).data)


class CFFUnrejectView(APIView):
    """``POST /api/organizations/<org>/cff-submissions/<id>/unreject/``.

    No body. Clears the rejection state (timestamp + actor + reason)
    and files the CFF back into the Unassigned queue so triage can
    reconsider. Idempotent on a CFF that was never rejected.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.ASSIGN_PROJECT

    def post(self, request: Request, org_id: str, submission_id: str) -> Response:
        try:
            submission = CFFSubmission.objects.get(
                id=submission_id, organization=self.organization,
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc

        unreject_submission(submission=submission, actor=request.user)

        submission = (
            CFFSubmission.objects
            .prefetch_related(*_CFF_PREFETCH)
            .get(id=submission.id)
        )
        return Response(CFFSubmissionSerializer(submission).data)


class CFFCreateProjectView(APIView):
    """``POST /api/organizations/<org>/cff-submissions/<id>/create-project/``.

    The "smooth triage" path: instead of switching to the projects
    page, the team member fills in a minimal form (name + code +
    optional dosage form) and the server does three things in one
    transaction:

    1. Create the :class:`Formulation` row.
    2. Attach the CFF to it.
    3. Best-effort auto-assign the sales person matched against the
       ``vita_manufacture_account_manager_email`` field on the CFF.

    Authorisation: caller needs **both** ``cff_submissions.assign_project``
    (to attach the CFF) **and** ``formulations.edit`` (to create the
    project). Auto-assignment of the sales person additionally
    requires ``formulations.assign_sales_person``; without it the
    project is still created + attached and the response signals to
    the UI that auto-assignment was skipped.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.ASSIGN_PROJECT

    def post(self, request: Request, org_id: str, submission_id: str) -> Response:
        membership = get_membership(request.user, self.organization)
        if membership is None:
            raise NotFound()

        if not has_capability(
            membership, FORMULATIONS_MODULE, FormulationsCapability.EDIT,
        ):
            return Response(
                {"detail": ["formulations_edit_required"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        # Sales-person assignment is a side-effect that can be
        # gracefully skipped — we don't 403 the whole request if
        # the caller lacks the cap, just record that we didn't
        # auto-assign and let the UI surface the situation.
        can_assign_sales = has_capability(
            membership,
            FORMULATIONS_MODULE,
            FormulationsCapability.ASSIGN_SALES_PERSON,
        )

        try:
            submission = CFFSubmission.objects.get(
                id=submission_id, organization=self.organization,
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc

        # No "already assigned" guard. Under the M2M shape a CFF can
        # spawn additional projects later in its lifecycle — a
        # follow-up call here simply appends a new link via
        # :func:`create_project_from_cff` → :func:`assign_to_project`.
        serializer = CreateProjectFromCFFRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        try:
            result = create_project_from_cff(
                submission=submission,
                actor=request.user,
                name=data["name"],
                code=data["code"],
                description=data.get("description", ""),
                dosage_form=data.get("dosage_form") or None,
                capsule_size=data.get("capsule_size", ""),
                tablet_size=data.get("tablet_size", ""),
                serving_size=data.get("serving_size") or 1,
                servings_per_pack=data.get("servings_per_pack") or 60,
                directions_of_use=data.get("directions_of_use", ""),
                suggested_dosage=data.get("suggested_dosage", ""),
                appearance=data.get("appearance", ""),
                disintegration_spec=data.get("disintegration_spec", ""),
                target_fill_weight_mg=data.get("target_fill_weight_mg"),
                powder_type=data.get("powder_type", ""),
                water_volume_ml=data.get("water_volume_ml"),
                can_assign_sales_person=can_assign_sales,
            )
        except CFFAssignmentError as exc:
            return Response(
                {"detail": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Mirror the manual new-project view's error mapping so the
        # CFF triage form surfaces the same per-field codes the
        # standalone new-project modal already handles. Without this
        # the create-from-cff endpoint would 500 on a duplicate code
        # instead of pointing the operator at the offending field.
        except FormulationCodeRequired:
            return Response(
                {"code": ["formulation_code_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FormulationCodeConflict:
            return Response(
                {"code": ["formulation_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidDosageForm:
            return Response(
                {"dosage_form": ["invalid_dosage_form"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidCapsuleSize:
            return Response(
                {"capsule_size": ["invalid_capsule_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidTabletSize:
            return Response(
                {"tablet_size": ["invalid_tablet_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidPowderType:
            return Response(
                {"powder_type": ["invalid_powder_type"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Refresh through the same prefetch path the detail endpoint
        # uses so the response carries the freshly-added assignment
        # row's project + assigned_by audit info the inbox needs.
        submission = (
            CFFSubmission.objects
            .prefetch_related(*_CFF_PREFETCH)
            .get(id=result.submission.id)
        )

        return Response(
            {
                "submission": CFFSubmissionSerializer(submission).data,
                "project": {
                    "id": str(result.project.id),
                    "code": result.project.code,
                    "name": result.project.name,
                },
                "auto_assigned_sales_person": (
                    {
                        "id": result.auto_assigned_sales_person_id,
                        "email": result.auto_assigned_sales_person_email,
                    }
                    if result.auto_assigned_sales_person_id
                    else None
                ),
                "cff_sales_person_email_hint": result.cff_sales_person_email_hint,
                "can_assign_sales_person": can_assign_sales,
            },
            status=status.HTTP_201_CREATED,
        )


class CFFSyncStatusView(APIView):
    """``GET /api/organizations/<org>/cff-submissions/sync-status/``.

    Tiny endpoint backing the "Last sync: X ago" banner on the
    CFF inbox. Returns:

    * ``last_poll_at`` — ISO timestamp stamped at the end of every
      successful poll cycle (whether or not anything changed). Null
      means the poller has not yet run for this org.
    * ``poll_interval_seconds`` — Celery beat cadence read from
      ``CELERY_BEAT_SCHEDULE`` so a future cadence change in
      settings propagates to the UI copy automatically.
    * ``enabled`` — whether the integration is currently live; the
      UI shows a different copy ("Sync disabled") when false.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        return Response(
            _build_sync_payload(self.organization),
            status=status.HTTP_200_OK,
        )


def _compute_state_counts(organization: Any, request: Request) -> dict[str, int]:
    """Return ``{unassigned, assigned, rejected}`` totals for the
    pipeline tab badges.

    Same ``search`` filter the list view applies so a narrowing
    query updates the badges alongside the visible rows. Each
    branch is an index-hitting COUNT — three cheap queries per
    inbox render, not one for every card.
    """

    base = CFFSubmission.objects.filter(organization=organization)
    search = (request.query_params.get("search") or "").strip()
    if search:
        base = base.filter(raw_payload__icontains=search)

    # Mirror the branching logic in ``CFFListView._filter`` so a
    # tab click on the FE lands on the same rows the badge
    # promised. RTG submissions with an auto-drafted proposal
    # count as ``assigned``; anything with an ``assignments`` link
    # or a ``drafted_proposal`` counts as assigned.
    unassigned = base.filter(
        assignments__isnull=True,
        rejected_at__isnull=True,
        drafted_proposal__isnull=True,
    ).count()
    assigned = (
        base.filter(
            Q(assignments__isnull=False) | Q(drafted_proposal__isnull=False)
        )
        .distinct()
        .count()
    )
    rejected = base.filter(rejected_at__isnull=False).count()
    return {
        "unassigned": unassigned,
        "assigned": assigned,
        "rejected": rejected,
    }


def _build_sync_payload(organization: Any) -> dict[str, Any]:
    """Shape the ``sync`` block consumed by the inbox banner.

    Lives at module scope so both :class:`CFFSyncStatusView` and
    :class:`CFFListView` produce the same payload. The frontend
    reuses one query-key for both, so any divergence here would
    show up as a banner that flickers between two truths when
    refetched from different sources.
    """

    from django.conf import settings as django_settings

    raw = organization.wix_cff_config or {}
    schedule = (
        django_settings.CELERY_BEAT_SCHEDULE.get("cff-submissions-poll")
        or {}
    )
    # ``schedule`` carries a ``crontab`` object or a float; we only
    # care about the float case here. Anything else surfaces as null
    # so the UI falls back to its hardcoded copy without crashing.
    raw_schedule = schedule.get("schedule")
    interval = (
        float(raw_schedule)
        if isinstance(raw_schedule, (int, float))
        else None
    )
    return {
        "enabled": bool(raw.get("enabled")),
        "last_poll_at": raw.get("last_poll_at"),
        "poll_interval_seconds": interval,
    }


class CFFFieldLabelsView(APIView):
    """``GET /api/organizations/<org>/cff-submissions/field-labels/``.

    Returns ``{form_id: {slug: label}}`` for every form the cache
    knows about. The list page calls this once on mount and reuses
    the map across rows so we don't make N round-trips for N
    submissions.
    """

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        # The org's configured form id is the only one we expect
        # rows for; serialising the whole cache anyway is cheap and
        # forward-compatible with a future multi-form intake.
        #
        # Single distinct query yields every ``(form_id, namespace)``
        # combination in one round-trip — the previous shape fired
        # one query for distinct form ids and then N additional
        # queries (one per form id) to fetch namespaces.
        labels_by_form: dict[str, dict[str, str]] = {}
        pairs = (
            CFFSubmission.objects
            .filter(organization=self.organization)
            .values_list("wix_form_id", "wix_namespace")
            .distinct()
        )
        for form_id, ns in pairs:
            labels = get_field_labels(form_id=str(form_id), namespace=ns)
            if labels:
                labels_by_form[str(form_id)] = labels
        return Response({"field_labels_by_form": labels_by_form})


# ---------------------------------------------------------------------------
# Integration settings (owner-only)
# ---------------------------------------------------------------------------


class WixCFFIntegrationView(APIView):
    """``GET`` / ``PUT`` / ``DELETE`` of the per-org Wix CFF config.

    Mirrors :class:`apps.customers.api.views.DynamicsIntegrationView`
    and :class:`apps.proposals.api.mrpeasy_views.MrpeasyIntegrationView`
    in shape so the frontend settings card consumes one consistent
    pattern across integrations.

    Plaintext API key is NEVER returned — the read shape includes a
    ``has_api_key`` flag and the form renders ``●●●●●●●`` until
    rotation.
    """

    permission_classes = (IsOrganizationOwner,)

    def get(self, request: Request, org_id: str) -> Response:
        return Response(
            serialize_wix_cff_config_for_api(self.organization),
            status=status.HTTP_200_OK,
        )

    def put(self, request: Request, org_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        payload = set_wix_cff_config(
            organization=self.organization,
            actor=request.user,
            enabled=bool(body.get("enabled", True)),
            site_id=str(body.get("site_id") or ""),
            form_id=str(body.get("form_id") or ""),
            namespace=str(body.get("namespace") or "wix.form_app.form"),
            api_key=body.get("api_key"),
        )
        return Response(payload, status=status.HTTP_200_OK)

    def delete(self, request: Request, org_id: str) -> Response:
        payload = clear_wix_cff_config(
            organization=self.organization, actor=request.user,
        )
        return Response(payload, status=status.HTTP_200_OK)


class WixCFFTestConnectionView(APIView):
    """``POST`` ``/api/organizations/<org>/integrations/wix-cff/test/``.

    Owner-only. Fires one cheap count probe against Wix. On success
    stamps ``last_tested_at`` and returns the submission count so
    the settings card can show "Connected — 11 submissions
    discovered".
    """

    permission_classes = (IsOrganizationOwner,)

    def post(self, request: Request, org_id: str) -> Response:
        try:
            total = verify_wix_cff_connection(
                organization=self.organization, actor=request.user,
            )
        except WixCFFNotConfigured:
            return Response(
                {"detail": ["wix_cff_not_configured"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except WixCFFDecryptionFailed:
            return Response(
                {"detail": ["wix_cff_decryption_failed"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except WixAPIError as exc:
            return _wix_error_response(exc)

        payload = serialize_wix_cff_config_for_api(self.organization)
        payload["total_submissions"] = total
        return Response(payload, status=status.HTTP_200_OK)


def _wix_error_response(exc: WixAPIError) -> Response:
    """Map a :class:`WixAPIError` to a typed 4xx/5xx response.

    The frontend reads ``detail[0]`` and looks up the message in
    its locale file — keep the codes in sync with
    ``client/src/i18n/locales/en/cff.json``.
    """

    if exc.status_code in (401, 403):
        code = "wix_cff_auth_failed"
        http_status = status.HTTP_400_BAD_REQUEST
    elif exc.status_code == 404:
        code = "wix_cff_not_found"
        http_status = status.HTTP_400_BAD_REQUEST
    elif exc.status_code == 429:
        code = "wix_cff_rate_limited"
        http_status = status.HTTP_429_TOO_MANY_REQUESTS
    elif exc.status_code >= 500:
        code = "wix_cff_unreachable"
        http_status = status.HTTP_502_BAD_GATEWAY
    else:
        code = "wix_cff_unknown_error"
        http_status = status.HTTP_400_BAD_REQUEST
    return Response({"detail": [code]}, status=http_status)
