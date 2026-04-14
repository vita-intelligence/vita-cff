"""Custom JWT authentication that reads tokens from httpOnly cookies."""

from __future__ import annotations

from django.conf import settings
from rest_framework.request import Request
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.tokens import Token


class CookieJWTAuthentication(JWTAuthentication):
    """Authenticate requests using an access token stored in a cookie.

    We still support the stock ``Authorization: Bearer ...`` header for
    tooling (tests, curl, Postman), but the cookie is tried first because
    the production frontend never sends an Authorization header.
    """

    def authenticate(self, request: Request):  # type: ignore[override]
        raw_token = request.COOKIES.get(settings.AUTH_COOKIE_ACCESS_NAME)
        if raw_token is None:
            # Fall back to the header-based flow provided by the parent class.
            return super().authenticate(request)

        validated_token: Token = self.get_validated_token(raw_token)
        return self.get_user(validated_token), validated_token
