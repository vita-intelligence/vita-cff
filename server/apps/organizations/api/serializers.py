"""Serializers for the organizations API."""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.organizations.models import Invitation, Membership, Organization

UserModel = get_user_model()


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


class OrganizationReadSerializer(serializers.ModelSerializer):
    """Public, read-only representation of an organization.

    ``is_owner`` and ``permissions`` describe the *caller's* relationship
    to this row — computed via the serializer context so the frontend can
    gate owner-only and module-specific UI without an extra request.
    ``permissions`` is empty for owners (they bypass the map), and for
    non-owners it is the raw grant dict on their membership.
    """

    is_owner = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()

    class Meta:
        model = Organization
        fields = (
            "id",
            "name",
            "is_owner",
            "permissions",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields

    def _get_caller_membership(self, obj: Organization) -> Membership | None:
        request = self.context.get("request")
        user = getattr(request, "user", None) if request else None
        if user is None or not getattr(user, "is_authenticated", False):
            return None
        return Membership.objects.filter(user=user, organization=obj).first()

    def get_is_owner(self, obj: Organization) -> bool:
        membership = self._get_caller_membership(obj)
        return bool(membership and membership.is_owner)

    def get_permissions(self, obj: Organization) -> dict[str, str]:
        membership = self._get_caller_membership(obj)
        if membership is None or membership.is_owner:
            return {}
        return dict(membership.permissions or {})


class OrganizationCreateSerializer(serializers.ModelSerializer):
    """Input shape for ``POST /api/organizations/``."""

    class Meta:
        model = Organization
        fields = ("name",)

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        if len(trimmed) > 150:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed


class MembershipReadSerializer(serializers.ModelSerializer):
    """Read-only view of a membership row — used by the members module."""

    class Meta:
        model = Membership
        fields = ("id", "organization", "is_owner", "permissions", "created_at")
        read_only_fields = fields


class InvitationCreateSerializer(serializers.Serializer):
    """Input shape for ``POST /api/organizations/<id>/invitations/``."""

    email = serializers.EmailField(required=True)

    def validate_email(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return UserModel.objects.normalize_email(trimmed)


class InvitationReadSerializer(serializers.ModelSerializer):
    """Owner-facing representation of a pending invitation.

    Exposes the raw token so the owner can assemble a shareable link.
    This serializer is never used on the public endpoint — public
    invitation details go through :class:`PublicInvitationSerializer`.
    """

    class Meta:
        model = Invitation
        fields = (
            "id",
            "email",
            "token",
            "permissions",
            "expires_at",
            "accepted_at",
            "created_at",
        )
        read_only_fields = fields


class PublicInvitationSerializer(serializers.ModelSerializer):
    """Public, minimal invitation view shown on the accept page.

    Exposes only what a prospective invitee needs: the email the invite
    was issued for, the destination organization's display name, and
    the inviter's display name. No tokens, no permission payload, no
    internal ids.
    """

    organization_name = serializers.CharField(
        source="organization.name", read_only=True
    )
    invited_by_name = serializers.SerializerMethodField()

    class Meta:
        model = Invitation
        fields = (
            "email",
            "organization_name",
            "invited_by_name",
            "expires_at",
        )
        read_only_fields = fields

    def get_invited_by_name(self, obj: Invitation) -> str:
        inviter = obj.invited_by
        full = f"{inviter.first_name} {inviter.last_name}".strip()
        return full or inviter.email


class AcceptInvitationSerializer(serializers.Serializer):
    """Input shape for ``POST /api/invitations/<token>/accept/``.

    The email comes from the invitation row, so we only require name
    and a password from the invitee. Password rules mirror the
    registration serializer so the accept flow stays on the same bar
    as self-service sign-up.
    """

    first_name = serializers.CharField(
        required=True, allow_blank=False, max_length=150
    )
    last_name = serializers.CharField(
        required=True, allow_blank=False, max_length=150
    )
    password = serializers.CharField(
        write_only=True,
        required=True,
        style={"input_type": "password"},
        trim_whitespace=False,
    )
    password_confirm = serializers.CharField(
        write_only=True,
        required=True,
        style={"input_type": "password"},
        trim_whitespace=False,
    )

    def __init__(self, *args: Any, invitation: Invitation, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.invitation = invitation

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["password"] != attrs["password_confirm"]:
            raise serializers.ValidationError(
                {"password_confirm": [_code("passwords_do_not_match")]}
            )
        draft_user = UserModel(
            email=self.invitation.email,
            first_name=attrs["first_name"],
            last_name=attrs["last_name"],
        )
        try:
            validate_password(attrs["password"], user=draft_user)
        except DjangoValidationError as exc:
            codes = [e.code for e in exc.error_list if getattr(e, "code", None)]
            details = [_code(c) for c in codes] or [_code("invalid_password")]
            raise serializers.ValidationError({"password": details}) from exc
        return attrs
