"""PSP-facing read endpoints.

Distinct from :mod:`apps.formulations.api.views` because the caller
is PSP (server-to-server), not a logged-in user — the auth chain is a
shared bearer token, not JWT. Kept small: PSP only needs the flat list
of projects still in R&D so its ``/projects`` kanban can render an
"R&D in development" column before the customer-order columns.
"""

from __future__ import annotations

from django.conf import settings
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.models import Formulation, ProjectStatus, ProjectType
from apps.psp.token_services import verify_psp_access_token


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
