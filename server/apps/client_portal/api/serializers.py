"""Wire-shape serializers for the client portal."""

from __future__ import annotations

from rest_framework import serializers


# ---------------------------------------------------------------------------
# Auth + activation
# ---------------------------------------------------------------------------


class ActivationPreviewSerializer(serializers.Serializer):
    """Response for ``GET /api/portal/activate/<token>/``."""

    customer_company = serializers.CharField()
    email_masked = serializers.CharField()
    already_activated = serializers.BooleanField()
    proposal_code = serializers.CharField()


class ActivationRequestSerializer(serializers.Serializer):
    """Body for ``POST /api/portal/activate/<token>/``.

    Email is NOT a field — we read it off the customer the token
    points at. Asking the client to retype it would let them
    activate a different account than the one they're authorised
    for.
    """

    password = serializers.CharField(write_only=True, min_length=8)


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
