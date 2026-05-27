"""DRF permission class for the finance / payments API."""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.api.errors import OrganizationInactive
from apps.organizations.models import Organization
from apps.organizations.modules import FINANCE_MODULE, FinanceCapability
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)


class HasFinancePermission(IsAuthenticated):
    """Gate payment endpoints behind the ``finance`` module.

    Mirrors :class:`HasFormulationsPermission` — unknown org id or
    non-member → ``404``, missing capability → ``403``.
    """

    required_capability: str = FinanceCapability.VIEW

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

        capability: str = getattr(view, "required_capability", self.required_capability)
        return has_capability(membership, FINANCE_MODULE, capability)
