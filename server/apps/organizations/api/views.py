"""Views for the organizations API."""

from __future__ import annotations

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
    OrganizationCreateSerializer,
    OrganizationReadSerializer,
    PublicInvitationSerializer,
)
from apps.organizations.models import Organization
from apps.organizations.modules import PermissionLevel
from apps.organizations.services import (
    InvitationAlreadyAccepted,
    InvitationAlreadyExists,
    InvitationEmailAlreadyMember,
    InvitationEmailAlreadyRegistered,
    InvitationExpired,
    InvitationNotFound,
    accept_invitation,
    create_invitation,
    create_organization,
    get_invitation_by_token,
    get_membership,
    has_permission,
    list_user_organizations,
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


def _load_org_for_caller(request: Request, org_id: str) -> Organization:
    """Load an org and verify the caller is an admin on its members module.

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
    if not has_permission(membership, "members", PermissionLevel.ADMIN):
        raise PermissionDenied()
    return organization


class InvitationCreateView(APIView):
    """``POST`` ``/api/organizations/<org_id>/invitations/``.

    Requires ``members:admin`` on the target organization. Owners always
    satisfy this thanks to the owner bypass in :func:`has_permission`.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request: Request, org_id: str) -> Response:
        organization = _load_org_for_caller(request, org_id)

        serializer = InvitationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            invitation = create_invitation(
                organization=organization,
                invited_by=request.user,
                email=serializer.validated_data["email"],
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

        return Response(
            InvitationReadSerializer(invitation).data,
            status=status.HTTP_201_CREATED,
        )


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
