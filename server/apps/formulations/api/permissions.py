"""DRF permission class for the formulations API."""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.models import Organization
from apps.organizations.modules import (
    FORMULATIONS_MODULE,
    FormulationsCapability,
)
from apps.organizations.services import get_membership, has_capability


class HasFormulationsPermission(IsAuthenticated):
    """Gate formulation endpoints behind the ``formulations`` module.

    Flat module (not row-scoped). Same hiding rules as the catalogues
    permission class — unknown org id or non-member → ``404``, missing
    capability → ``403``. Views declare the capability they need via
    ``required_capability`` (class or instance attribute).
    """

    required_capability: str = FormulationsCapability.VIEW

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

        capability: str = getattr(
            view, "required_capability", self.required_capability
        )
        return has_capability(membership, FORMULATIONS_MODULE, capability)
