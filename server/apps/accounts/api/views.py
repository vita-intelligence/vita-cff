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
    """GET ``/api/auth/me/`` — return the authenticated user's profile."""

    permission_classes = (IsAuthenticated,)

    def get(self, request: Request) -> Response:
        return Response(UserReadSerializer(request.user).data)
