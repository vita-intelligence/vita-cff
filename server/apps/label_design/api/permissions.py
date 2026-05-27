"""DRF permission class for the label-design API."""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.api.errors import OrganizationInactive
from apps.organizations.models import Organization
from apps.organizations.modules import LABELLING_MODULE, LabellingCapability
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)


class HasLabellingPermission(IsAuthenticated):
    """Gate label-design endpoints behind the ``labelling`` module.

    Same hiding rules as the formulations/finance permission classes
    — unknown org id or non-member → ``404``, missing capability →
    ``403``. Views declare the capability they need via
    ``required_capability``.
    """

    required_capability: str = LabellingCapability.VIEW

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
        return has_capability(membership, LABELLING_MODULE, capability)
