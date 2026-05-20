"""Portal Settings endpoints.

Five routes:

* ``GET    /api/portal/profile/`` — current values for the
  customer's editable surface (email + name + company + phone +
  invoice / delivery address).
* ``PATCH  /api/portal/profile/`` — direct update for everything
  except the email. Whatever fields are present in the body get
  saved.
* ``POST   /api/portal/profile/email/request/`` — start the email
  change flow. Mails a 6-digit code to the *new* address.
* ``POST   /api/portal/profile/email/confirm/`` — finish the email
  change. The code from the previous step proves the new address
  is reachable; on success we flip both ``ClientAccount.email``
  (the login) and ``Customer.email`` (the CRM contact).
* ``POST   /api/portal/profile/password/`` — replace the password
  after verifying the current one.
"""

from __future__ import annotations

import logging

from django.core.exceptions import ValidationError
from rest_framework import serializers, status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.client_portal.api.views import PortalAPIView, _err
from apps.client_portal.email import send_email_change_code
from apps.client_portal.profile_services import (
    CurrentPasswordIncorrect,
    EmailAlreadyInUse,
    InvalidEmailChangeCode,
    ProfileError,
    change_password,
    confirm_email_change,
    get_customer_profile,
    request_email_change,
    update_customer_profile,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


class ProfileSerializer(serializers.Serializer):
    customer_id = serializers.UUIDField(read_only=True)
    email = serializers.EmailField(read_only=True)
    name = serializers.CharField(allow_blank=True, max_length=200)
    company = serializers.CharField(allow_blank=True, max_length=200)
    phone = serializers.CharField(allow_blank=True, max_length=60)
    invoice_address = serializers.CharField(allow_blank=True)
    delivery_address = serializers.CharField(allow_blank=True)


class EmailChangeRequestSerializer(serializers.Serializer):
    new_email = serializers.EmailField()


class EmailChangeConfirmSerializer(serializers.Serializer):
    code = serializers.RegexField(regex=r"^\d{6}$")


class PasswordChangeSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=8)


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


def _payload(account) -> dict:
    profile = get_customer_profile(account=account)
    return {
        "customer_id": profile.customer_id,
        "email": profile.email,
        "name": profile.name,
        "company": profile.company,
        "phone": profile.phone,
        "invoice_address": profile.invoice_address,
        "delivery_address": profile.delivery_address,
    }


class ProfileView(PortalAPIView):
    """``GET`` / ``PATCH`` ``/api/portal/profile/``."""

    def get(self, request: Request) -> Response:
        return Response(_payload(request.user))

    def patch(self, request: Request) -> Response:
        serializer = ProfileSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        # Only forward fields the client actually sent; the service
        # treats ``None`` as "don't touch", so unset values stay.
        data = serializer.validated_data
        update_customer_profile(
            account=request.user,
            name=data.get("name"),
            company=data.get("company"),
            phone=data.get("phone"),
            invoice_address=data.get("invoice_address"),
            delivery_address=data.get("delivery_address"),
        )
        return Response(_payload(request.user))


class EmailChangeRequestView(PortalAPIView):
    """``POST /api/portal/profile/email/request/``."""

    def post(self, request: Request) -> Response:
        serializer = EmailChangeRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        new_email = serializer.validated_data["new_email"]
        try:
            issued = request_email_change(
                account=request.user, new_email=new_email,
            )
        except EmailAlreadyInUse:
            return _err("email_already_in_use", status.HTTP_409_CONFLICT)
        except ProfileError as exc:
            return _err(exc.code, status.HTTP_400_BAD_REQUEST)
        try:
            send_email_change_code(
                to_email=issued.request.new_email,
                code=issued.plaintext_code,
            )
        except Exception:  # noqa: BLE001 — log + degrade
            logger.exception(
                "portal.email_change: failed to mail code to %s",
                issued.request.new_email,
            )
        return Response({"detail": "ok"})


class EmailChangeConfirmView(PortalAPIView):
    """``POST /api/portal/profile/email/confirm/``."""

    def post(self, request: Request) -> Response:
        serializer = EmailChangeConfirmSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            confirm_email_change(
                account=request.user,
                code=serializer.validated_data["code"],
            )
        except InvalidEmailChangeCode:
            return _err(
                "invalid_email_change_code",
                status.HTTP_400_BAD_REQUEST,
            )
        except EmailAlreadyInUse:
            return _err("email_already_in_use", status.HTTP_409_CONFLICT)
        return Response(_payload(request.user))


class AvatarUploadSerializer(serializers.Serializer):
    """Body for the avatar upload endpoint.

    Accepts a data URL (``data:image/...;base64,...``) of bounded
    size — the client crops + scales before sending so the staff
    avatar code (which already trusts the data URL is web-displayable)
    can read this column without a second renderer.
    """

    avatar_image = serializers.CharField(
        max_length=2_000_000,
        allow_blank=True,
        help_text=(
            "Base64 data URL, or an empty string to clear the avatar. "
            "Empty string falls back to initials in the staff comments "
            "feed; the portal chat does the same."
        ),
    )


class AvatarView(PortalAPIView):
    """``POST /api/portal/profile/avatar/`` — set or clear the
    client's avatar.

    Upload is via base64 data URL (same shape staff uses) so the
    portal can crop + encode client-side and we never touch
    multipart parsing. Empty string clears it; the field is
    nullable in effect because the staff renderer falls back to
    initials.
    """

    def post(self, request: Request) -> Response:
        serializer = AvatarUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        account = request.user
        account.avatar_image = serializer.validated_data["avatar_image"]
        account.save(update_fields=["avatar_image", "updated_at"])
        return Response({"avatar_image": account.avatar_image})


class PasswordChangeView(PortalAPIView):
    """``POST /api/portal/profile/password/``."""

    def post(self, request: Request) -> Response:
        serializer = PasswordChangeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            change_password(
                account=request.user,
                current_password=serializer.validated_data["current_password"],
                new_password=serializer.validated_data["new_password"],
            )
        except CurrentPasswordIncorrect:
            return _err(
                "current_password_incorrect",
                status.HTTP_400_BAD_REQUEST,
            )
        except ValidationError as exc:
            return _err(
                "weak_password",
                status.HTTP_400_BAD_REQUEST,
                messages=list(exc.messages),
            )
        return Response({"detail": "ok"})
