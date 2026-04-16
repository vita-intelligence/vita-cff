"""DRF permission class for the specifications API."""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.models import Organization
from apps.organizations.modules import (
    PermissionLevel,
    SPECIFICATIONS_MODULE,
)
from apps.organizations.services import get_membership, has_permission


class HasSpecificationsPermission(IsAuthenticated):
    """Gate specification endpoints behind the ``specifications`` module.

    Same hiding rules as the formulations class — unknown org or
    non-member → ``404`` (never leak existence), wrong level → ``403``.
    """

    required_level: PermissionLevel = PermissionLevel.READ

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

        required: PermissionLevel = getattr(
            view, "required_level", self.required_level
        )
        return has_permission(membership, SPECIFICATIONS_MODULE, required)
