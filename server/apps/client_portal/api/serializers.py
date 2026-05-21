"""Wire-shape serializers for the client portal."""

from __future__ import annotations

from rest_framework import serializers


# ---------------------------------------------------------------------------
# Auth + activation
# ---------------------------------------------------------------------------


class ActivationPreviewSerializer(serializers.Serializer):
    """Response for ``GET /api/portal/activate/<token>/`` and the
    sibling ``GET /api/portal/invites/<token>/preview/`` endpoint.

    The kiosk path carries a ``proposal_code`` (the customer is
    being walked into a specific quote) — the customer-portal-invite
    path doesn't, since it's bound to a customer record rather than
    a proposal. The field is therefore optional on the wire; the FE
    falls back to the customer company when it's empty.

    ``expired`` is similarly only populated on the invite path —
    the kiosk preview never expires (the token lives for the
    lifetime of the proposal).
    """

    customer_company = serializers.CharField()
    email_masked = serializers.CharField()
    already_activated = serializers.BooleanField()
    proposal_code = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    expired = serializers.BooleanField(required=False, default=False)


class ActivationRequestSerializer(serializers.Serializer):
    """Body for ``POST /api/portal/activate/<token>/``.

    Email is NOT a field — we read it off the customer the token
    points at. Asking the client to retype it would let them
    activate a different account than the one they're authorised
    for. ``code`` is the 6-digit confirmation printed in the
    kiosk email body; we trim whitespace + accept any 6 digits,
    leading zeros included.
    """

    password = serializers.CharField(write_only=True, min_length=8)
    code = serializers.RegexField(
        regex=r"^\d{6}$",
        help_text="Six-digit confirmation code from the kiosk email.",
    )


class LoginRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()
    password = serializers.CharField(write_only=True)


class PasswordResetRequestSerializer(serializers.Serializer):
    email = serializers.EmailField()


class PasswordResetConfirmSerializer(serializers.Serializer):
    token = serializers.CharField()
    new_password = serializers.CharField(write_only=True, min_length=8)


class MeSerializer(serializers.Serializer):
    """Response for ``GET /api/portal/auth/me/`` — what the
    dashboard needs to render the "Hi <Company>" banner without
    leaking any other customer fields."""

    id = serializers.UUIDField()
    email = serializers.EmailField()
    customer_id = serializers.UUIDField()
    customer_company = serializers.CharField()
    customer_name = serializers.CharField()
    activated_at = serializers.DateTimeField(allow_null=True)
    avatar_image = serializers.CharField(allow_blank=True)


# ---------------------------------------------------------------------------
# Proposal dashboard
# ---------------------------------------------------------------------------


class ProposalListItemSerializer(serializers.Serializer):
    """One row in the dashboard table.

    The proposal-detail wire shape lives in
    :mod:`apps.proposals.api.serializers` and is re-used by the
    portal detail view; this slim list shape just powers the
    overview screen.
    """

    id = serializers.UUIDField()
    code = serializers.CharField()
    title = serializers.CharField()
    status = serializers.CharField()
    updated_at = serializers.DateTimeField()
    created_at = serializers.DateTimeField()
    public_token = serializers.UUIDField(allow_null=True)
