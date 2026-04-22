"""Views for the accounts API."""

from __future__ import annotations

from django.conf import settings
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.exceptions import TokenError
from rest_framework_simplejwt.tokens import RefreshToken

from apps.accounts.api.serializers import (
    LoginSerializer,
    RegisterSerializer,
    UpdateMeSerializer,
    UserReadSerializer,
)
from apps.accounts.auth.cookies import (
    clear_auth_cookies,
    set_auth_cookies,
    tokens_for_user,
)


class RegisterView(APIView):
    """POST ``/api/auth/register/`` — create a new user account."""

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        serializer = RegisterSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        user = serializer.save()
        output = UserReadSerializer(user).data
        return Response(output, status=status.HTTP_201_CREATED)


class LoginView(APIView):
    """POST ``/api/auth/login/`` — exchange credentials for httpOnly cookies."""

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        serializer = LoginSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        user = serializer.validated_data["user"]
        access, refresh = tokens_for_user(user)
        response = Response(UserReadSerializer(user).data, status=status.HTTP_200_OK)
        set_auth_cookies(response, access_token=access, refresh_token=refresh)
        return response


class LogoutView(APIView):
    """POST ``/api/auth/logout/`` — clear auth cookies.

    This endpoint is authenticated because we want logging out to require a
    valid session in the first place. Unauthenticated logout is a no-op and
    would only mask bugs.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request: Request) -> Response:
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_auth_cookies(response)
        return response


class RefreshView(APIView):
    """POST ``/api/auth/refresh/`` — rotate the access (and refresh) cookie."""

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request) -> Response:
        raw_refresh = request.COOKIES.get(settings.AUTH_COOKIE_REFRESH_NAME)
        if not raw_refresh:
            return Response(
                {"detail": ["refresh_token_missing"]},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        try:
            refresh = RefreshToken(raw_refresh)
        except TokenError:
            return Response(
                {"detail": ["refresh_token_invalid"]},
                status=status.HTTP_401_UNAUTHORIZED,
            )

        data = {"access": str(refresh.access_token)}
        new_refresh: str | None = None
        if settings.SIMPLE_JWT.get("ROTATE_REFRESH_TOKENS"):
            # Issue a brand-new refresh so the client never reuses a stale one.
            refresh.set_jti()
            refresh.set_exp()
            refresh.set_iat()
            new_refresh = str(refresh)

        response = Response(data, status=status.HTTP_200_OK)
        set_auth_cookies(
            response,
            access_token=data["access"],
            refresh_token=new_refresh,
        )
        return response


class MeView(APIView):
    """GET / PATCH ``/api/auth/me/``.

    * ``GET`` returns the authenticated user's profile.
    * ``PATCH`` updates first/last name. Email is deliberately
      immutable here — changing it needs its own re-verification flow.
    """

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        return Response(UserReadSerializer(request.user).data)

    def patch(self, request: Request) -> Response:
        serializer = UpdateMeSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        user = request.user
        update_fields: list[str] = []
        for field in ("first_name", "last_name"):
            if field in serializer.validated_data:
                setattr(user, field, serializer.validated_data[field])
                update_fields.append(field)
        if update_fields:
            user.save(update_fields=update_fields)
        return Response(UserReadSerializer(user).data)


class MeAvatarView(APIView):
    """``POST`` / ``DELETE`` ``/api/auth/me/avatar/``.

    Dedicated endpoint for profile-photo uploads so the main
    ``PATCH /me/`` handler does not have to grow a ``signature_image``
    style branch. ``POST`` accepts a base64 data URL (PNG or JPEG,
    ≤500 KB); ``DELETE`` clears the stored image so the user falls
    back to the initials avatar.
    """

    permission_classes = (IsAuthenticated,)

    def post(self, request: Request) -> Response:
        from config.avatars import AvatarImageInvalid, validate_avatar_image

        raw = request.data.get("avatar_image")
        try:
            normalised = validate_avatar_image(raw)
        except AvatarImageInvalid:
            return Response(
                {"avatar_image": ["invalid_avatar_image"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        user = request.user
        user.avatar_image = normalised
        user.save(update_fields=["avatar_image"])
        return Response(UserReadSerializer(user).data)

    def delete(self, request: Request) -> Response:
        user = request.user
        if user.avatar_image:
            user.avatar_image = ""
            user.save(update_fields=["avatar_image"])
        return Response(UserReadSerializer(user).data)
