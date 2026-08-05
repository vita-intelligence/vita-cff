"""PSP-facing read endpoints.

Distinct from :mod:`apps.formulations.api.views` because the caller
is PSP (server-to-server), not a logged-in user — the auth chain is a
shared bearer token, not JWT. Kept small: PSP only needs the flat list
of projects still in R&D so its ``/projects`` kanban can render an
"R&D in development" column before the customer-order columns.
"""

from __future__ import annotations

from django.conf import settings
from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotFound
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.models import Formulation, ProjectStatus, ProjectType
from apps.psp.token_services import verify_psp_access_token
from apps.specifications.models import SpecificationSheet
from apps.specifications.services import render_html


def _extract_bearer(request: Request) -> str | None:
    raw = request.META.get("HTTP_AUTHORIZATION", "")
    if not raw.lower().startswith("bearer "):
        return None
    return raw.split(None, 1)[1].strip() or None


def _resolve_token(request: Request):
    """Resolve the caller.

    * Preferred path — the incoming bearer matches a live row in
      :class:`apps.psp.models.PspAccessToken`. Returns the token so the
      caller can scope its response to the token's organization.
    * Fallback — the incoming bearer matches the legacy
      :setting:`PSP_INTEGRATION_TOKEN` env var (kept for one release so
      existing dev setups don't break). Returns ``None`` and the view
      renders cross-tenant, exactly like the pre-DB implementation.
    * No match on either → :class:`AuthenticationFailed`.
    """

    presented = _extract_bearer(request)
    if not presented:
        raise AuthenticationFailed("missing_bearer_token")

    row = verify_psp_access_token(raw_token=presented)
    if row is not None:
        return row

    expected = str(settings.PSP_INTEGRATION_TOKEN or "").strip()
    if expected and presented == expected:
        return None

    raise AuthenticationFailed("invalid_bearer_token")


class InDevelopmentFormulationsView(APIView):
    """``GET /api/psp-integration/formulations/in-development/``.

    Returns every formulation whose project ``status`` is
    :attr:`ProjectStatus.IN_DEVELOPMENT`, ordered most-recently-updated
    first. PSP uses this to render a kanban column showing what R&D
    still has open before the customer-order pipeline picks up.

    Response shape:

    .. code-block:: json

        {
          "items": [
            {
              "id": "…uuid…",
              "code": "MA01421",
              "name": "Alex Gummies",
              "project_type": "custom",
              "customer_name": "Alex Ltd",
              "lead_scientist_name": "…" | null,
              "sales_person_name": "…" | null,
              "app_url": "http://localhost:3000/formulations/…"
            }
          ]
        }

    Cross-tenant on purpose — PSP runs one shared production pipeline
    view. If NPD ever becomes multi-tenant with PSP, the caller can
    filter by ``organization`` on its side; this endpoint keeps it
    simple until then.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request) -> Response:
        token = _resolve_token(request)

        # Only ship CUSTOM (customer-driven) formulations to PSP's
        # production pipeline. RTGs are catalog dev — they have no
        # order attached until a customer picks one from the portal
        # and a Proposal is merged as a CustomerOrder (which reaches
        # PSP through the ProposalMerge path, not this mirror). Until
        # then they're pure catalog work with no owner and shouldn't
        # clutter the shop-floor kanban.
        queryset = Formulation.objects.filter(
            project_status=ProjectStatus.IN_DEVELOPMENT,
            project_type=ProjectType.CUSTOM,
        )
        # DB-backed token = scoped to the token's org. Env-var fallback
        # keeps the legacy cross-tenant behaviour so an existing dev
        # setup doesn't lose data on the release that introduces per-
        # org tokens.
        if token is not None:
            queryset = queryset.filter(organization=token.organization)

        formulations = list(
            queryset.select_related("lead_scientist", "sales_person")
            .order_by("-updated_at")
            .only(
                "id",
                "code",
                "name",
                "project_type",
                "lead_scientist_id",
                "sales_person_id",
                "updated_at",
            )
        )

        base_url = str(getattr(settings, "APP_BASE_URL", "") or "").rstrip("/")

        def _full_name(user) -> str | None:
            if user is None:
                return None
            get = getattr(user, "get_full_name", None)
            if callable(get):
                name = (get() or "").strip()
                return name or None
            return None

        items = []
        for f in formulations:
            items.append(
                {
                    "id": str(f.id),
                    "code": f.code or "",
                    "name": f.name or "",
                    "project_type": f.project_type,
                    "lead_scientist_name": _full_name(
                        f.lead_scientist_id and f.lead_scientist
                    ),
                    "sales_person_name": _full_name(
                        f.sales_person_id and f.sales_person
                    ),
                    "updated_at": f.updated_at.isoformat()
                    if f.updated_at
                    else None,
                    "app_url": (
                        f"{base_url}/formulations/{f.id}" if base_url else None
                    ),
                }
            )

        return Response({"items": items}, status=status.HTTP_200_OK)


class LatestSpecSheetHtmlView(APIView):
    """``GET /api/psp-integration/specifications/latest.html?psp_item_uuid=…``.

    Server-renders the latest :class:`SpecificationSheet` for the
    formulation whose :attr:`Formulation.psp_finished_product_uuid`
    matches ``psp_item_uuid``, using the same Django template
    WeasyPrint feeds into for PDF export. Returned as ``text/html``
    for a caller (PSP) to embed in an ``<iframe>``. Because PSP is
    the only caller and it authenticates with the shared integration
    bearer, this bypasses the ``FINAL``-only gate that the customer-
    facing :func:`rotate_public_token` enforces — the render is
    otherwise identical to what NPD shows internally.

    Preference order for picking a sheet:

    1. Latest ``FINAL`` (approved / sent / accepted) — the sheet a
       customer would actually see, priority for QA sign-off comparison.
    2. Latest ``DRAFT`` — for R&D lots QA still needs to compare
       against before a customer sheet exists.

    Returns 404 when the formulation isn't found or has no sheet on
    file. The bearer chain matches :class:`InDevelopmentFormulationsView`.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request) -> HttpResponse:
        token = _resolve_token(request)

        raw_uuid = (request.query_params.get("psp_item_uuid") or "").strip()
        if not raw_uuid:
            raise NotFound("psp_item_uuid_required")

        formulations = Formulation.objects.filter(
            psp_finished_product_uuid=raw_uuid
        )
        if token is not None:
            formulations = formulations.filter(organization=token.organization)

        formulation = formulations.first()
        if formulation is None:
            raise NotFound("formulation_not_found")

        sheets = SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation
        ).select_related("formulation_version", "organization")

        final_sheet = (
            sheets.filter(status__in=("approved", "sent", "accepted"))
            .order_by("-created_at")
            .first()
        )
        chosen = final_sheet or sheets.order_by("-created_at").first()

        if chosen is None:
            raise NotFound("no_spec_sheet")

        html = render_html(chosen)
        response = HttpResponse(html, content_type="text/html; charset=utf-8")
        # Cache: force-fresh; QA needs to see the latest sheet even
        # if the browser has an older render buffered from a peer tab.
        response["Cache-Control"] = "no-store, no-cache, must-revalidate"
        # Allow same-origin iframe embed from the PSP proxy (PSP will
        # serve the HTML from its own origin, so from the browser's
        # perspective this response is same-origin). Belt-and-braces
        # in case a caller ever embeds direct.
        response["X-Frame-Options"] = "SAMEORIGIN"
        return response
