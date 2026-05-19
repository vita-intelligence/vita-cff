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
    assign_to_project,
    create_project_from_cff,
    get_field_labels,
    unassign,
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
)

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
        queryset = (
            CFFSubmission.objects
            .select_related("project", "assigned_by")
            .filter(organization=self.organization)
        )
        queryset = self._filter(queryset, request)

        paginator = CFFCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = CFFSubmissionSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def _filter(self, queryset, request: Request):
        assigned_raw = request.query_params.get("assigned")
        if assigned_raw is not None:
            value = assigned_raw.strip().lower()
            if value in {"true", "1", "yes"}:
                queryset = queryset.filter(project__isnull=False)
            elif value in {"false", "0", "no"}:
                queryset = queryset.filter(project__isnull=True)

        project_id = request.query_params.get("project_id")
        if project_id:
            queryset = queryset.filter(project_id=project_id)

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
                .select_related("project", "assigned_by")
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
                submission=submission, project=project, actor=request.user,
            )
        except CFFAssignmentError as exc:
            return Response(
                {"detail": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Refresh to pick up the join + audit fields the service set.
        submission = (
            CFFSubmission.objects
            .select_related("project", "assigned_by")
            .get(id=submission.id)
        )
        return Response(CFFSubmissionSerializer(submission).data)


class CFFUnassignView(APIView):
    """``POST /api/organizations/<org>/cff-submissions/<id>/unassign/``."""

    permission_classes = (HasCFFPermission,)
    required_capability = CFFSubmissionsCapability.ASSIGN_PROJECT

    def post(self, request: Request, org_id: str, submission_id: str) -> Response:
        try:
            submission = CFFSubmission.objects.get(
                id=submission_id, organization=self.organization,
            )
        except CFFSubmission.DoesNotExist as exc:
            raise NotFound() from exc

        unassign(submission=submission, actor=request.user)
        submission = (
            CFFSubmission.objects
            .select_related("project", "assigned_by")
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

        if submission.project_id is not None:
            return Response(
                {"detail": ["cff_already_assigned"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

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

        # Refresh through the same select_related path the detail
        # endpoint uses so the response carries the project +
        # assigned_by audit info the inbox needs.
        submission = (
            CFFSubmission.objects
            .select_related("project", "assigned_by")
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
        from django.conf import settings as django_settings

        raw = self.organization.wix_cff_config or {}
        schedule = (
            django_settings.CELERY_BEAT_SCHEDULE.get(
                "cff-submissions-poll"
            )
            or {}
        )
        # ``schedule`` carries a ``crontab`` object or a float; we
        # only care about the float case here. Anything else
        # surfaces as null so the UI falls back to its hardcoded
        # copy without crashing.
        raw_schedule = schedule.get("schedule")
        interval = (
            float(raw_schedule)
            if isinstance(raw_schedule, (int, float))
            else None
        )
        return Response(
            {
                "enabled": bool(raw.get("enabled")),
                "last_poll_at": raw.get("last_poll_at"),
                "poll_interval_seconds": interval,
            },
            status=status.HTTP_200_OK,
        )


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
        labels_by_form: dict[str, dict[str, str]] = {}
        for form_id in (
            CFFSubmission.objects
            .filter(organization=self.organization)
            .values_list("wix_form_id", flat=True)
            .distinct()
        ):
            namespaces = (
                CFFSubmission.objects
                .filter(organization=self.organization, wix_form_id=form_id)
                .values_list("wix_namespace", flat=True)
                .distinct()
            )
            for ns in namespaces:
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
