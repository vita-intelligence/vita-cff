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
    PspCreateFinishedProductFailed,
    PspNotConfigured,
    PspRateLimited,
    PspUnreachable,
    clear_psp_config,
    create_psp_finished_product,
    get_psp_item,
    get_psp_item_bom,
    list_psp_allergens,
    list_psp_items,
    list_psp_product_families,
    list_psp_storage_tags,
    list_psp_units_of_measurement,
    list_psp_workstation_groups,
    list_psp_workstation_users,
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
        # ``ui_base_url`` — pass the raw value through (empty string
        # or absent = "no override"). Absent (``None``) preserves
        # any stored value; empty string clears; non-empty replaces.
        # Same key handling as ``integration_token``'s keep-existing
        # sentinel.
        raw_ui_base_url = body.get("ui_base_url")
        payload = set_psp_config(
            organization=self.organization,
            actor=request.user,
            enabled=bool(body.get("enabled", True)),
            base_url=str(body.get("base_url") or ""),
            ui_base_url=raw_ui_base_url,
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


class PspItemBomView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/items/<uuid>/bom/``.

    Live-read of a PSP item's active primary BOM. The stage strip
    calls this per-stage so each card renders the recipe of record
    from PSP — no local synthesis, no "copied from the semi"
    guesswork. Silent-degrade: ``{"bom": null}`` on missing / off /
    error, so the FE renders "not on PSP yet" identically for every
    reason it might be empty.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, item_uuid: str
    ) -> Response:
        bom = get_psp_item_bom(
            organization=self.organization, uuid=item_uuid
        )
        return Response({"bom": bom}, status=status.HTTP_200_OK)


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


class PspWorkstationUserListView(APIView):
    """``GET``
    ``/api/organizations/<org>/integrations/psp/workstation-users/``.

    Proxies PSP's ``/api/integration/users`` for the stage
    builder's workers multi-picker. Silent-degrade on any failure —
    empty ``items`` list is indistinguishable from a genuinely
    empty PSP catalog.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        rows = list_psp_workstation_users(organization=self.organization)
        return Response({"items": rows}, status=status.HTTP_200_OK)


class PspWorkstationGroupListView(APIView):
    """``GET``
    ``/api/organizations/<org>/integrations/psp/workstation-groups/``.

    Proxies PSP's ``/api/integration/workstation-groups`` for the
    stage builder's "run on" dropdown. Silent-degrade on any
    failure — empty ``items`` list is indistinguishable from a
    genuinely empty PSP catalog so the FE renders the same "no
    workstations picked yet" state either way.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        rows = list_psp_workstation_groups(organization=self.organization)
        return Response({"items": rows}, status=status.HTTP_200_OK)


class PspUnitsOfMeasurementListView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/units-of-measurement/``.

    Proxies PSP's ``/api/integration/units-of-measurement`` for the
    stage form's ``Stock UOM`` picker. Silent-degrade on any failure
    — empty ``items`` mirrors an empty PSP catalog.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        rows = list_psp_units_of_measurement(organization=self.organization)
        return Response({"items": rows}, status=status.HTTP_200_OK)


class PspAllergensListView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/allergens/``."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        rows = list_psp_allergens(organization=self.organization)
        return Response({"items": rows}, status=status.HTTP_200_OK)


class PspStorageTagsListView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/storage-tags/``."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        rows = list_psp_storage_tags(organization=self.organization)
        return Response({"items": rows}, status=status.HTTP_200_OK)


class PspProductFamiliesListView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/psp/product-families/``.

    Proxies PSP's ``/api/integration/product-families`` for the stage
    form's ``Product family`` picker. Same silent-degrade contract as
    the UOM list view.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        rows = list_psp_product_families(organization=self.organization)
        return Response({"items": rows}, status=status.HTTP_200_OK)


class PspCreateFinishedProductView(APIView):
    """``POST`` ``/api/organizations/<org>/integrations/psp/finished-products/``.

    Create a brand-new PSP finished-product item on demand — powers
    the "Create new PSP item" branch of the New-formulation dialog.

    The New-formulation flow needs a finished-product uuid to link
    against; historically the scientist could only pick an existing
    PSP item. When a CFF lands with a genuinely new SKU the scientist
    now hits Create new, fills a short name / SKU form, and the
    returned uuid feeds straight into ``create_formulation``.

    Payload:

        {"name": "Vitamin C 500mg — 60ct", "external_sku": "VC500-60",
         "description": "…", "barcode": "05012345678900"}

    ``name`` is required; everything else optional. Blank
    ``external_sku`` auto-generates a ``NPD-FP-<random-hex>`` fallback
    (PSP requires the field for idempotency).

    Response mirrors the PSP wire shape:

        {"uuid", "name", "external_sku", "code", "created"}

    ``created: false`` means the SKU collided with an existing PSP
    row — the caller gets the existing uuid back so the link is
    still established. This matches how PSP's write endpoint always
    behaves; NPD doesn't invent a new race here.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(self, request: Request, org_id: str) -> Response:
        raw = request.data if isinstance(request.data, dict) else {}
        name = str(raw.get("name") or "").strip()
        if not name:
            return Response(
                {"error": "invalid_payload", "detail": "name is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            response = create_psp_finished_product(
                organization=self.organization,
                actor=request.user,
                name=name,
                external_sku=str(raw.get("external_sku") or ""),
                description=str(raw.get("description") or ""),
                barcode=str(raw.get("barcode") or ""),
            )
        except PspNotConfigured as exc:
            return Response(
                {"error": "psp_not_configured", "detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except PspAuthFailed as exc:
            return Response(
                {"error": "psp_auth_failed", "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except PspRateLimited as exc:
            return Response(
                {"error": "psp_rate_limited", "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except PspCreateFinishedProductFailed as exc:
            return Response(
                {
                    "error": "psp_create_finished_product_failed",
                    "detail": str(exc),
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except (PspUnreachable, PspError) as exc:
            return Response(
                {"error": "psp_unreachable", "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(response, status=status.HTTP_201_CREATED)


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
