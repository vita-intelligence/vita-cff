"""URL routes for the payments API."""

from django.urls import path

from apps.payments.api.file_views import (
    PaymentInvoiceDetailView,
    PaymentInvoicesView,
)
from apps.payments.api.views import (
    PaymentApproveView,
    PaymentAssignFinanceOfficerView,
    PaymentDetailView,
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
        "organizations/<uuid:org_id>/payments/<uuid:payment_id>/",
        PaymentDetailView.as_view(),
        name="payment-detail",
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
    path(
        "organizations/<uuid:org_id>/payments/<uuid:payment_id>/invoices/",
        PaymentInvoicesView.as_view(),
        name="payment-invoices",
    ),
    path(
        "organizations/<uuid:org_id>/payments/<uuid:payment_id>/invoices/<uuid:file_id>/",
        PaymentInvoiceDetailView.as_view(),
        name="payment-invoice-detail",
    ),
]
