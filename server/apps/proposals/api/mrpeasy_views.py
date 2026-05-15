"""MRPEasy integration API surface.

Three groups of endpoints:

* ``GET / PUT / DELETE /api/organizations/<org>/integrations/mrpeasy/``
  — settings CRUD, owner-only. Mirrors the Dynamics integration
  contract: plaintext secret never returned, ``has_secret``
  boolean instead so the form can render "●●●●●●●".

* ``POST /api/organizations/<org>/integrations/mrpeasy/test/`` —
  owner-only round-trip that calls the lightweight ``/items?limit=1``
  endpoint and stamps ``last_tested_at`` on success.

* ``GET /api/organizations/<org>/integrations/mrpeasy/lookup/?code=<part_number>``
  — picker-facing. Any member who can see proposals can call this
  so the spec-approval modal + proposal pages can render the
  suggested-price hint. Silently returns ``{ matched: false }``
  when the integration is off or the code isn't in MRPEasy — the
  hint UI degrades to "no MRPEasy match" rather than surfacing
  HTTP errors mid-modal.

The file lives next to the other proposal API views (rather than
in a dedicated integrations app) because MRPEasy is consumed by
the proposal + spec approval surfaces and the codebase otherwise
co-locates integration code with the primary consumer
(``customers/dynamics.py`` for Dynamics).
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.models import Membership
from apps.organizations.modules import FormulationsCapability
from apps.proposals.mrpeasy import (
    MrpeasyAuthFailed,
    MrpeasyDecryptionFailed,
    MrpeasyError,
    MrpeasyInvalidConfig,
    MrpeasyNotConfigured,
    MrpeasyRateLimited,
    MrpeasyUnreachable,
    clear_mrpeasy_config,
    get_mrpeasy_suggested_price,
    list_mrpeasy_items,
    serialize_mrpeasy_config_for_api,
    set_mrpeasy_config,
    verify_mrpeasy_connection,
)


class _OwnerOnly(HasFormulationsPermission):
    """The integration config holds credentials — only org owners can
    read / write / clear / test it. Non-owners can still use the
    lookup endpoint via the picker."""

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


def _mrpeasy_error_response(exc: MrpeasyError) -> Response:
    """Map a typed MRPEasy exception onto the right HTTP response.

    Auth failures + decryption issues are 400 (the org needs to
    re-enter credentials). Rate-limit is 429 (frontend can show
    "wait a moment"). Everything else is 502 (we couldn't reach
    the upstream).
    """

    code = getattr(exc, "code", "mrpeasy_unreachable")
    if isinstance(exc, MrpeasyAuthFailed) or isinstance(
        exc, MrpeasyDecryptionFailed
    ):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(exc, MrpeasyRateLimited):
        status_code = status.HTTP_429_TOO_MANY_REQUESTS
    elif isinstance(exc, MrpeasyInvalidConfig):
        status_code = status.HTTP_400_BAD_REQUEST
    else:
        status_code = status.HTTP_502_BAD_GATEWAY
    return Response(
        {"detail": [code], "message": str(exc)},
        status=status_code,
    )


class MrpeasyIntegrationView(APIView):
    """``GET`` / ``PUT`` / ``DELETE``
    ``/api/organizations/<org>/integrations/mrpeasy/``.

    Owner-only. The plaintext API secret is NEVER returned — the
    read shape carries a ``has_secret`` boolean instead so the
    form can render a "●●●●●●●" placeholder without leaking the
    value. ``last_tested_at`` is the operator's "this connection
    works as of …" badge; resets on every credential change.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        return Response(
            serialize_mrpeasy_config_for_api(self.organization),
            status=status.HTTP_200_OK,
        )

    def put(self, request: Request, org_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        payload = set_mrpeasy_config(
            organization=self.organization,
            actor=request.user,
            enabled=bool(body.get("enabled", True)),
            api_key=str(body.get("api_key") or ""),
            # ``None`` is the "keep existing secret" sentinel
            # (matches the Dynamics form). Empty string also
            # preserves — operators sometimes blank the field
            # rather than leaving the typed value alone.
            api_secret=body.get("api_secret"),
        )
        return Response(payload, status=status.HTTP_200_OK)

    def delete(self, request: Request, org_id: str) -> Response:
        payload = clear_mrpeasy_config(
            organization=self.organization, actor=request.user
        )
        return Response(payload, status=status.HTTP_200_OK)


class MrpeasyTestConnectionView(APIView):
    """``POST`` ``/api/organizations/<org>/integrations/mrpeasy/test/``.

    Owner-only. Runs a single ``GET /items?limit=1`` round-trip
    against MRPEasy. Returns 200 on success; 400 / 429 / 502 with a
    codified error the settings UI maps to a specific failure
    message on the form.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def post(self, request: Request, org_id: str) -> Response:
        try:
            verify_mrpeasy_connection(
                organization=self.organization, actor=request.user
            )
        except MrpeasyNotConfigured:
            return Response(
                {"detail": ["mrpeasy_not_configured"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except MrpeasyError as exc:
            return _mrpeasy_error_response(exc)
        return Response(
            serialize_mrpeasy_config_for_api(self.organization),
            status=status.HTTP_200_OK,
        )


class MrpeasyItemListView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/mrpeasy/items/``.

    Picker-facing. Accepts an optional ``?search=<query>`` to
    filter the org's MRPEasy catalogue server-side — required for
    tenants with thousands of SKUs, where a no-filter browse
    couldn't realistically return what the operator's looking
    for. Empty / missing ``search`` falls back to a 100-row
    browse for callers that want a sample.

    Response shape:

    .. code-block:: json

        {
          "items": [
            {"code": "MA210367", "title": "Valley Low Fat …", "selling_price": "14.99"},
            ...
          ]
        }

    Silent degradation: integration off / lookup failure → empty
    ``items`` array, never an error response. The new-project
    form just falls back to manual code/name entry.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        # Trim defensively — a stray space from the frontend
        # shouldn't change which cache slot we look up.
        search = (request.query_params.get("search") or "").strip()
        items = list_mrpeasy_items(
            organization=self.organization,
            search=search or None,
        )
        return Response(
            {
                "items": [
                    {
                        "code": item.code,
                        "title": item.title,
                        # Selling price serialised as string for
                        # cross-call type consistency. ``None``
                        # becomes empty string so the frontend's
                        # type can stay a single string column.
                        "selling_price": (
                            str(item.selling_price)
                            if item.selling_price is not None
                            else ""
                        ),
                        # MRPEasy's internal numeric id — drives
                        # the "Open in MRPEasy" deep link
                        # (``/articles/view/<product_id>``). The
                        # picker doesn't surface it directly, but
                        # any future "remember which row I picked"
                        # workflow will want it.
                        "product_id": item.product_id,
                    }
                    for item in items
                ]
            },
            status=status.HTTP_200_OK,
        )


class MrpeasyPriceLookupView(APIView):
    """``GET`` ``/api/organizations/<org>/integrations/mrpeasy/lookup/?code=<part_number>``.

    Picker-facing. Returns a tiny payload the price-hint component
    consumes:

    .. code-block:: json

        {
          "matched": true,
          "code": "MA512342",
          "title": "Super Puper Capsules",
          "selling_price": "18.50"
        }

    or

    .. code-block:: json

        {"matched": false, "code": "..."}

    when MRPEasy returned no row. The frontend distinguishes the
    two states so the chip can render either the suggested price
    + autofill button OR the "no MRPEasy match for <code>"
    explainer.

    Silent degradation: HTTP failures land as ``{matched: false}``
    too — the operator's flow must never be blocked by an MRPEasy
    outage. The diagnosis surfaces on the settings page (which
    has its own typed error mapping); the modal stays quiet.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        code = (request.query_params.get("code") or "").strip()
        if not code:
            return Response(
                {"matched": False, "code": ""},
                status=status.HTTP_200_OK,
            )
        item = get_mrpeasy_suggested_price(
            organization=self.organization, code=code
        )
        if item is None or item.selling_price is None:
            return Response(
                {"matched": False, "code": code},
                status=status.HTTP_200_OK,
            )
        return Response(
            {
                "matched": True,
                "code": item.code,
                "title": item.title,
                # Decimal serialised as string so the frontend can
                # treat it identically to every other DRF
                # DecimalField response — no float-precision
                # weirdness when the operator clicks Use.
                "selling_price": str(item.selling_price),
                # MRPEasy's internal id — lets the "Open in
                # MRPEasy" link build the direct
                # ``/articles/view/<product_id>`` URL instead of
                # falling back to a search-filter URL.
                "product_id": item.product_id,
            },
            status=status.HTTP_200_OK,
        )
