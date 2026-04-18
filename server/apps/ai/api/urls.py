"""URL routes for the AI API."""

from django.urls import path

from apps.ai.api.views import FormulationDraftView

app_name = "ai"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/ai/formulation-draft/",
        FormulationDraftView.as_view(),
        name="formulation-draft",
    ),
]
