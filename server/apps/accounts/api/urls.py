"""URL routes for the accounts API."""

from django.urls import path

from apps.accounts.api.views import (
    BootstrapView,
    LoginView,
    LogoutView,
    MeAvatarView,
    MeView,
    PasswordResetConfirmView,
    PasswordResetRequestView,
    PasswordResetValidateView,
    RefreshView,
    RegisterView,
)

app_name = "accounts"

urlpatterns = [
    path("auth/register/", RegisterView.as_view(), name="register"),
    path("auth/login/", LoginView.as_view(), name="login"),
    path("auth/logout/", LogoutView.as_view(), name="logout"),
    path("auth/refresh/", RefreshView.as_view(), name="refresh"),
    path("auth/me/", MeView.as_view(), name="me"),
    path("auth/me/avatar/", MeAvatarView.as_view(), name="me-avatar"),
    path("auth/bootstrap/", BootstrapView.as_view(), name="bootstrap"),
    path(
        "auth/password-reset/request/",
        PasswordResetRequestView.as_view(),
        name="password-reset-request",
    ),
    path(
        "auth/password-reset/validate/",
        PasswordResetValidateView.as_view(),
        name="password-reset-validate",
    ),
    path(
        "auth/password-reset/confirm/",
        PasswordResetConfirmView.as_view(),
        name="password-reset-confirm",
    ),
]
