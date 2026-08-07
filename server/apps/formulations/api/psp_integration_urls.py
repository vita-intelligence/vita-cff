"""URL routes for PSP-facing integration reads.

Mounted at ``/api/psp-integration/`` from :mod:`config.urls`; kept
in its own module (rather than folded into ``apps.formulations.api.urls``)
because the auth boundary is different: these views take a shared
bearer token and are otherwise open, whereas the sibling
formulations URLs are JWT-only.
"""

from django.urls import path

from apps.formulations.api.psp_integration import (
    InDevelopmentFormulationsView,
    LatestSpecSheetHtmlView,
    LatestValidationSheetHtmlView,
)


app_name = "psp_integration"


urlpatterns = [
    path(
        "formulations/in-development/",
        InDevelopmentFormulationsView.as_view(),
        name="in-development",
    ),
    path(
        "specifications/latest.html",
        LatestSpecSheetHtmlView.as_view(),
        name="specifications-latest-html",
    ),
    path(
        "validations/latest.html",
        LatestValidationSheetHtmlView.as_view(),
        name="validations-latest-html",
    ),
]
