"""Views for the specifications API."""

from __future__ import annotations

from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.organizations.modules import FormulationsCapability
from apps.specifications.api.pagination import SpecificationCursorPagination
from apps.specifications.api.permissions import HasSpecificationsPermission
from apps.specifications.api.serializers import (
    SpecificationPackagingSerializer,
    SpecificationSheetCreateSerializer,
    SpecificationSheetReadSerializer,
    SpecificationSheetUpdateSerializer,
    SpecificationStatusSerializer,
)
from apps.catalogues.models import Catalogue, Item, PACKAGING_SLUG
from apps.specifications.services import (
    FormulationVersionNotInOrg,
    InvalidStatusTransition,
    PACKAGING_SLOT_TYPES,
    PackagingItemNotAllowed,
    PublicLinkNotEnabled,
    SpecificationCodeConflict,
    SpecificationNotFound,
    create_sheet,
    get_by_public_token,
    get_sheet,
    list_sheets,
    render_context,
    render_pdf,
    revoke_public_token,
    rotate_public_token,
    set_packaging,
    transition_status,
    update_sheet,
)


class SpecificationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/specifications/``."""

    permission_classes = (HasSpecificationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        # Optional ?formulation_id scopes the list to one project —
        # drives the Spec Sheets tab on the project workspace.
        formulation_id = request.query_params.get("formulation_id") or None
        queryset = list_sheets(
            organization=self.organization,
            formulation_id=formulation_id,
        )
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
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
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
        from apps.audit.services import record as record_audit, snapshot

        sheet = self._load(sheet_id)
        organization = sheet.organization
        target_id = str(sheet.pk)
        before = snapshot(sheet)
        sheet.delete()
        record_audit(
            organization=organization,
            actor=request.user,
            action="spec_sheet.delete",
            target=None,
            target_type="specificationsheet",
            target_id=target_id,
            before=before,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class SpecificationStatusView(APIView):
    """``POST`` ``/.../specifications/<id>/status/``."""

    permission_classes = (HasSpecificationsPermission,)
    # Status transitions (draft → in_review → sent → approved/accepted)
    # are approvals, not edits — a scientist with ``edit`` can build a
    # draft but not send it to a client.
    required_capability = FormulationsCapability.APPROVE

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
                notes=serializer.validated_data.get("notes", ""),
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
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str, sheet_id: str) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc
        return Response(render_context(sheet), status=status.HTTP_200_OK)


class SpecificationPdfView(APIView):
    """``GET`` ``/.../specifications/<id>/pdf/``.

    Streams a WeasyPrint-generated PDF of the spec sheet. Same
    read-only permission as the JSON render endpoint — anyone who can
    view the sheet in the browser can download it as PDF.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, sheet_id: str
    ) -> HttpResponse:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

        pdf_bytes, filename = render_pdf(sheet)
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        # ``inline`` lets the browser preview in-tab; the frontend
        # adds ?download=1 when it wants to force a save-as dialog.
        disposition = (
            "attachment"
            if request.query_params.get("download") in {"1", "true"}
            else "inline"
        )
        response["Content-Disposition"] = (
            f'{disposition}; filename="{filename}"'
        )
        return response


class SpecificationPackagingView(APIView):
    """``POST`` ``/.../specifications/<id>/packaging/``.

    Partial update of one or more of the four packaging slots. The
    body is a subset of ``{packaging_lid, packaging_container,
    packaging_label, packaging_antitemper}`` — each value is an item
    UUID from the org packaging catalogue, or ``null`` to clear that
    slot. Unspecified slots are left untouched.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

        serializer = SpecificationPackagingSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        selections = {
            key: str(value) if value is not None else None
            for key, value in serializer.validated_data.items()
        }
        try:
            updated = set_packaging(
                sheet=sheet,
                actor=request.user,
                selections=selections,
            )
        except PackagingItemNotAllowed:
            return Response(
                {"packaging": ["packaging_item_not_allowed"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )


#: Default / max values for the packaging search endpoint. The hard
#: cap exists so a misbehaving client cannot ask for "give me the
#: whole catalogue" in one round-trip.
_PACKAGING_DEFAULT_LIMIT = 50
_PACKAGING_MAX_LIMIT = 200


class SpecificationPackagingOptionsView(APIView):
    """``GET`` ``/.../specifications/packaging-options/``.

    Server-side search across the org's packaging catalogue,
    scoped to one slot at a time. Query parameters:

    - ``slot`` (required) — one of the four packaging slots.
    - ``search`` (optional) — substring matched case-insensitively
      against ``name`` and ``internal_code``.
    - ``limit`` (optional) — page size, defaults to 50, clamped to 200.

    The endpoint deliberately returns only what the caller asks
    for: at catalogue scale (potentially millions of packaging
    rows across orgs) shipping everything at once is a non-starter
    for both the wire and the browser. The picker component on the
    client debounces ``search`` keystrokes so the typing latency is
    a single round-trip per pause.

    Performance note: the underlying filter joins on the ``(catalogue,
    name)`` index for the ORDER + LIMIT, then filters
    ``attributes->>'packaging_type'`` in-memory. For tenants pushing
    past ~100K packaging rows, the long-term fix is to denormalise
    ``packaging_type`` to a real column so a composite index picks up
    the full predicate — tracked out of band, not blocking F4.1.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        slot = request.query_params.get("slot")
        if slot not in PACKAGING_SLOT_TYPES:
            return Response(
                {"slot": ["invalid_slot"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        expected_type = PACKAGING_SLOT_TYPES[slot]

        search = (request.query_params.get("search") or "").strip()

        try:
            raw_limit = int(request.query_params.get("limit") or _PACKAGING_DEFAULT_LIMIT)
        except (TypeError, ValueError):
            raw_limit = _PACKAGING_DEFAULT_LIMIT
        limit = max(1, min(raw_limit, _PACKAGING_MAX_LIMIT))

        catalogue = Catalogue.objects.filter(
            organization=self.organization, slug=PACKAGING_SLUG
        ).first()
        if catalogue is None:
            return Response({"results": [], "slot": slot, "limit": limit})

        queryset = Item.objects.filter(
            catalogue=catalogue,
            is_archived=False,
            attributes__packaging_type=expected_type,
        )
        if search:
            from django.db.models import Q

            queryset = queryset.filter(
                Q(name__icontains=search)
                | Q(internal_code__icontains=search)
            )
        items = list(
            queryset.order_by("name").values("id", "name", "internal_code")[
                :limit
            ]
        )
        results = [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "internal_code": row["internal_code"],
            }
            for row in items
        ]
        return Response({"results": results, "slot": slot, "limit": limit})


class SpecificationPublicLinkView(APIView):
    """``POST`` rotates (or issues) the sheet's public preview token;
    ``DELETE`` revokes it. Gated on ``approve`` because publishing a
    spec sheet to a client is a commercial decision, not a content
    edit."""

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.APPROVE

    def _load(self, sheet_id: str):
        try:
            return get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        updated = rotate_public_token(sheet=sheet, actor=request.user)
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        revoke_public_token(sheet=sheet, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Public (token-gated, no authentication) endpoints
# ---------------------------------------------------------------------------


class PublicSpecificationRenderView(APIView):
    """``GET`` ``/api/public/specifications/<token>/``.

    Unauthenticated read-only render of a shared sheet. Identical
    payload to :class:`SpecificationRenderView` so the same frontend
    component can consume it. Returns 404 for any malformed, unknown,
    or revoked token — the single error code deliberately blurs the
    distinction so a leaked link cannot be probed.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> Response:
        try:
            sheet = get_by_public_token(token)
        except PublicLinkNotEnabled as exc:
            raise NotFound() from exc
        return Response(render_context(sheet), status=status.HTTP_200_OK)


class PublicSpecificationPdfView(APIView):
    """Token-gated PDF download — same body as the authenticated PDF
    view but reached via the public token."""

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> HttpResponse:
        try:
            sheet = get_by_public_token(token)
        except PublicLinkNotEnabled as exc:
            raise NotFound() from exc

        pdf_bytes, filename = render_pdf(sheet)
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        disposition = (
            "attachment"
            if request.query_params.get("download") in {"1", "true"}
            else "inline"
        )
        response["Content-Disposition"] = (
            f'{disposition}; filename="{filename}"'
        )
        return response
