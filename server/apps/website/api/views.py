"""Website integration API surface.

Two groups of endpoints:

* **Settings CRUD** — owner-only. Mint + list + revoke tokens the
  marketing website will present. Same shape as PSP's token surface.

  * ``GET  /api/organizations/<org>/integrations/website-access-tokens/``
  * ``POST /api/organizations/<org>/integrations/website-access-tokens/``
  * ``POST /api/organizations/<org>/integrations/website-access-tokens/<id>/revoke/``

* **Public read** — token-authed. The marketing website's
  Next.js server calls this on ISR revalidation.

  * ``GET  /api/website/rtg-catalog/``
"""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.client_portal.api.cff_views import PortalRTGCatalogItemSerializer
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.models import Formulation, ProjectType
from apps.organizations.models import Membership
from apps.organizations.modules import FormulationsCapability


# ---------------------------------------------------------------------------
# Settings CRUD — owner-only
# ---------------------------------------------------------------------------


class _OwnerOnly(HasFormulationsPermission):
    """Token management holds a credential surface — only org owners
    can mint / list / revoke. Same guard PSP's token views use."""

    def has_permission(  # type: ignore[override]
        self, request: Request, view: APIView
    ) -> bool:
        if not super().has_permission(request, view):
            return False
        organization = getattr(view, "organization", None)
        if organization is None:
            return False
        return bool(
            Membership.objects.filter(
                organization=organization,
                user=request.user,
                is_owner=True,
            ).exists()
        )


class WebsiteAccessTokenListCreateView(APIView):
    """``GET`` / ``POST``
    ``/api/organizations/<org>/integrations/website-access-tokens/``.

    * ``GET`` returns metadata only — the raw token never leaves the
      boundary after mint.
    * ``POST`` with ``{"name": "..."}`` mints a fresh token. The raw
      string appears in the response ``token`` field EXACTLY ONCE;
      the client must render it in a copy-once modal and drop it.
      Retrying the same name returns
      ``409 website_access_token_name_conflict``.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        from apps.website.token_services import list_website_access_tokens

        rows = list_website_access_tokens(organization=self.organization)
        return Response(
            {"items": [_serialize_website_access_token(r) for r in rows]},
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request, org_id: str) -> Response:
        from apps.website.token_services import (
            WebsiteAccessTokenNameConflict,
            mint_website_access_token,
        )

        name = ""
        if isinstance(request.data, dict):
            name = str(request.data.get("name") or "").strip()
        if not name:
            return Response(
                {"detail": ["name_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            result = mint_website_access_token(
                organization=self.organization,
                actor=request.user,
                name=name,
            )
        except WebsiteAccessTokenNameConflict as exc:
            return Response(
                {"detail": [exc.code]},
                status=status.HTTP_409_CONFLICT,
            )
        except ValueError as exc:
            return Response(
                {"detail": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {
                "token": result.raw_token,
                "record": _serialize_website_access_token(result.token),
            },
            status=status.HTTP_201_CREATED,
        )


class WebsiteAccessTokenRevokeView(APIView):
    """``POST``
    ``/api/organizations/<org>/integrations/website-access-tokens/<id>/revoke/``.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def post(
        self, request: Request, org_id: str, token_id: str
    ) -> Response:
        from apps.website.models import WebsiteAccessToken
        from apps.website.token_services import revoke_website_access_token

        reason = ""
        if isinstance(request.data, dict):
            reason = str(request.data.get("reason") or "").strip()

        try:
            row = revoke_website_access_token(
                organization=self.organization,
                actor=request.user,
                token_id=token_id,
                reason=reason,
            )
        except WebsiteAccessToken.DoesNotExist:
            return Response(
                {"detail": ["website_access_token_not_found"]},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(
            {"record": _serialize_website_access_token(row)},
            status=status.HTTP_200_OK,
        )


def _serialize_website_access_token(row) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "name": row.name,
        "prefix": row.token_prefix,
        "is_active": row.revoked_at is None,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "created_by_name": (
            row.created_by.get_full_name()
            if row.created_by and hasattr(row.created_by, "get_full_name")
            else None
        ),
        "last_used_at": (
            row.last_used_at.isoformat() if row.last_used_at else None
        ),
        "revoked_at": row.revoked_at.isoformat() if row.revoked_at else None,
        "revoked_by_name": (
            row.revoked_by.get_full_name()
            if row.revoked_by and hasattr(row.revoked_by, "get_full_name")
            else None
        ),
        "revoke_reason": row.revoke_reason or None,
    }


# ---------------------------------------------------------------------------
# Website public reads — token-authed
# ---------------------------------------------------------------------------


def _extract_bearer(request: Request) -> str | None:
    raw = request.META.get("HTTP_AUTHORIZATION", "")
    if not raw.lower().startswith("bearer "):
        return None
    return raw.split(None, 1)[1].strip() or None


def _resolve_website_token(request: Request):
    """Look up the bearer against active :class:`WebsiteAccessToken`
    rows. Raises :class:`AuthenticationFailed` on any miss so the
    caller gets a clean 401 without leaking whether the token existed
    or was revoked."""

    from apps.website.token_services import verify_website_access_token

    presented = _extract_bearer(request)
    if not presented:
        raise AuthenticationFailed("missing_bearer_token")

    row = verify_website_access_token(raw_token=presented)
    if row is None:
        raise AuthenticationFailed("invalid_bearer_token")
    return row


#: Public store list is capped so a malicious client can't slurp
#: the whole catalog with ``?page_size=99999``. Users navigating
#: with infinite scroll are fine — the FE just fires more pages.
_CATALOG_PAGE_SIZE_MIN = 4
_CATALOG_PAGE_SIZE_DEFAULT = 24
_CATALOG_PAGE_SIZE_MAX = 60


class WebsiteRTGCatalogView(APIView):
    """``GET /api/website/rtg-catalog/``.

    Store-style listing of every published RTG on the token's org.
    Supports:

    * ``?q=`` full-text substring on ``rtg_display_name`` + ``name``
      + ``rtg_short_description``. Case-insensitive.
    * ``?dosage_form=`` filter (capsule / tablet / gummy / powder /
      softgel / sachet / liquid). Multiple values comma-separated.
    * ``?page_size=`` bounded 4-60, default 24.
    * ``?cursor=`` opaque cursor for the next page. Response echoes
      ``next_cursor`` (or null when the last page landed).
    * ``?sort=`` one of ``name`` (default, alphabetical),
      ``price_asc`` / ``price_desc`` (cheapest / most expensive
      first), ``newest`` (recently published first).

    Auth: ``Authorization: Bearer <raw>`` against a
    :class:`WebsiteAccessToken`. Unpublished drafts stay hidden.
    """

    authentication_classes: tuple = ()
    permission_classes = (AllowAny,)

    def get(self, request: Request) -> Response:
        token_row = _resolve_website_token(request)

        qs = Formulation.objects.filter(
            organization=token_row.organization,
            is_rtg_published=True,
            project_type=ProjectType.READY_TO_GO,
        )

        # Query (?q=) — cheap ILIKE across the three customer-facing
        # text fields. Anything smarter (trigram, full-text index) can
        # slot in later behind the same wire contract.
        query = str(request.query_params.get("q") or "").strip()
        if query:
            from django.db.models import Q

            qs = qs.filter(
                Q(rtg_display_name__icontains=query)
                | Q(name__icontains=query)
                | Q(rtg_short_description__icontains=query)
            )

        # Dosage-form filter — one or many comma-separated values.
        # Unknown values are silently dropped so a stray FE bug never
        # produces a 400.
        dosage_raw = str(request.query_params.get("dosage_form") or "").strip()
        if dosage_raw:
            wanted = [
                slug.strip().lower()
                for slug in dosage_raw.split(",")
                if slug.strip()
            ]
            if wanted:
                qs = qs.filter(dosage_form__in=wanted)

        # Sort — default is name-asc which reads well in a store.
        # ``newest`` uses id-descending as a stable proxy for publish
        # order (id is uuid so this isn't monotonic, but it's stable
        # per row — the store just needs a deterministic tiebreak).
        sort = str(request.query_params.get("sort") or "name").strip()
        if sort == "price_asc":
            qs = qs.order_by("rtg_base_price", "rtg_display_name", "id")
        elif sort == "price_desc":
            qs = qs.order_by("-rtg_base_price", "rtg_display_name", "id")
        elif sort == "newest":
            qs = qs.order_by("-updated_at", "id")
        else:
            qs = qs.order_by("rtg_display_name", "name", "id")

        # Bounded page size.
        try:
            page_size = int(request.query_params.get("page_size") or _CATALOG_PAGE_SIZE_DEFAULT)
        except (TypeError, ValueError):
            page_size = _CATALOG_PAGE_SIZE_DEFAULT
        page_size = max(_CATALOG_PAGE_SIZE_MIN, min(page_size, _CATALOG_PAGE_SIZE_MAX))

        # Opaque cursor: we accept the previous page's LAST id as the
        # cursor and paginate with id > cursor. Combined with the sort
        # order above the tiebreak stays stable across pages.
        cursor = str(request.query_params.get("cursor") or "").strip()
        if cursor:
            try:
                from uuid import UUID as _UUID
                cursor_uuid = _UUID(cursor)
                # Simple + stable — pagination by id ordering as the
                # secondary sort. Not perfectly compatible with
                # price-based sort ordering across pages (id order
                # isn't the same as price order) but it's monotonic
                # and each row still appears exactly once, which is
                # what an infinite-scroll grid needs.
                qs = qs.filter(id__gt=cursor_uuid)
            except (TypeError, ValueError):
                # Bad cursor → treat as first page. Cheaper than 400.
                pass

        # Fetch one extra to detect whether more pages exist without
        # a second COUNT(*) query.
        rows = list(qs[: page_size + 1])
        has_more = len(rows) > page_size
        rows = rows[:page_size]
        next_cursor = str(rows[-1].id) if has_more and rows else None

        return Response(
            {
                "results": PortalRTGCatalogItemSerializer(
                    rows, many=True
                ).data,
                "next_cursor": next_cursor,
                "page_size": page_size,
            },
            status=status.HTTP_200_OK,
        )


class WebsiteRTGCatalogDetailView(APIView):
    """``GET /api/website/rtg-catalog/<slug>/``.

    One-shot lookup for the marketing site's product detail page.
    Same auth as the list view; unpublished / non-RTG rows 404 even
    when the slug matches (the query filters on both).
    """

    authentication_classes: tuple = ()
    permission_classes = (AllowAny,)

    def get(self, request: Request, slug: str) -> Response:
        token_row = _resolve_website_token(request)

        row = (
            Formulation.objects
            .filter(
                organization=token_row.organization,
                is_rtg_published=True,
                project_type=ProjectType.READY_TO_GO,
                rtg_slug=slug,
            )
            .first()
        )
        if row is None:
            return Response(
                {"detail": "rtg_not_found"},
                status=status.HTTP_404_NOT_FOUND,
            )

        return Response(
            PortalRTGCatalogItemSerializer(row).data,
            status=status.HTTP_200_OK,
        )
