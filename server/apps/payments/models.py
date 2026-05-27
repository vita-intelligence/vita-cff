"""Payment records — one per project payment event."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.payments.constants import PaymentMethod, PaymentStatus


class Payment(models.Model):
    """A single payment recorded by the finance team against a
    project.

    Two-step lifecycle: ``record_payment`` writes ``PENDING``;
    ``approve_payment`` flips to ``APPROVED`` AND drives the
    matching :class:`LabelDesign` from ``PAYMENT_PENDING`` to
    ``LABEL_PATH_PENDING``. Voiding an approved payment does NOT
    roll back the LabelDesign — the gate is forward-only. The use
    case for voids is "I miskeyed the amount; record a fresh
    payment row alongside this voided one".
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="payments",
    )
    formulation = models.ForeignKey(
        "formulations.Formulation",
        on_delete=models.PROTECT,
        related_name="payments",
        help_text=_(
            "PROTECT because a project that received a payment "
            "cannot be silently deleted — finance audit relies on "
            "the linkage."
        ),
    )
    label_design = models.ForeignKey(
        "label_design.LabelDesign",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="payments",
        help_text=_(
            "The downstream label-design workflow this payment "
            "unlocks. SET_NULL so the payment record survives if "
            "the label workflow is ever deleted (which should be "
            "rare — kept conservative for the audit trail)."
        ),
    )

    amount = models.DecimalField(_("amount"), max_digits=12, decimal_places=2)
    currency = models.CharField(_("currency"), max_length=3, default="GBP")
    method = models.CharField(
        _("method"),
        max_length=24,
        choices=PaymentMethod.choices,
        default=PaymentMethod.BANK_TRANSFER,
    )
    external_reference = models.CharField(
        _("external reference"),
        max_length=160,
        blank=True,
        default="",
        help_text=_(
            "Bank ref, Stripe payment intent id, etc. — whatever "
            "the finance team needs to reconcile against the "
            "external ledger."
        ),
    )
    invoice_number = models.CharField(
        _("invoice number"),
        max_length=64,
        blank=True,
        default="",
        db_index=True,
    )
    paid_at = models.DateTimeField(_("paid at"))

    recorded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="recorded_payments",
    )
    approved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="approved_payments",
    )
    approved_at = models.DateTimeField(null=True, blank=True)

    status = models.CharField(
        _("status"),
        max_length=16,
        choices=PaymentStatus.choices,
        default=PaymentStatus.PENDING,
    )
    notes = models.TextField(blank=True, default="")

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("payment")
        verbose_name_plural = _("payments")
        ordering = ("-paid_at",)
        indexes = [
            models.Index(fields=("organization", "status")),
            models.Index(fields=("formulation", "-paid_at")),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"Payment({self.amount} {self.currency}, {self.status})"
