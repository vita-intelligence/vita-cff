"""Views for the organizations API."""

from __future__ import annotations

from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.auth.cookies import set_auth_cookies, tokens_for_user
from apps.organizations.api.serializers import (
    AcceptInvitationSerializer,
    InvitationCreateSerializer,
    InvitationReadSerializer,
    MembershipPermissionsUpdateSerializer,
    MembershipReadSerializer,
    OrganizationCreateSerializer,
    OrganizationReadSerializer,
    PublicInvitationSerializer,
)
from apps.organizations.models import Membership, Organization
from apps.organizations.modules import MembersCapability, all_modules
from apps.organizations.services import (
    InvitationAlreadyAccepted,
    InvitationAlreadyExists,
    InvitationEmailAlreadyMember,
    InvitationEmailAlreadyRegistered,
    InvitationExpired,
    InvitationNotFound,
    MembershipCannotTargetOwner,
    MembershipCannotTargetSelf,
    PermissionsInvalid,
    accept_invitation,
    create_invitation,
    create_organization,
    get_invitation_by_token,
    get_invitation_for_org,
    get_membership,
    has_capability,
    list_memberships,
    list_pending_invitations,
    list_user_organizations,
    remove_membership,
    resend_invitation,
    revoke_invitation,
    update_membership_permissions,
)


class OrganizationListCreateView(APIView):
    """``GET``/``POST`` ``/api/organizations/``."""

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        organizations = list_user_organizations(request.user)
        return Response(
            OrganizationReadSerializer(
                organizations, many=True, context={"request": request}
            ).data,
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request) -> Response:
        serializer = OrganizationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        organization = create_organization(
            user=request.user,
            name=serializer.validated_data["name"],
        )
        return Response(
            OrganizationReadSerializer(
                organization, context={"request": request}
            ).data,
            status=status.HTTP_201_CREATED,
        )


def _load_org_for_caller(
    request: Request,
    org_id: str,
    capability: str,
) -> Organization:
    """Load an org and verify the caller holds ``capability`` on ``members``.

    Two branches here because we want distinct response codes: unknown
    org ids and non-member callers both return ``404`` (we never leak
    that an org exists to strangers), while members-module denials for
    existing members return ``403``.
    """

    organization = Organization.objects.filter(id=org_id).first()
    if organization is None:
        raise NotFound()
    membership = get_membership(request.user, organization)
    if membership is None:
        raise NotFound()
    if not has_capability(membership, "members", capability):
        raise PermissionDenied()
    return organization


class InvitationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org_id>/invitations/``.

    * ``GET`` requires ``members.view`` — returns every pending
      (non-accepted) invitation, newest first.
    * ``POST`` requires ``members.invite`` — creates a new invitation,
      optionally with a preset capability payload.

    Owners satisfy both automatically thanks to the owner bypass in
    :func:`has_capability`.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request, org_id: str) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.VIEW
        )
        queryset = list_pending_invitations(organization=organization)
        return Response(
            InvitationReadSerializer(queryset, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request, org_id: str) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.INVITE
        )

        serializer = InvitationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            invitation = create_invitation(
                organization=organization,
                invited_by=request.user,
                email=serializer.validated_data["email"],
                permissions=serializer.validated_data.get("permissions") or None,
            )
        except InvitationEmailAlreadyMember:
            return Response(
                {"email": ["email_already_member"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvitationAlreadyExists:
            return Response(
                {"email": ["invitation_already_exists"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except PermissionsInvalid:
            return Response(
                {"permissions": ["permissions_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            InvitationReadSerializer(invitation).data,
            status=status.HTTP_201_CREATED,
        )


class InvitationDetailView(APIView):
    """``DELETE`` ``/api/organizations/<org_id>/invitations/<inv_id>/``.

    Revokes a pending invitation by hard-deleting the row so the
    accept endpoint 404s on the token immediately. Requires
    ``members.remove``.
    """

    permission_classes = (IsAuthenticated,)

    def delete(self, request: Request, org_id: str, invitation_id: str) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.REMOVE
        )
        invitation = get_invitation_for_org(
            organization=organization, invitation_id=invitation_id
        )
        if invitation is None:
            raise NotFound()
        try:
            revoke_invitation(invitation=invitation)
        except InvitationAlreadyAccepted:
            return Response(
                {"detail": ["invitation_already_accepted"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class InvitationResendView(APIView):
    """``POST`` ``/api/organizations/<org_id>/invitations/<inv_id>/resend/``.

    Rotates the token and resets the expiry. Requires
    ``members.invite`` — resend is logically another invite issuance,
    not a destructive action.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request: Request, org_id: str, invitation_id: str) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.INVITE
        )
        invitation = get_invitation_for_org(
            organization=organization, invitation_id=invitation_id
        )
        if invitation is None:
            raise NotFound()
        try:
            updated = resend_invitation(invitation=invitation)
        except InvitationAlreadyAccepted:
            return Response(
                {"detail": ["invitation_already_accepted"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            InvitationReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )


class MembershipListView(APIView):
    """``GET`` ``/api/organizations/<org_id>/memberships/``.

    Returns every membership in the org, owner-first. Gated on
    ``members.view``; the Settings > Members tab renders from this
    payload + :class:`ModuleRegistryView` for the capability grid.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request, org_id: str) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.VIEW
        )
        queryset = list_memberships(organization=organization)
        return Response(
            MembershipReadSerializer(queryset, many=True).data,
            status=status.HTTP_200_OK,
        )


class MembershipDetailView(APIView):
    """``PATCH`` / ``DELETE``
    ``/api/organizations/<org_id>/memberships/<membership_id>/``.

    * ``PATCH`` requires ``members.edit_permissions``; payload is a
      full permissions dict (not a patch). The owner's membership
      refuses both verbs, and callers can't target their own.
    * ``DELETE`` requires ``members.remove`` — same owner / self
      guards.
    """

    permission_classes = (IsAuthenticated,)

    def _load_target(
        self,
        organization: Organization,
        membership_id: str,
        caller: Any,
    ) -> Membership:
        target = (
            Membership.objects.select_related("user")
            .filter(id=membership_id, organization=organization)
            .first()
        )
        if target is None:
            raise NotFound()
        if target.user_id == caller.id:
            # Target == caller: reject early with a specific code so
            # the UI can surface a meaningful message rather than a
            # generic 403.
            raise MembershipCannotTargetSelf()
        return target

    def patch(
        self, request: Request, org_id: str, membership_id: str
    ) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.EDIT_PERMISSIONS
        )
        try:
            target = self._load_target(organization, membership_id, request.user)
        except MembershipCannotTargetSelf:
            return Response(
                {"detail": ["membership_is_self"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = MembershipPermissionsUpdateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            updated = update_membership_permissions(
                membership=target,
                permissions=serializer.validated_data["permissions"],
            )
        except MembershipCannotTargetOwner:
            return Response(
                {"detail": ["membership_is_owner"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        except PermissionsInvalid:
            return Response(
                {"permissions": ["permissions_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            MembershipReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, membership_id: str
    ) -> Response:
        organization = _load_org_for_caller(
            request, org_id, MembersCapability.REMOVE
        )
        try:
            target = self._load_target(organization, membership_id, request.user)
        except MembershipCannotTargetSelf:
            return Response(
                {"detail": ["membership_is_self"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            remove_membership(membership=target)
        except MembershipCannotTargetOwner:
            return Response(
                {"detail": ["membership_is_owner"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        return Response(status=status.HTTP_204_NO_CONTENT)


class ModuleRegistryView(APIView):
    """``GET`` ``/api/organizations/modules/``.

    Public to any authenticated user — the module + capability catalog
    is not an org-scoped concern and needs no permission check. The
    Settings > Members editor reads this to render the capability
    checkbox grid so we never have to ship a capability list in two
    places.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        payload = [
            {
                "key": module.key,
                "name": module.name,
                "description": module.description,
                "row_scoped": module.row_scoped,
                "capabilities": list(module.capabilities),
            }
            for module in all_modules()
        ]
        return Response(payload, status=status.HTTP_200_OK)


class PublicInvitationDetailView(APIView):
    """``GET`` ``/api/invitations/<token>/`` — public, for the accept page."""

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> Response:
        invitation = get_invitation_by_token(token)
        if invitation is None:
            return Response(
                {"detail": ["invitation_not_found"]},
                status=status.HTTP_404_NOT_FOUND,
            )
        if invitation.accepted_at is not None:
            return Response(
                {"detail": ["invitation_already_accepted"]},
                status=status.HTTP_410_GONE,
            )
        if invitation.is_expired:
            return Response(
                {"detail": ["invitation_expired"]},
                status=status.HTTP_410_GONE,
            )
        return Response(
            PublicInvitationSerializer(invitation).data,
            status=status.HTTP_200_OK,
        )


class AcceptInvitationView(APIView):
    """``POST`` ``/api/invitations/<token>/accept/``.

    Creates a new user account bound to the invitation, attaches a
    membership row with the invite's permissions payload, marks the
    invitation accepted, and finally issues JWT cookies so the invitee
    lands on the authenticated side of the app immediately.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        invitation = get_invitation_by_token(token)
        if invitation is None:
            return Response(
                {"detail": ["invitation_not_found"]},
                status=status.HTTP_404_NOT_FOUND,
            )

        serializer = AcceptInvitationSerializer(
            data=request.data, invitation=invitation
        )
        serializer.is_valid(raise_exception=True)

        try:
            user, _ = accept_invitation(
                token=token,
                first_name=serializer.validated_data["first_name"],
                last_name=serializer.validated_data["last_name"],
                password=serializer.validated_data["password"],
            )
        except InvitationNotFound:
            return Response(
                {"detail": ["invitation_not_found"]},
                status=status.HTTP_404_NOT_FOUND,
            )
        except InvitationAlreadyAccepted:
            return Response(
                {"detail": ["invitation_already_accepted"]},
                status=status.HTTP_410_GONE,
            )
        except InvitationExpired:
            return Response(
                {"detail": ["invitation_expired"]},
                status=status.HTTP_410_GONE,
            )
        except InvitationEmailAlreadyRegistered:
            return Response(
                {"detail": ["email_already_registered"]},
                status=status.HTTP_409_CONFLICT,
            )

        access, refresh = tokens_for_user(user)
        response = Response(
            {
                "id": str(user.id),
                "email": user.email,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "full_name": user.full_name,
                "date_joined": user.date_joined.isoformat(),
            },
            status=status.HTTP_201_CREATED,
        )
        set_auth_cookies(response, access_token=access, refresh_token=refresh)
        return response
