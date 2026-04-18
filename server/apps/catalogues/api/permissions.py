"""DRF permission classes for the catalogues API.

All catalogues endpoints gate on the row-scoped ``catalogues`` module.
The scope is the catalogue ``slug`` parsed out of the URL, so a
membership with ``{"catalogues": {"raw_materials": ["view"]}}`` can
list raw materials but not touch packaging.

Hiding rules (match the rest of the API):

* Unauthenticated → ``401``.
* Authenticated but unknown org id → ``404``.
* Authenticated user who is not a member of the org → ``404``.
* Authenticated member but missing capability on this catalogue
  slug → ``403``.
* Authenticated member but the slug itself does not exist in this
  org → ``404`` (rather than leaking non-existence via ``403``).
"""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.catalogues.models import Catalogue
from apps.organizations.models import Organization
from apps.organizations.modules import (
    CATALOGUES_MODULE,
    CataloguesCapability,
)
from apps.organizations.services import get_membership, has_capability


class HasCataloguePermission(IsAuthenticated):
    """Gate catalogue endpoints behind a row-scoped capability check.

    Views set ``required_capability`` (either as a class attribute or
    in their ``initial()``) declaring which named capability they need.
    This class loads the target :class:`Organization` and
    :class:`Catalogue` from the URL, caches both on the view as
    ``view.organization`` and ``view.catalogue``, and runs the
    capability check against the catalogue slug as the row scope.
    """

    required_capability: str = CataloguesCapability.VIEW

    def has_permission(self, request: Request, view: APIView) -> bool:  # type: ignore[override]
        if not super().has_permission(request, view):
            return False

        org_id = view.kwargs.get("org_id")
        organization = Organization.objects.filter(id=org_id).first()
        if organization is None:
            raise NotFound()
        view.organization = organization

        membership = get_membership(request.user, organization)
        if membership is None:
            raise NotFound()

        slug = view.kwargs.get("slug")
        catalogue = Catalogue.objects.filter(
            organization=organization, slug=slug
        ).first()
        if catalogue is None:
            raise NotFound()
        view.catalogue = catalogue

        capability: str = getattr(
            view, "required_capability", self.required_capability
        )
        return has_capability(
            membership,
            CATALOGUES_MODULE,
            capability,
            scope=slug,
        )


class HasCatalogueListPermission(IsAuthenticated):
    """Gate the ``/catalogues/`` list and create endpoints.

    Listing catalogues requires only organization membership — the
    results are then filtered to the catalogues the caller actually
    has capability on. Creating a new catalogue requires the owner.
    """

    def has_permission(self, request: Request, view: APIView) -> bool:  # type: ignore[override]
        if not super().has_permission(request, view):
            return False

        org_id = view.kwargs.get("org_id")
        organization = Organization.objects.filter(id=org_id).first()
        if organization is None:
            raise NotFound()
        view.organization = organization

        membership = get_membership(request.user, organization)
        if membership is None:
            raise NotFound()
        view.membership = membership

        if request.method == "POST":
            # Only owners can create new catalogues. Once custom
            # catalogue creation is exposed to non-owners we will fold
            # this into a proper capability grant.
            return bool(membership.is_owner)

        return True
