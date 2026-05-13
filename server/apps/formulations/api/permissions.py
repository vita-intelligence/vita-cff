"""DRF permission class for the formulations API."""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.api.errors import OrganizationInactive
from apps.organizations.models import Organization
from apps.organizations.modules import (
    FORMULATIONS_MODULE,
    FormulationsCapability,
)
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)


class HasFormulationsPermission(IsAuthenticated):
    """Gate formulation endpoints behind the ``formulations`` module.

    Flat module (not row-scoped). Same hiding rules as the catalogues
    permission class — unknown org id or non-member → ``404``, missing
    capability → ``403``.

    Views declare the capability they need via one of two attributes
    (class or instance):

    * ``required_capability`` — a single capability string. Standard
      case: the endpoint maps to exactly one capability.
    * ``required_capability_any`` — an iterable of capability strings.
      The check passes if the caller holds **any** of them. Used by
      list / detail surfaces that are reachable from more than one
      role — e.g. the approval queue accepts both the broad ``view``
      cap (project workspace audience) and the narrow ``view_approvals``
      cap (sign-off audience) so neither half loses access.

    When both are set, ``required_capability_any`` wins. Views that
    swap the gate per HTTP method should set whichever attribute fits
    inside ``initial()`` *before* calling ``super().initial()`` so the
    DRF permission run sees the request-specific value.
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

        if not is_organization_accessible(organization, request.user):
            raise OrganizationInactive()

        capabilities_any = getattr(view, "required_capability_any", None)
        if capabilities_any:
            return any(
                has_capability(membership, FORMULATIONS_MODULE, cap)
                for cap in capabilities_any
            )

        capability: str = getattr(
            view, "required_capability", self.required_capability
        )
        return has_capability(membership, FORMULATIONS_MODULE, capability)
