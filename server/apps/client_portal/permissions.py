"""DRF permission classes for the client portal."""

from __future__ import annotations

from rest_framework.permissions import BasePermission

from apps.client_portal.models import ClientAccount


class IsClientAccount(BasePermission):
    """Allow only authenticated :class:`ClientAccount` requests.

    Used as the global gate on every ``/api/portal/*`` route. A
    staff JWT in the portal cookie would have failed authentication
    earlier; this guards against a stray endpoint that forgot to
    override ``permission_classes`` and otherwise inherited
    ``IsAuthenticated`` (which would also accept staff users).
    """

    message = "client_portal_authentication_required"

    def has_permission(self, request, view) -> bool:
        return (
            request.user is not None
            and isinstance(request.user, ClientAccount)
            and request.user.is_authenticated
        )


class ClientOwnsProposal(BasePermission):
    """Enforce that the authenticated client owns the target proposal.

    Reads ``proposal_id`` off the URL kwargs and checks the proposal
    belongs to the client's customer. The proposal itself is fetched
    in the view (so its 404 path stays consistent with the rest of
    the API); this permission only attaches the ownership check
    once the view loads the row.
    """

    message = "client_portal_proposal_forbidden"

    def has_object_permission(self, request, view, obj) -> bool:
        if not isinstance(request.user, ClientAccount):
            return False
        return obj.customer_id == request.user.customer_id
