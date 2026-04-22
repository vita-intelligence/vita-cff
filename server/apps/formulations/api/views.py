"""Views for the formulations API."""

from __future__ import annotations

from dataclasses import asdict
from decimal import Decimal
from typing import Any

from django.db.models import ProtectedError
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.pagination import FormulationCursorPagination
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.api.serializers import (
    FormulationLineWriteSerializer,
    FormulationReadSerializer,
    FormulationVersionReadSerializer,
    FormulationWriteSerializer,
    ReplaceLinesSerializer,
    RollbackVersionSerializer,
    SaveVersionSerializer,
)
from apps.formulations.overview import compute_project_overview
from apps.formulations.services import (
    FormulationCodeConflict,
    FormulationNotFound,
    FormulationVersionNotFound,
    InvalidCapsuleSize,
    InvalidDosageForm,
    InvalidTabletSize,
    RawMaterialNotInOrg,
    SalesPersonNotMember,
    assign_sales_person,
    compute_formulation_totals,
    create_formulation,
    get_formulation,
    list_formulations,
    list_versions,
    replace_lines,
    rollback_to_version,
    save_version,
    update_formulation,
)
from apps.organizations.modules import FormulationsCapability


def _totals_payload(totals) -> dict[str, Any]:
    def _as_str(value: Decimal | None) -> str | None:
        return None if value is None else str(value)

    excipients_payload = None
    if totals.excipients is not None:
        excipients_payload = {
            "mg_stearate_mg": _as_str(totals.excipients.mg_stearate_mg),
            "silica_mg": _as_str(totals.excipients.silica_mg),
            "mcc_mg": _as_str(totals.excipients.mcc_mg),
            "dcp_mg": _as_str(totals.excipients.dcp_mg),
        }

    return {
        "total_active_mg": _as_str(totals.total_active_mg),
        "dosage_form": totals.dosage_form,
        "size_key": totals.size_key,
        "size_label": totals.size_label,
        "max_weight_mg": _as_str(totals.max_weight_mg),
        "total_weight_mg": _as_str(totals.total_weight_mg),
        "excipients": excipients_payload,
        "viability": {
            "fits": totals.viability.fits,
            "comfort_ok": totals.viability.comfort_ok,
            "codes": list(totals.viability.codes),
        },
        "warnings": list(totals.warnings),
        "line_values": {
            external_id: str(value)
            for external_id, value in totals.line_values.items()
        },
    }


class FormulationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/formulations/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        queryset = list_formulations(organization=self.organization)
        paginator = FormulationCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = FormulationReadSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, org_id: str) -> Response:
        serializer = FormulationWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            formulation = create_formulation(
                organization=self.organization,
                actor=request.user,
                name=data["name"],
                code=data.get("code", ""),
                description=data.get("description", ""),
                dosage_form=data.get("dosage_form", "capsule"),
                capsule_size=data.get("capsule_size", ""),
                tablet_size=data.get("tablet_size", ""),
                serving_size=data.get("serving_size", 1),
                servings_per_pack=data.get("servings_per_pack", 60),
                target_fill_weight_mg=data.get("target_fill_weight_mg"),
                directions_of_use=data.get("directions_of_use", ""),
                suggested_dosage=data.get("suggested_dosage", ""),
                appearance=data.get("appearance", ""),
                disintegration_spec=data.get("disintegration_spec", ""),
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
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_201_CREATED,
        )


class FormulationDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/.../formulations/<id>/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, formulation_id: str):
        try:
            return get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )

    def patch(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        serializer = FormulationWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_formulation(
                formulation=formulation,
                actor=request.user,
                **serializer.validated_data,
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
        return Response(
            FormulationReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        from apps.audit.services import record as record_audit, snapshot

        formulation = self._load(formulation_id)
        # Snapshot + capture the pk BEFORE the cascade wipes them;
        # we still want a meaningful audit row after the row is
        # gone.
        before = snapshot(formulation)
        organization = formulation.organization
        target_id = str(formulation.pk)
        try:
            formulation.delete()
        except ProtectedError:
            # A downstream ``PROTECT`` FK is blocking the cascade —
            # most commonly a :class:`TrialBatch` still pointing at
            # one of this project's :class:`FormulationVersion`s,
            # since batches are production records we refuse to lose
            # silently. Surface a translatable code so the frontend
            # can explain *why* rather than hiding behind a generic
            # "couldn't delete" toast.
            return Response(
                {
                    "detail": ["formulation_has_dependencies"],
                    "code": "formulation_has_dependencies",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        record_audit(
            organization=organization,
            actor=request.user,
            action="formulation.delete",
            target=None,
            target_type="formulation",
            target_id=target_id,
            before=before,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class FormulationSalesPersonView(APIView):
    """``PUT`` ``/.../formulations/<id>/sales-person/``.

    Dedicated endpoint so the capability check is unambiguous: only
    callers with ``formulations.assign_sales_person`` can hit this
    URL, regardless of whether they also hold the project ``edit``
    grant. The body accepts ``{"user_id": "<uuid>" | null}``; a
    ``null`` clears the current assignment.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.ASSIGN_SALES_PERSON

    def put(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        payload = request.data if isinstance(request.data, dict) else {}
        raw_user_id = payload.get("user_id", object())
        if raw_user_id is object():
            return Response(
                {"user_id": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sales_person = None
        if raw_user_id is not None:
            from django.contrib.auth import get_user_model

            User = get_user_model()
            sales_person = User.objects.filter(id=raw_user_id).first()
            if sales_person is None:
                # Treat an unresolved user UUID identically to a
                # cross-tenant user — don't leak existence through
                # a distinct error code.
                return Response(
                    {"user_id": ["sales_person_not_member"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            assign_sales_person(
                formulation=formulation,
                sales_person=sales_person,
                actor=request.user,
            )
        except SalesPersonNotMember:
            return Response(
                {"user_id": ["sales_person_not_member"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationLinesView(APIView):
    """``PUT`` ``/.../formulations/<id>/lines/`` — atomic replace."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def put(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        serializer = ReplaceLinesSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            replace_lines(
                formulation=formulation,
                actor=request.user,
                lines=list(serializer.validated_data["lines"]),
            )
        except RawMaterialNotInOrg:
            return Response(
                {"lines": ["raw_material_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationComputeView(APIView):
    """``GET`` ``/.../formulations/<id>/compute/`` — dry-run totals.

    Called by the builder UI every time the scientist edits a line
    without saving, so the viability chip updates live. No state
    changes — pure read with freshly computed math.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        totals = compute_formulation_totals(formulation=formulation)
        return Response(_totals_payload(totals), status=status.HTTP_200_OK)


class FormulationVersionListView(APIView):
    """``GET`` / ``POST`` ``/.../formulations/<id>/versions/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _load(self, formulation_id: str):
        try:
            return get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        versions = list_versions(formulation=formulation)
        return Response(
            FormulationVersionReadSerializer(versions, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        serializer = SaveVersionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        version = save_version(
            formulation=formulation,
            actor=request.user,
            label=serializer.validated_data.get("label", ""),
        )
        return Response(
            FormulationVersionReadSerializer(version).data,
            status=status.HTTP_201_CREATED,
        )


class FormulationRollbackView(APIView):
    """``POST`` ``/.../formulations/<id>/rollback/`` — restore + snapshot."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        serializer = RollbackVersionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            rollback_to_version(
                formulation=formulation,
                actor=request.user,
                version_number=serializer.validated_data["version_number"],
            )
        except FormulationVersionNotFound:
            return Response(
                {"version_number": ["formulation_version_not_found"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except RawMaterialNotInOrg:
            return Response(
                {"lines": ["raw_material_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        formulation.refresh_from_db()
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationOverviewView(APIView):
    """``GET`` ``/.../formulations/<id>/overview/``.

    One-shot aggregator for the Project workspace's Overview tab.
    Computes counts + compliance + allergens + activity feed across
    every child surface (spec sheets, trial batches, QC validations)
    so the dashboard paints in a single round-trip.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        overview = compute_project_overview(formulation)
        return Response(asdict(overview), status=status.HTTP_200_OK)
