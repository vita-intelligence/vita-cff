"""URL routes for the payments API."""

from django.urls import path

from apps.payments.api.views import (
    PaymentApproveView,
    PaymentAssignFinanceOfficerView,
    PaymentListCreateView,
    PaymentVoidView,
    PendingPaymentProjectsView,
)


app_name = "payments"


urlpatterns = [
    path(
        "organizations/<uuid:org_id>/payments/",
        PaymentListCreateView.as_view(),
        name="payment-list",
    ),
    # Pending-payment queue for the finance UI — the list of projects
    # whose LabelDesign is sitting at PAYMENT_PENDING. Lets the
    # finance team click a card instead of pasting a formulation UUID.
    path(
        "organizations/<uuid:org_id>/payments/pending-projects/",
        PendingPaymentProjectsView.as_view(),
        name="payment-pending-projects",
    ),
    path(
        "organizations/<uuid:org_id>/payments/<uuid:payment_id>/approve/",
        PaymentApproveView.as_view(),
        name="payment-approve",
    ),
    path(
        "organizations/<uuid:org_id>/payments/<uuid:payment_id>/void/",
        PaymentVoidView.as_view(),
        name="payment-void",
    ),
    path(
        "organizations/<uuid:org_id>/payments/<uuid:payment_id>/assign-finance-officer/",
        PaymentAssignFinanceOfficerView.as_view(),
        name="payment-assign-finance-officer",
    ),
]
