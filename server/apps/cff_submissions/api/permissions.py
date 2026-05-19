"""DRF permission class for the CFF submissions API.

Mirrors :class:`apps.formulations.api.permissions.HasFormulationsPermission`
but gates on the ``cff_submissions`` module so commercial / triage
roles can be granted CFF access without inheriting project-edit
rights. See :mod:`apps.organizations.modules` for the capability
list.

Hiding rules match the rest of the app:

* Unknown org id or caller is not a member → ``404`` (don't leak
  org existence).
* Caller is a member but missing the required capability → ``403``.
* Org membership is currently inactive → ``OrganizationInactive``
  (which DRF renders as a 403 with a coded body).
"""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.api.errors import OrganizationInactive
from apps.organizations.models import Organization
from apps.organizations.modules import (
    CFF_SUBMISSIONS_MODULE,
    CFFSubmissionsCapability,
)
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)


class HasCFFPermission(IsAuthenticated):
    """Gate CFF endpoints behind the ``cff_submissions`` module."""

    required_capability: str = CFFSubmissionsCapability.VIEW

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

        capability: str = getattr(
            view, "required_capability", self.required_capability,
        )
        return has_capability(membership, CFF_SUBMISSIONS_MODULE, capability)


class IsOrganizationOwner(IsAuthenticated):
    """Owner-only gate for the integration settings endpoints.

    Mirrors the gate used by :class:`apps.customers.api.views.DynamicsIntegrationView`
    — only members flagged as owner can edit integration credentials,
    consistent with the rest of the settings page.
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

        if not is_organization_accessible(organization, request.user):
            raise OrganizationInactive()

        return bool(getattr(membership, "is_owner", False))
