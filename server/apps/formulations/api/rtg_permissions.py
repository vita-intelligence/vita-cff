"""DRF permission class for the Ready-to-Go catalog endpoints.

Mirrors :class:`HasFormulationsPermission` line for line so the
familiar ``required_capability`` / ``required_capability_any``
attributes work identically — the only difference is which module
the capability check runs against.

Kept in a sibling file (rather than a branch on the existing
permission class) so a future reader tracing "which endpoint enforces
which module" can jump straight from the view to the right check.
"""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.api.errors import OrganizationInactive
from apps.organizations.models import Organization
from apps.organizations.modules import (
    RTG_CATALOG_MODULE,
    RTGCatalogCapability,
)
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)


class HasRTGCatalogPermission(IsAuthenticated):
    """Gate RTG catalog endpoints behind the ``rtg_catalog`` module.

    Same hiding rules as the sibling permission classes — unknown org
    id or non-member → ``404``, missing capability → ``403``.

    Views can swap the required capability per HTTP method by setting
    ``required_capability`` inside ``initial()`` before calling
    ``super().initial()``.
    """

    required_capability: str = RTGCatalogCapability.VIEW

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

        if not is_organization_accessible(organization, request.user):
            raise OrganizationInactive()

        capabilities_any = getattr(view, "required_capability_any", None)
        if capabilities_any:
            return any(
                has_capability(membership, RTG_CATALOG_MODULE, cap)
                for cap in capabilities_any
            )

        capability: str = getattr(
            view, "required_capability", self.required_capability
        )
        return has_capability(membership, RTG_CATALOG_MODULE, capability)
