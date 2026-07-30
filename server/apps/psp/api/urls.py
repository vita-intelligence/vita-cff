"""URL routes for the PSP integration API."""

from django.urls import path

from apps.psp.api.views import (
    PspAccessTokenListCreateView,
    PspAccessTokenRevokeView,
    PspCreateFinishedProductView,
    PspIntegrationView,
    PspItemBomView,
    PspItemDetailView,
    PspItemListView,
    PspItemMirrorView,
    PspTestConnectionView,
    PspAllergensListView,
    PspProductFamiliesListView,
    PspStorageTagsListView,
    PspUnitsOfMeasurementListView,
    PspWorkstationGroupListView,
    PspWorkstationUserListView,
)


app_name = "psp"

urlpatterns = [
    path(
        "organizations/<uuid:org_id>/integrations/psp/",
        PspIntegrationView.as_view(),
        name="psp-integration",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/test/",
        PspTestConnectionView.as_view(),
        name="psp-test",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/items/",
        PspItemListView.as_view(),
        name="psp-items",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/items/<uuid:item_uuid>/",
        PspItemDetailView.as_view(),
        name="psp-item-detail",
    ),
    # Live per-stage BOM read — each FE stage card fetches its own
    # item's active primary BOM so what the operator sees is the
    # authoritative recipe on PSP, not a synthesized display.
    path(
        "organizations/<uuid:org_id>/integrations/psp/items/<uuid:item_uuid>/bom/",
        PspItemBomView.as_view(),
        name="psp-item-bom",
    ),
    # Mirror-on-pick — POST-only endpoint the builder hits after
    # the scientist picks a PSP item. Upserts into local catalogues
    # and returns a local Item DTO so the formulation-line flow
    # doesn't need to know PSP was involved.
    path(
        "organizations/<uuid:org_id>/integrations/psp/items/<uuid:item_uuid>/mirror/",
        PspItemMirrorView.as_view(),
        name="psp-item-mirror",
    ),
    # Stage builder's workstation-group picker. Proxies to PSP's
    # ``/api/integration/workstation-groups`` — silent-degrade
    # empty on any failure.
    path(
        "organizations/<uuid:org_id>/integrations/psp/workstation-groups/",
        PspWorkstationGroupListView.as_view(),
        name="psp-workstation-groups",
    ),
    # Feeds the stage builder's workers multi-picker.
    path(
        "organizations/<uuid:org_id>/integrations/psp/workstation-users/",
        PspWorkstationUserListView.as_view(),
        name="psp-workstation-users",
    ),
    # Stage form's UOM + product family pickers (phase 2b). Both
    # silent-degrade to an empty list on any failure so the FE
    # renders "no options" the same way a genuinely empty catalogue
    # would.
    path(
        "organizations/<uuid:org_id>/integrations/psp/units-of-measurement/",
        PspUnitsOfMeasurementListView.as_view(),
        name="psp-units-of-measurement",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/product-families/",
        PspProductFamiliesListView.as_view(),
        name="psp-product-families",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/allergens/",
        PspAllergensListView.as_view(),
        name="psp-allergens",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp/storage-tags/",
        PspStorageTagsListView.as_view(),
        name="psp-storage-tags",
    ),
    # Create a new PSP finished-product item from the New-formulation
    # dialog when the scientist doesn't want to link an existing SKU.
    # Locked to ``item_type=finished_product`` inside the service.
    path(
        "organizations/<uuid:org_id>/integrations/psp/finished-products/",
        PspCreateFinishedProductView.as_view(),
        name="psp-create-finished-product",
    ),
    # PSP-facing tokens — mint + list + revoke bearer tokens PSP
    # presents on the reverse integration path (``/api/psp-integration/*``).
    # Owner-only; the raw token leaves the boundary exactly once on
    # mint and is never returned by any subsequent call.
    path(
        "organizations/<uuid:org_id>/integrations/psp-access-tokens/",
        PspAccessTokenListCreateView.as_view(),
        name="psp-access-tokens",
    ),
    path(
        "organizations/<uuid:org_id>/integrations/psp-access-tokens/<uuid:token_id>/revoke/",
        PspAccessTokenRevokeView.as_view(),
        name="psp-access-token-revoke",
    ),
]
