"""JWT authentication for the client portal.

Mirrors :class:`apps.accounts.auth.authentication.CookieJWTAuthentication`
exactly except for two differences:

* Reads from ``PORTAL_AUTH_COOKIE_ACCESS_NAME`` instead of the staff
  cookie, so staff and client sessions can coexist in one browser.
* Resolves the token's ``user_id`` claim against
  :class:`apps.client_portal.models.ClientAccount` instead of the
  staff ``User`` table.

Why a dedicated class rather than dispatching on a flag: keeps every
portal endpoint locked to the client table at type level. A staff
JWT smuggled into a portal cookie would fail signature check
(separate secret in ``SIMPLE_JWT``) and even if signatures matched,
the ``user_id`` would resolve to a row in ``client_portal_clientaccount``,
never the staff users table.
"""

from __future__ import annotations

from django.conf import settings
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import (
    AuthenticationFailed,
    InvalidToken,
)
from rest_framework_simplejwt.settings import api_settings as jwt_settings

from apps.client_portal.models import ClientAccount


class PortalCookieJWTAuthentication(JWTAuthentication):
    """Authenticate portal requests against the client cookie.

    Falls back to the ``Authorization: Bearer`` header so tooling
    (tests, curl) can hit portal endpoints without a real browser.
    """

    def authenticate(self, request):  # type: ignore[override]
        raw_token = request.COOKIES.get(
            settings.PORTAL_AUTH_COOKIE_ACCESS_NAME
        )
        if raw_token is None:
            header = self.get_header(request)
            if header is None:
                return None
            raw_token = self.get_raw_token(header)
            if raw_token is None:
                return None

        # A cookie can be present but invalid — typical case is a
        # stale ``vita_portal_access`` from an earlier activation
        # against a proposal whose ``ClientAccount`` we've since
        # wiped (test resets, password rotation, the user clearing
        # their own row). DRF's default behaviour on
        # ``AuthenticationFailed`` is to short-circuit with 401 BEFORE
        # the view's ``permission_classes`` get a chance to vote, so
        # a stale cookie would block ``AllowAny`` endpoints like
        # activation / login. Swallowing the validation error here
        # — returning ``None`` instead of raising — degrades the
        # request to anonymous; the permission layer then decides
        # whether anonymous is acceptable.
        try:
            validated_token = self.get_validated_token(raw_token)
            return self.get_user(validated_token), validated_token
        except (InvalidToken, AuthenticationFailed):
            return None

    def get_user(self, validated_token):  # type: ignore[override]
        # Resolve directly against :class:`ClientAccount` — never the
        # staff users table. The default simplejwt impl looks up
        # ``AUTH_USER_MODEL`` which is the staff User; if a staff JWT
        # ever leaked into the portal cookie that would silently let
        # the staff identity through. Explicit resolution is the
        # safer fence.
        try:
            account_id = validated_token[jwt_settings.USER_ID_CLAIM]
        except KeyError as exc:
            raise InvalidToken("Token has no recognised user id claim.") from exc

        try:
            account = ClientAccount.objects.get(pk=account_id)
        except ClientAccount.DoesNotExist as exc:
            raise AuthenticationFailed(
                "User not found.", code="user_not_found"
            ) from exc

        if not account.is_active:
            raise AuthenticationFailed(
                "Account is inactive.", code="user_inactive"
            )

        return account
