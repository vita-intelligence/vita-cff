"""Views for the catalogues API."""

from __future__ import annotations

from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.catalogues.api.pagination import ItemCursorPagination
from apps.catalogues.api.permissions import (
    HasCatalogueListPermission,
    HasCataloguePermission,
)
from apps.catalogues.api.serializers import (
    CatalogueCreateSerializer,
    CatalogueReadSerializer,
    CatalogueUpdateSerializer,
    ItemReadSerializer,
    ItemWriteSerializer,
)
from apps.catalogues.services import (
    CatalogueIsSystem,
    CatalogueNotFound,
    CatalogueSlugConflict,
    CatalogueSlugInvalid,
    ItemImportError,
    ItemInternalCodeConflict,
    ItemNotFound,
    archive_item,
    build_import_template,
    create_catalogue,
    create_item,
    delete_catalogue,
    delete_item,
    get_catalogue,
    get_item,
    import_items_from_xlsx,
    list_catalogues,
    list_items,
    update_catalogue,
    update_item,
)
from apps.organizations.modules import (
    CATALOGUES_MODULE,
    CataloguesCapability,
)
from apps.organizations.services import has_capability
from apps.catalogues.models import (
    PACKAGING_SLUG,
    RAW_MATERIALS_SLUG,
    PSP_MIRROR_SLUG,
)
from apps.psp.services import (
    PspError,
    PspNotConfigured,
    PspDecryptionFailed,
    list_psp_items_strict,
)

# Catalogues whose CANONICAL data lives on PSP once the org's PSP
# integration is connected. The item picker for these three reads
# live from PSP (not the local table); the local rows are only ever
# the ``psp_mirror`` upsert target used on save.
_PSP_BACKED_CATALOGUE_SLUGS: frozenset[str] = frozenset(
    {RAW_MATERIALS_SLUG, PACKAGING_SLUG, PSP_MIRROR_SLUG}
)

# Catalogue slug → PSP item_type filter. ``psp_mirror`` is left open
# (all types) because it's the general-purpose mirror bucket.
_PSP_ITEM_TYPE_BY_SLUG: dict[str, list[str] | None] = {
    RAW_MATERIALS_SLUG: ["raw_material"],
    PACKAGING_SLUG: ["packaging"],
    PSP_MIRROR_SLUG: None,
}


def _psp_use_as_snake_to_title(value: str) -> str:
    """Translate a snake_case ``use_as`` value (which is what NPD's
    ``normalize_use_as_value`` emits) into PSP's Title-Case wire form
    so the ``?use_as=`` filter on PSP's integration endpoint matches.
    Falls back to the raw value on unknown keys so mis-spellings still
    hit PSP's own normaliser."""

    mapping = {
        "active": "Active",
        "sweetener": "Sweeteners",
        "bulking_agent": "Bulking Agent",
        "flavouring": "Flavouring",
        "colour": "Colour",
        "acidity_regulator": "Acidity Regulator",
        "glazing_agent": "Glazing Agent",
        "gelling_agent": "Gelling Agent",
        "emulsifier": "Emulsifier",
        "disintegrant": "Disintegrant",
        "stabiliser": "Stabiliser",
        "anti_caking": "Anti-caking Agent",
        "coating": "Coating Agent",
        "preservative": "Preservative",
        "carrier": "Carrier",
        "excipient": "Excipient",
        "capsule_shell": "Capsule Shell",
        "other": "Other",
    }
    return mapping.get(value, value)


def _psp_item_to_read_shape(item) -> dict:
    """Render a :class:`PspItem` in the same read shape the local
    ``ItemReadSerializer`` returns, so the picker component doesn't
    need to care whether the row is PSP-live or locally-mirrored."""

    return {
        "id": item.uuid,
        "name": item.name or "",
        "internal_code": item.code or item.external_sku or "",
        "unit": "",
        "base_price": (
            str(item.selling_price) if item.selling_price is not None else None
        ),
        "is_archived": not item.is_active,
        "attributes": dict(item.attributes or {}),
        "created_at": None,
        "updated_at": None,
    }


# ---------------------------------------------------------------------------
# Catalogue metadata endpoints
# ---------------------------------------------------------------------------


class CatalogueListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org_id>/catalogues/``.

    Listing returns every catalogue in the organization the caller
    has at least READ access on (owners see all). Creating is
    restricted to owners by :class:`HasCatalogueListPermission`.
    """

    permission_classes = (HasCatalogueListPermission,)

    def get(self, request: Request, org_id: str) -> Response:
        catalogues = list_catalogues(organization=self.organization)

        if not self.membership.is_owner:
            visible = []
            for catalogue in catalogues:
                if has_capability(
                    self.membership,
                    CATALOGUES_MODULE,
                    CataloguesCapability.VIEW,
                    scope=catalogue.slug,
                ):
                    visible.append(catalogue)
            catalogues = visible

        return Response(
            CatalogueReadSerializer(catalogues, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request, org_id: str) -> Response:
        serializer = CatalogueCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            catalogue = create_catalogue(
                organization=self.organization,
                actor=request.user,
                slug=serializer.validated_data["slug"],
                name=serializer.validated_data["name"],
                description=serializer.validated_data.get("description", ""),
            )
        except CatalogueSlugInvalid:
            return Response(
                {"slug": ["catalogue_slug_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CatalogueSlugConflict:
            return Response(
                {"slug": ["catalogue_slug_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            CatalogueReadSerializer(catalogue).data,
            status=status.HTTP_201_CREATED,
        )


class CatalogueDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/api/.../catalogues/<slug>/``."""

    permission_classes = (HasCataloguePermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        # PATCH on catalogue metadata + DELETE of the whole catalogue
        # are structural changes — gate them behind ``manage_fields``.
        if request.method == "GET":
            self.required_capability = CataloguesCapability.VIEW
        else:
            self.required_capability = CataloguesCapability.MANAGE_FIELDS
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str, slug: str) -> Response:
        return Response(
            CatalogueReadSerializer(self.catalogue).data,
            status=status.HTTP_200_OK,
        )

    def patch(self, request: Request, org_id: str, slug: str) -> Response:
        serializer = CatalogueUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = update_catalogue(
            catalogue=self.catalogue,
            actor=request.user,
            name=serializer.validated_data.get("name"),
            description=serializer.validated_data.get("description"),
        )
        return Response(
            CatalogueReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(self, request: Request, org_id: str, slug: str) -> Response:
        try:
            delete_catalogue(catalogue=self.catalogue, actor=request.user)
        except CatalogueIsSystem:
            return Response(
                {"detail": "catalogue_is_system"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Item endpoints (scoped to a catalogue slug)
# ---------------------------------------------------------------------------


class ItemListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/.../catalogues/<slug>/items/``."""

    permission_classes = (HasCataloguePermission,)

    ALLOWED_ORDER_FIELDS: frozenset = frozenset(
        {"name", "internal_code", "base_price", "updated_at"}
    )

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            CataloguesCapability.EDIT
            if request.method == "POST"
            else CataloguesCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str, slug: str) -> Response:
        include_archived = (
            request.query_params.get("include_archived", "").lower() == "true"
        )
        search = request.query_params.get("search", "") or None

        # ``?use_as=Sweeteners&use_as=Bulking+Agent`` — repeated param
        # narrows the list to items whose ``attributes.use_as`` sits
        # in the provided set. Values are normalised through the
        # same canonical vocabulary the rest of the system uses, so a
        # caller passing "Sweetners" still hits "Sweeteners" rows.
        raw_use_as = request.query_params.getlist("use_as")
        use_as_in: tuple[str, ...] | None
        if raw_use_as:
            from apps.formulations.constants import normalize_use_as_value

            canonicalised: list[str] = []
            for raw in raw_use_as:
                normalised = normalize_use_as_value(raw)
                if normalised:
                    canonicalised.append(normalised)
            use_as_in = tuple(dict.fromkeys(canonicalised)) or None
        else:
            use_as_in = None

        # PSP-source-of-truth branch: raw_materials / packaging /
        # psp_mirror pickers read live from PSP. No fallback to the
        # local table — a disconnected PSP surfaces as 503 so the
        # picker's error banner renders.
        if self.catalogue.slug in _PSP_BACKED_CATALOGUE_SLUGS:
            item_types = _PSP_ITEM_TYPE_BY_SLUG.get(self.catalogue.slug)
            use_as_values = list(use_as_in) if use_as_in else [None]
            try:
                collected: dict[str, object] = {}
                for canonical in use_as_values:
                    psp_use_as = (
                        _psp_use_as_snake_to_title(canonical)
                        if canonical
                        else None
                    )
                    for item in list_psp_items_strict(
                        organization=self.organization,
                        search=search,
                        item_types=item_types,
                        use_as=psp_use_as,
                    ):
                        if not include_archived and not item.is_active:
                            continue
                        collected.setdefault(item.uuid, item)
            except PspNotConfigured:
                return Response(
                    {
                        "detail": "PSP integration is not connected for this organization. Configure it at Settings → Integrations.",
                        "code": "psp_not_connected",
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            except (PspError, PspDecryptionFailed) as exc:
                return Response(
                    {
                        "detail": f"Failed to fetch items from PSP: {exc}",
                        "code": "psp_fetch_failed",
                    },
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )

            raw_order = request.query_params.get("ordering", "name")
            descending = raw_order.startswith("-")
            field = raw_order.lstrip("-").lower()
            if field not in {"name", "internal_code"}:
                field = "name"
                descending = False
            results = sorted(
                collected.values(),
                key=lambda x: (
                    (x.name or "").lower()
                    if field == "name"
                    else (x.code or x.external_sku or "").lower()
                ),
                reverse=descending,
            )
            return Response(
                {
                    "next": None,
                    "previous": None,
                    "results": [_psp_item_to_read_shape(x) for x in results],
                }
            )

        raw_order = request.query_params.get("ordering", "name")
        descending = raw_order.startswith("-")
        field = raw_order.lstrip("-")
        if field not in self.ALLOWED_ORDER_FIELDS:
            field = "name"
            descending = False
        primary = f"-{field}" if descending else field
        ordering = (primary, "-id")

        queryset = list_items(
            catalogue=self.catalogue,
            include_archived=include_archived,
            search=search,
            use_as_in=use_as_in,
        ).order_by(*ordering)

        paginator = ItemCursorPagination()
        paginator.ordering = ordering  # type: ignore[assignment]
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = ItemReadSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, org_id: str, slug: str) -> Response:
        serializer = ItemWriteSerializer(
            data=request.data,
            context={"catalogue": self.catalogue},
        )
        serializer.is_valid(raise_exception=True)
        try:
            item = create_item(
                catalogue=self.catalogue,
                actor=request.user,
                name=serializer.validated_data["name"],
                internal_code=serializer.validated_data.get("internal_code", ""),
                unit=serializer.validated_data.get("unit", ""),
                base_price=serializer.validated_data.get("base_price"),
                attributes=serializer.validated_data.get("attributes"),
            )
        except ItemInternalCodeConflict:
            return Response(
                {"internal_code": ["internal_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            ItemReadSerializer(item).data,
            status=status.HTTP_201_CREATED,
        )


class ItemDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/api/.../catalogues/<slug>/items/<id>/``."""

    permission_classes = (HasCataloguePermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = CataloguesCapability.VIEW
        elif request.method == "DELETE":
            # The DELETE endpoint supports both archive (soft) and hard
            # delete via ``?hard=true``; pick the gate at dispatch based
            # on the query string so archive stays an ``edit`` action.
            hard = request.query_params.get("hard", "").lower() == "true"
            self.required_capability = (
                CataloguesCapability.DELETE if hard else CataloguesCapability.EDIT
            )
        else:
            self.required_capability = CataloguesCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load_item(self, item_id: str):
        try:
            return get_item(catalogue=self.catalogue, item_id=item_id)
        except ItemNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, slug: str, item_id: str
    ) -> Response:
        item = self._load_item(item_id)
        return Response(ItemReadSerializer(item).data, status=status.HTTP_200_OK)

    def patch(
        self, request: Request, org_id: str, slug: str, item_id: str
    ) -> Response:
        item = self._load_item(item_id)
        serializer = ItemWriteSerializer(
            instance=item,
            data=request.data,
            partial=True,
            context={"catalogue": self.catalogue},
        )
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_item(
                item=item,
                actor=request.user,
                name=serializer.validated_data.get("name"),
                internal_code=serializer.validated_data.get("internal_code"),
                unit=serializer.validated_data.get("unit"),
                base_price=serializer.validated_data.get("base_price"),
                is_archived=serializer.validated_data.get("is_archived"),
                attributes=serializer.validated_data.get("attributes"),
            )
        except ItemInternalCodeConflict:
            return Response(
                {"internal_code": ["internal_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(ItemReadSerializer(updated).data, status=status.HTTP_200_OK)

    def delete(
        self, request: Request, org_id: str, slug: str, item_id: str
    ) -> Response:
        item = self._load_item(item_id)
        hard = request.query_params.get("hard", "").lower() == "true"
        if hard:
            delete_item(item=item, actor=request.user)
        else:
            archive_item(item=item, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ItemImportView(APIView):
    """``POST`` ``/api/.../catalogues/<slug>/items/import/``."""

    permission_classes = (HasCataloguePermission,)
    parser_classes = (MultiPartParser, FormParser)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = CataloguesCapability.IMPORT
        super().initial(request, *args, **kwargs)

    def post(self, request: Request, org_id: str, slug: str) -> Response:
        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"file": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            result = import_items_from_xlsx(
                catalogue=self.catalogue,
                actor=request.user,
                file=upload,
            )
        except ItemImportError as exc:
            return Response(
                {"file": [exc.code]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {
                "created": result.created,
                "errors": [
                    {"row": err.row, "errors": err.errors}
                    for err in result.errors
                ],
                "unmapped_columns": result.unmapped_columns,
            },
            status=status.HTTP_200_OK,
        )


class ItemImportTemplateView(APIView):
    """``GET`` ``/api/.../catalogues/<slug>/items/template/``.

    Returns an ``.xlsx`` file whose header row matches what
    :class:`ItemImportView` will accept on the way back. The template
    is generated on demand against the live attribute schema so a
    freshly-added attribute shows up without a code deploy.
    """

    permission_classes = (HasCataloguePermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = CataloguesCapability.IMPORT
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str, slug: str) -> HttpResponse:
        payload = build_import_template(catalogue=self.catalogue)
        filename = f"{self.catalogue.slug}_import_template.xlsx"
        response = HttpResponse(
            payload,
            content_type=(
                "application/vnd.openxmlformats-officedocument."
                "spreadsheetml.sheet"
            ),
        )
        response["Content-Disposition"] = (
            f'attachment; filename="{filename}"'
        )
        response["Content-Length"] = str(len(payload))
        return response
