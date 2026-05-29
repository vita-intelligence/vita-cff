"""URL routes for the label-design staff API."""

from django.urls import path

from apps.label_design.api.views import (
    LabelDesignAssignDesignerView,
    LabelDesignContentBlockHTMLView,
    LabelDesignContentBlockJSONView,
    LabelDesignContentBlockPDFView,
    LabelDesignContentBlockPNGView,
    LabelDesignContentBlockTextView,
    LabelDesignDetailView,
    LabelDesignDirectorReviewView,
    LabelDesignHoldView,
    LabelDesignListView,
    LabelDesignResumeView,
    LabelDesignReviewsView,
    LabelDesignScientistReviewView,
    LabelDesignSpecRenderView,
    LabelDesignSubmitForReviewView,
    LabelDesignTransitionsView,
    LabelDesignUploadArtworkView,
)


app_name = "label_design"


_org = "organizations/<uuid:org_id>/label-designs"


urlpatterns = [
    path(f"{_org}/", LabelDesignListView.as_view(), name="list"),
    path(
        f"{_org}/<uuid:label_design_id>/",
        LabelDesignDetailView.as_view(),
        name="detail",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/assign-designer/",
        LabelDesignAssignDesignerView.as_view(),
        name="assign-designer",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/upload-artwork/",
        LabelDesignUploadArtworkView.as_view(),
        name="upload-artwork",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/submit-for-review/",
        LabelDesignSubmitForReviewView.as_view(),
        name="submit-for-review",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/scientist-review/",
        LabelDesignScientistReviewView.as_view(),
        name="scientist-review",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/director-review/",
        LabelDesignDirectorReviewView.as_view(),
        name="director-review",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/hold/",
        LabelDesignHoldView.as_view(),
        name="hold",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/resume/",
        LabelDesignResumeView.as_view(),
        name="resume",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/transitions/",
        LabelDesignTransitionsView.as_view(),
        name="transitions",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/spec/",
        LabelDesignSpecRenderView.as_view(),
        name="spec-render",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/reviews/",
        LabelDesignReviewsView.as_view(),
        name="reviews",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/content-block/",
        LabelDesignContentBlockJSONView.as_view(),
        name="content-block-json",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/content-block/pdf/",
        LabelDesignContentBlockPDFView.as_view(),
        name="content-block-pdf",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/content-block/png/",
        LabelDesignContentBlockPNGView.as_view(),
        name="content-block-png",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/content-block/text/",
        LabelDesignContentBlockTextView.as_view(),
        name="content-block-text",
    ),
    path(
        f"{_org}/<uuid:label_design_id>/content-block/html/",
        LabelDesignContentBlockHTMLView.as_view(),
        name="content-block-html",
    ),
]
