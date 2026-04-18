"""Serializers for the accounts API."""

from __future__ import annotations

from typing import Any

from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import transaction
from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

UserModel = get_user_model()


def _code(value: str) -> ErrorDetail:
    """Return an :class:`ErrorDetail` whose message *and* code are ``value``.

    DRF wraps raw strings in ``ErrorDetail(msg, code='invalid')`` by default,
    which means our custom codes get silently replaced with ``'invalid'`` in
    the response. Building the detail explicitly guarantees the exception
    handler emits the snake_case machine code we actually want.
    """

    return ErrorDetail(value, code=value)


class UserReadSerializer(serializers.ModelSerializer):
    """Public, read-only representation of a user."""

    full_name = serializers.CharField(read_only=True)

    class Meta:
        model = UserModel
        fields = (
            "id",
            "email",
            "first_name",
            "last_name",
            "full_name",
            "date_joined",
        )
        read_only_fields = fields


class UpdateMeSerializer(serializers.Serializer):
    """Input shape for ``PATCH /api/auth/me/``.

    Users can update their own first/last name. Email changes are
    deliberately out of scope — they would require re-verification +
    collision handling and belong in their own flow.
    """

    first_name = serializers.CharField(
        required=False, allow_blank=False, max_length=150
    )
    last_name = serializers.CharField(
        required=False, allow_blank=False, max_length=150
    )

    def validate_first_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed

    def validate_last_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


class RegisterSerializer(serializers.ModelSerializer):
    """Input serializer for the registration endpoint.

    The ``email`` field is explicitly declared with an empty ``validators``
    list so DRF's auto-generated ``UniqueValidator`` does not run — we own
    uniqueness checking via :meth:`validate_email` so we can emit our own
    machine-readable code.
    """

    email = serializers.EmailField(required=True, allow_blank=False, validators=[])
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

    class Meta:
        model = UserModel
        fields = (
            "email",
            "first_name",
            "last_name",
            "password",
            "password_confirm",
        )
        extra_kwargs = {
            "first_name": {"required": True, "allow_blank": False},
            "last_name": {"required": True, "allow_blank": False},
        }

    def validate_email(self, value: str) -> str:
        normalized = UserModel.objects.normalize_email(value)
        if UserModel.objects.filter(email__iexact=normalized).exists():
            raise serializers.ValidationError(_code("email_already_exists"))
        return normalized

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if attrs["password"] != attrs["password_confirm"]:
            raise serializers.ValidationError(
                {"password_confirm": [_code("passwords_do_not_match")]}
            )
        draft_user = UserModel(
            email=attrs["email"],
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

    @transaction.atomic
    def create(self, validated_data: dict[str, Any]) -> Any:
        validated_data.pop("password_confirm", None)
        password = validated_data.pop("password")
        return UserModel.objects.create_user(password=password, **validated_data)


class LoginSerializer(serializers.Serializer):
    """Validate an email/password pair and return the authenticated user.

    We do the lookup manually (instead of calling ``django.contrib.auth.
    authenticate``) so the email comparison is case-insensitive and the
    error code shape is under our control. Every failure — unknown user,
    wrong password, inactive user — maps to the same ``invalid_credentials``
    code so the endpoint never leaks which emails are registered.
    """

    email = serializers.EmailField(required=True)
    password = serializers.CharField(
        required=True,
        write_only=True,
        style={"input_type": "password"},
        trim_whitespace=False,
    )

    _INVALID = [_code("invalid_credentials")]

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        email = UserModel.objects.normalize_email(attrs["email"])
        password = attrs["password"]

        user = UserModel.objects.filter(email__iexact=email).first()
        if user is None or not user.check_password(password) or not user.is_active:
            raise serializers.ValidationError({"detail": self._INVALID})

        attrs["user"] = user
        return attrs
