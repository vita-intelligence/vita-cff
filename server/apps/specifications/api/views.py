"""Views for the specifications API."""

from __future__ import annotations

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.organizations.modules import PermissionLevel
from apps.specifications.api.pagination import SpecificationCursorPagination
from apps.specifications.api.permissions import HasSpecificationsPermission
from apps.specifications.api.serializers import (
    SpecificationSheetCreateSerializer,
    SpecificationSheetReadSerializer,
    SpecificationSheetUpdateSerializer,
    SpecificationStatusSerializer,
)
from apps.specifications.services import (
    FormulationVersionNotInOrg,
    InvalidStatusTransition,
    SpecificationCodeConflict,
    SpecificationNotFound,
    create_sheet,
    get_sheet,
    list_sheets,
    render_context,
    transition_status,
    update_sheet,
)


class SpecificationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/specifications/``."""

    permission_classes = (HasSpecificationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_level = (
            PermissionLevel.WRITE
            if request.method == "POST"
            else PermissionLevel.READ
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        queryset = list_sheets(organization=self.organization)
        paginator = SpecificationCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = SpecificationSheetReadSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, org_id: str) -> Response:
        serializer = SpecificationSheetCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            sheet = create_sheet(
                organization=self.organization,
                actor=request.user,
                formulation_version_id=data["formulation_version_id"],
                code=data.get("code", ""),
                client_name=data.get("client_name", ""),
                client_email=data.get("client_email", ""),
                client_company=data.get("client_company", ""),
                margin_percent=data.get("margin_percent"),
                final_price=data.get("final_price"),
                cover_notes=data.get("cover_notes", ""),
                total_weight_label=data.get("total_weight_label", ""),
            )
        except FormulationVersionNotInOrg:
            return Response(
                {
                    "formulation_version_id": [
                        "formulation_version_not_in_org"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationCodeConflict:
            return Response(
                {"code": ["specification_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            SpecificationSheetReadSerializer(sheet).data,
            status=status.HTTP_201_CREATED,
        )


class SpecificationDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/.../specifications/<id>/``."""

    permission_classes = (HasSpecificationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_level = PermissionLevel.READ
        elif request.method == "DELETE":
            self.required_level = PermissionLevel.ADMIN
        else:
            self.required_level = PermissionLevel.WRITE
        super().initial(request, *args, **kwargs)

    def _load(self, sheet_id: str):
        try:
            return get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, sheet_id: str) -> Response:
        sheet = self._load(sheet_id)
        return Response(
            SpecificationSheetReadSerializer(sheet).data,
            status=status.HTTP_200_OK,
        )

    def patch(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        serializer = SpecificationSheetUpdateSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_sheet(
                sheet=sheet,
                actor=request.user,
                **serializer.validated_data,
            )
        except SpecificationCodeConflict:
            return Response(
                {"code": ["specification_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        sheet.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SpecificationStatusView(APIView):
    """``POST`` ``/.../specifications/<id>/status/``."""

    permission_classes = (HasSpecificationsPermission,)
    required_level = PermissionLevel.WRITE

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc
        serializer = SpecificationStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            updated = transition_status(
                sheet=sheet,
                actor=request.user,
                next_status=serializer.validated_data["status"],
            )
        except InvalidStatusTransition:
            return Response(
                {"status": ["invalid_status_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )


class SpecificationRenderView(APIView):
    """``GET`` ``/.../specifications/<id>/render/``.

    Returns the flat view-model the frontend uses to paint the HTML
    spec sheet. Computed fresh each request from the locked-in
    ``FormulationVersion.snapshot_totals`` — no catalogue edits
    downstream can rewrite what a client sees once the sheet exists.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_level = PermissionLevel.READ

    def get(self, request: Request, org_id: str, sheet_id: str) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc
        return Response(render_context(sheet), status=status.HTTP_200_OK)
