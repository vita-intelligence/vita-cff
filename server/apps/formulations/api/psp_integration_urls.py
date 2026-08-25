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
    PinManufacturingOrderOnTrialBatchView,
    PspProductionStatusUpsertView,
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
    # PSP wizard callback — pins the newly-created MO uuid onto the
    # sample fulfilment's TrialBatch so NPD's trial-batch page shows
    # the stage chain instead of "MO connected but no chain yet".
    # Called by PSP's ``create_mo_for_line`` when the CO has an
    # ``npd_payment_id`` (i.e. sample flow born from an NPD payment).
    path(
        "trial-batches/pin-mo/",
        PinManufacturingOrderOnTrialBatchView.as_view(),
        name="trial-batches-pin-mo",
    ),
    # PSP → NPD production-status push. PSP fires this on every
    # ``OrderWizard.notify_co_changed`` so NPD's portal always
    # reflects the latest phase + sub-stage counters.
    path(
        "production-status/upsert/",
        PspProductionStatusUpsertView.as_view(),
        name="production-status-upsert",
    ),
]
