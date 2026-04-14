"""Root URL configuration for the Vita CFF platform."""

from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("apps.accounts.api.urls", namespace="accounts")),
]
