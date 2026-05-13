"""DRF permission class for the proposals API.

Mirrors :class:`apps.formulations.api.permissions.HasFormulationsPermission`
but resolves capabilities against the dedicated ``proposals`` module
so commercial roles can be granted the proposal pipeline without
inheriting broader project-edit rights.
"""

from __future__ import annotations

from rest_framework.exceptions import NotFound
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.views import APIView

from apps.organizations.api.errors import OrganizationInactive
from apps.organizations.models import Organization
from apps.organizations.modules import (
    PROPOSALS_MODULE,
    ProposalsCapability,
)
from apps.organizations.services import (
    get_membership,
    has_capability,
    is_organization_accessible,
)


class HasProposalsPermission(IsAuthenticated):
    """Gate proposal endpoints behind the ``proposals`` module.

    Flat module (not row-scoped). Same hiding rules as the formulations
    permission class — unknown org id or non-member → ``404``, missing
    capability → ``403``.

    Views declare the capability they need via one of two attributes
    (class or instance):

    * ``required_capability`` — single capability string for the
      common one-cap case.
    * ``required_capability_any`` — iterable of capability strings;
      the check passes if the caller holds **any** of them. Mirrors
      the formulations permission class — used by the approval / signed
      surfaces so the broad ``view`` cap and the narrow
      ``view_approvals`` / ``view_signed`` caps both unlock them.

    When both are set, ``required_capability_any`` wins.
    """

    required_capability: str = ProposalsCapability.VIEW

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
                has_capability(membership, PROPOSALS_MODULE, cap)
                for cap in capabilities_any
            )

        capability: str = getattr(
            view, "required_capability", self.required_capability
        )
        return has_capability(membership, PROPOSALS_MODULE, capability)
