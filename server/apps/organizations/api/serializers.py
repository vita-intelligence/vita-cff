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

    ``dynamics_customers_managed`` is a non-sensitive boolean derived
    from the org's Dynamics config — true when the integration is
    enabled AND credentials are stored. Exposed here (instead of
    forcing a second fetch of ``/integrations/dynamics/``) so every
    surface that needs to hide the manual "Create customer" UI can
    branch off a flag already present on the org payload. The full
    config remains owner-only via its dedicated endpoint; only the
    boolean is broadcast.
    """

    is_owner = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()
    dynamics_customers_managed = serializers.SerializerMethodField()
    mrpeasy_live = serializers.SerializerMethodField()
    psp_live = serializers.SerializerMethodField()
    psp_base_url = serializers.SerializerMethodField()

    class Meta:
        model = Organization
        fields = (
            "id",
            "name",
            "is_active",
            "is_owner",
            "permissions",
            "dynamics_customers_managed",
            "mrpeasy_live",
            "psp_live",
            "psp_base_url",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields

    def _get_caller_membership(self, obj: Organization) -> Membership | None:
        # Prefer a pre-loaded ``caller_memberships_by_org_id`` dict on
        # the serializer context so list endpoints don't fire two
        # queries per row (one for ``is_owner``, one for
        # ``permissions``). The view layer pre-fetches the caller's
        # memberships in a single ``Membership.objects.filter(user=...,
        # organization_id__in=org_ids)`` round-trip and drops the
        # keyed dict here. Falls back to a per-row query only when the
        # serializer is instantiated outside that flow (admin shell,
        # ad-hoc renders).
        cache = self.context.get("caller_memberships_by_org_id")
        if isinstance(cache, dict):
            return cache.get(str(obj.id))
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

    def get_dynamics_customers_managed(self, obj: Organization) -> bool:
        # Route through the customers-app helper so every server
        # surface (this serializer, the customer-create guard,
        # any future "is Dynamics on?" check) reads from one
        # source of truth — the boolean is JSON-cheap and the
        # helper inspects the JSONField directly so we don't pull
        # the whole encrypted blob through serializer code.
        from apps.customers.services import is_dynamics_live

        return is_dynamics_live(obj)

    def get_mrpeasy_live(self, obj: Organization) -> bool:
        # Same source-of-truth pattern as ``dynamics_customers_managed``
        # above — the helper inspects the JSONField directly so the
        # serializer never decrypts the secret just to compute a
        # boolean. Drives the price-hint component's render gate:
        # the chip stays hidden on orgs without MRPEasy live so we
        # don't surface "no MRPEasy match" alarmism to customers who
        # haven't even connected the integration yet.
        from apps.proposals.mrpeasy import is_mrpeasy_live

        return is_mrpeasy_live(obj)

    def get_psp_live(self, obj: Organization) -> bool:
        """``True`` when the org has a usable PSP integration
        (enabled + base URL + token stored). Mutual-exclusive with
        ``mrpeasy_live`` at the setter level — the two are never
        simultaneously true, but the FE still reads both to render
        the correct picker component and settings-page state."""

        from apps.psp.services import is_psp_live

        return is_psp_live(obj)

    def get_psp_base_url(self, obj: Organization) -> str:
        """Public base URL of the org's PSP instance. Non-sensitive
        — used by the FE to build deep-links back into PSP's UI
        (item pages, BOM pages) from the NPD builder. The API token
        stays owner-only via the dedicated ``psp/`` settings
        endpoint; only the URL is exposed here so every builder-
        capable user can click through, not just owners.

        Empty string when PSP isn't configured or the URL wasn't
        set — the FE hides the deep-link buttons in that case."""

        raw = obj.psp_config or {}
        return str(raw.get("base_url") or "").rstrip("/")


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


class OrganizationUpdateSerializer(serializers.Serializer):
    """Input shape for ``PATCH /api/organizations/<org_id>/``.

    Same validation rules as the create serializer — kept as its own
    class so we can evolve update and create independently later."""

    name = serializers.CharField(required=False, allow_blank=False)

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        if len(trimmed) > 150:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed


class _UserNestedSerializer(serializers.Serializer):
    """Minimal user identity block embedded in membership / invitation
    payloads so the settings UI can render a row without a second
    round-trip per record."""

    id = serializers.UUIDField(read_only=True)
    email = serializers.EmailField(read_only=True)
    first_name = serializers.CharField(read_only=True)
    last_name = serializers.CharField(read_only=True)
    full_name = serializers.SerializerMethodField()
    avatar_image = serializers.CharField(read_only=True, default="")

    def get_full_name(self, obj: Any) -> str:
        full = f"{obj.first_name} {obj.last_name}".strip()
        return full or obj.email


class MembershipReadSerializer(serializers.ModelSerializer):
    """Admin-facing view of a membership row with user info embedded
    so the members table can render without a second round-trip."""

    user = _UserNestedSerializer(read_only=True)

    class Meta:
        model = Membership
        fields = (
            "id",
            "user",
            "is_owner",
            "permissions",
            "groups",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class MembershipGroupsUpdateSerializer(serializers.Serializer):
    """Input shape for ``PATCH /api/.../memberships/<id>/groups/``.

    The list of valid tags is enforced by the service layer (it drops
    unknown values silently rather than failing the whole request)
    so this serializer just ensures the payload is a JSON array of
    strings, not a dict / scalar / missing entirely.
    """

    groups = serializers.ListField(
        child=serializers.CharField(allow_blank=False, max_length=32),
        allow_empty=True,
    )


class MembershipPermissionsUpdateSerializer(serializers.Serializer):
    """Input shape for ``PATCH /api/organizations/<org>/memberships/<id>/``.

    The permissions dict is validated against the module registry by
    the service layer — this serializer just ensures the payload is a
    JSON object, not a list / string / missing entirely.
    """

    permissions = serializers.JSONField(required=True)

    def validate_permissions(self, value: Any) -> Any:
        if not isinstance(value, dict):
            raise serializers.ValidationError([_code("permissions_invalid")])
        return value


class InvitationCreateSerializer(serializers.Serializer):
    """Input shape for ``POST /api/organizations/<id>/invitations/``.

    ``permissions`` is optional — an invite can be issued without a
    pre-set grant and the admin can fill in capabilities after the
    invitee accepts. When provided, the payload is validated against
    the module registry by the service layer.
    """

    email = serializers.EmailField(required=True)
    permissions = serializers.JSONField(required=False)

    def validate_email(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return UserModel.objects.normalize_email(trimmed)

    def validate_permissions(self, value: Any) -> Any:
        if value is None:
            return {}
        if not isinstance(value, dict):
            raise serializers.ValidationError([_code("permissions_invalid")])
        return value


class InvitationReadSerializer(serializers.ModelSerializer):
    """Owner-facing representation of a pending invitation.

    Exposes the raw token so the owner can assemble a shareable link,
    and a derived ``status`` (``pending`` / ``expired``) so the
    settings UI can render a chip without re-computing dates on the
    client. Never used on the public endpoint — that path goes
    through :class:`PublicInvitationSerializer`.
    """

    invited_by = _UserNestedSerializer(read_only=True)
    status = serializers.SerializerMethodField()

    class Meta:
        model = Invitation
        fields = (
            "id",
            "email",
            "token",
            "permissions",
            "invited_by",
            "status",
            "expires_at",
            "accepted_at",
            "created_at",
        )
        read_only_fields = fields

    def get_status(self, obj: Invitation) -> str:
        if obj.accepted_at is not None:
            return "accepted"
        return "expired" if obj.is_expired else "pending"


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
