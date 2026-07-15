"""PSP integration API surface.

Three groups of endpoints:

* ``GET / PUT / DELETE /api/organizations/<org>/integrations/psp/``
  — settings CRUD, owner-only. Plaintext token never returned;
  ``has_token`` boolean instead.
* ``POST /api/organizations/<org>/integrations/psp/test/`` —
  owner-only round-trip against PSP's health endpoint.
* ``GET /api/organizations/<org>/integrations/psp/items/`` +
  ``GET /api/organizations/<org>/integrations/psp/items/<uuid>/``
  — picker-facing. Any member with ``formulations.view`` can call
  these so the builder + price-hint UI can render inline.

Mirrors the MRPEasy API layout (``proposals/api/mrpeasy_views.py``)
so operators moving between the two integration cards see the same
control shape. Consumer swaps (formulation builder pickers, price
hint UI) land in follow-up PRs — this PR is plumbing only.
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.models import Membership
from apps.organizations.modules import FormulationsCapability
from apps.psp.services import (
    PspAuthFailed,
    PspDecryptionFailed,
    PspError,
    PspInvalidConfig,
    PspMirrorItemNotFound,
    PspNotConfigured,
    PspRateLimited,
    PspUnreachable,
    clear_psp_config,
    get_psp_item,
    list_psp_items,
    mirror_psp_item,
    serialize_psp_config_for_api,
    set_psp_config,
    verify_psp_connection,
)


class _OwnerOnly(HasFormulationsPermission):
    """The integration config holds credentials — only org owners
    can read / write / clear / test it. Non-owners can still use
    the picker endpoints below (gated on ``formulations.view``)."""

    def has_permission(  # type: ignore[override]
        self, request: Request, view: APIView
    ) -> bool:
        if not super().has_permission(request, view):
            return False
        organization = getattr(view, "organization", None)
        if organization is None:
            return False
        is_owner = Membership.objects.filter(
            organization=organization,
            user=request.user,
            is_owner=True,
        ).exists()
        return bool(is_owner)


def _psp_error_response(exc: PspError) -> Response:
    """Map a typed PSP exception onto the right HTTP response.

    Mirrors the MRPEasy mapping so the settings UI can render the
    same error chips regardless of which integration bounced.
    """

    code = getattr(exc, "code", "psp_unreachable")
    if isinstance(exc, (PspAuthFailed, PspDecryptionFailed)):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(exc, PspRateLimited):
        status_code = status.HTTP_429_TOO_MANY_REQUESTS
    elif isinstance(exc, PspInvalidConfig):
        status_code = status.HTTP_400_BAD_REQUEST
    else:
        status_code = status.HTTP_502_BAD_GATEWAY
    return Response(
        {"detail": [code], "message": str(exc)},
        status=status_code,
    )


class PspIntegrationView(APIView):
    """``GET`` / ``PUT`` / ``DELETE``
    ``/api/organizations/<org>/integrations/psp/``.

    Owner-only. The plaintext integration token is NEVER returned
    — the read shape carries a ``has_token`` boolean instead so
    the form can render a "●●●●●●●" placeholder without leaking
    the value. ``last_tested_at`` is the operator's "this
    connection works as of …" badge; clears on every token change.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        return Response(
            serialize_psp_config_for_api(self.organization),
            status=status.HTTP_200_OK,
        )

    def put(self, request: Request, org_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        payload = set_psp_config(
            organization=self.organization,
            actor=request.user,
            enabled=bool(body.get("enabled", True)),
            base_url=str(body.get("base_url") or ""),
            # ``None`` is the "keep existing token" sentinel — same
            # UX as the MRPEasy / Dynamics forms. Empty string also
            # preserves, so an operator can save a URL change
            # without re-typing the token.
            integration_token=body.get("integration_token"),
        )
        return Response(payload, status=status.HTTP_200_OK)

    def delete(self, request: Request, org_id: str) -> Response:
        payload = clear_psp_config(
            organization=self.organization, actor=request.user
        )
        return Response(payload, status=status.HTTP_200_OK)


class PspTestConnectionView(APIView):
    """``POST`` ``/api/organizations/<org>/integrations/psp/test/``.

    Owner-only. Round-trips PSP's health endpoint. Returns 200 with
    the updated config on success (``last_tested_at`` stamped);
    400 / 429 / 502 with a codified error on failure.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def post(self, request: Request, org_id: str) -> Response:
        try:
            payload = verify_psp_connection(
                organization=self.organization, actor=request.user
            )
        except PspNotConfigured:
            return Response(
                {"detail": ["psp_not_configured"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except PspError as exc:
            return _psp_error_response(exc)
        return Response(payload, status=status.HTTP_200_OK)


class PspItemListView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/items/``.

    Picker-facing. Accepts ``?search=``, ``?item_types=raw_material,
    packaging`` (comma-separated), ``?use_as=flavouring``. Silent
    degradation — outages return an empty ``items`` array, never a
    5xx, so the modal stays functional.

    Response shape:

    .. code-block:: json

        {"items": [
          {
            "uuid": "...",
            "name": "Vitamin C 500mg",
            "description": "Ascorbic acid powder",
            "item_type": "raw_material",
            "external_sku": "VIT-C-500",
            "barcode": "5000000123456",
            "is_active": true,
            "use_as": "active",
            "product_family": {"uuid": "...", "name": "Vitamins"},
            "selling_price": "5.2500",
            "currency_code": "GBP"
          }
        ]}
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        search = (request.query_params.get("search") or "").strip() or None
        use_as = (request.query_params.get("use_as") or "").strip() or None
        raw_types = request.query_params.get("item_types") or ""
        item_types = [
            t.strip() for t in raw_types.split(",") if t.strip()
        ] or None
        items = list_psp_items(
            organization=self.organization,
            search=search,
            item_types=item_types,
            use_as=use_as,
        )
        return Response(
            {"items": [_serialize_item(i) for i in items]},
            status=status.HTTP_200_OK,
        )


class PspItemDetailView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/items/<uuid>/``.

    Picker-facing single-item lookup. ``{"matched": false, "uuid":
    "..."}`` on any miss / failure so the FE branches identically
    for "no such item" and "PSP outage" — the operator's flow must
    never be blocked by an integration error mid-modal.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, item_uuid: str
    ) -> Response:
        item = get_psp_item(
            organization=self.organization, uuid=item_uuid
        )
        if item is None:
            return Response(
                {"matched": False, "uuid": item_uuid},
                status=status.HTTP_200_OK,
            )
        return Response(
            {"matched": True, "item": _serialize_item(item)},
            status=status.HTTP_200_OK,
        )


class PspItemMirrorView(APIView):
    """``POST`` ``/api/organizations/<org>/integrations/psp/items/<uuid>/mirror/``.

    Load-bearing endpoint for the builder swap: takes a PSP item
    UUID, fetches the row from PSP, upserts it into the org's
    ``psp_mirror`` local catalogue, and returns the local
    :class:`catalogues.Item` DTO. The FE picker calls this on pick
    and then hands the local UUID to the formulation-builder's
    existing "add ingredient" flow — every downstream consumer
    (compute, spec sheet, BOM) operates on a normal local Item so
    nothing else needs to change.

    Gated on ``formulations.edit`` — same capability that already
    permits adding an ingredient to a formulation. Non-editors get
    403 so a view-only reviewer can browse but not mirror.

    Failure modes:

    * ``400 psp_not_configured`` — org has no live PSP integration.
    * ``404 psp_mirror_item_not_found`` — PSP has no row for the
      requested UUID (deleted / archived / wrong tenant scope).
    * ``400 / 429 / 502`` — network / auth / rate-limit errors,
      same mapping as the other PSP endpoints.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, item_uuid: str
    ) -> Response:
        try:
            item = mirror_psp_item(
                organization=self.organization,
                actor=request.user,
                psp_item_uuid=item_uuid,
            )
        except PspNotConfigured:
            return Response(
                {"detail": ["psp_not_configured"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except PspMirrorItemNotFound:
            return Response(
                {"detail": ["psp_mirror_item_not_found"]},
                status=status.HTTP_404_NOT_FOUND,
            )
        except PspError as exc:
            return _psp_error_response(exc)

        # Return the local Item shape so the FE picker can push it
        # into the builder's ``addIngredient(item)`` flow without a
        # follow-up round-trip to the catalogues API. Mirrors the
        # ``ItemDto`` the local catalogue endpoints already emit.
        return Response(
            {
                "id": str(item.id),
                "catalogue_id": str(item.catalogue_id),
                "name": item.name,
                "internal_code": item.internal_code,
                "unit": item.unit,
                "base_price": (
                    str(item.base_price) if item.base_price is not None else None
                ),
                "attributes": item.attributes or {},
                "is_archived": item.is_archived,
                "psp_source_uuid": (
                    str(item.psp_source_uuid) if item.psp_source_uuid else None
                ),
            },
            status=status.HTTP_200_OK,
        )


def _serialize_item(item: Any) -> dict[str, Any]:
    """Wire shape for a PSP item on the NPD read surface. Mirrors
    the PSP-side response verbatim so proxying is transparent — the
    NPD FE can treat this endpoint as a same-origin drop-in for
    the upstream PSP call."""

    return {
        "uuid": item.uuid,
        "name": item.name,
        "description": item.description,
        "item_type": item.item_type,
        "external_sku": item.external_sku,
        # System-generated display code (``MA00295``) — what PSP's
        # UI prints as "Code". The FE picker prefers this over
        # ``external_sku`` since every item has one by default,
        # whereas supplier SKUs are optional.
        "code": item.code,
        "barcode": item.barcode,
        "is_active": item.is_active,
        "use_as": item.use_as,
        "product_family": (
            {
                "uuid": item.product_family_uuid,
                "name": item.product_family_name,
            }
            if item.product_family_uuid
            else None
        ),
        "selling_price": (
            str(item.selling_price)
            if item.selling_price is not None
            else None
        ),
        "currency_code": item.currency_code,
        # Full attributes map — carries the compute-critical keys
        # (``purity``, ``overage``, ``extract_ratio``, ``type``,
        # allergen flags, country of origin, ...). Without this the
        # builder's ``canComputeMaterial`` gate fires "missing_purity"
        # on every PSP-sourced picker row, since ``item.attributes``
        # on the FE would default to ``{}``.
        "attributes": item.attributes or {},
    }
