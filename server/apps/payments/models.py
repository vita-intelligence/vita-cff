"""Payment records — one per project payment event."""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.payments.constants import PaymentKind, PaymentMethod, PaymentStatus


class Payment(models.Model):
    """A single payment recorded by the finance team against a
    project.

    Two-step lifecycle: ``record_payment`` writes ``PENDING``;
    ``approve_payment`` flips to ``APPROVED`` AND opens the matching
    downstream gate. Voiding an approved payment does NOT roll back
    the gate — the gate is forward-only. The use case for voids is
    "I miskeyed the amount; record a fresh payment row alongside
    this voided one".

    ``kind`` distinguishes two gates in the customer lifecycle:

    * ``DEPOSIT`` — paid AFTER the customer signs the proposal on
      the kiosk. Unlocks trial batches (scientists can't schedule a
      run until finance confirms the deposit landed). One deposit
      Payment per proposal (bundle-level — a single deposit covers
      every formulation in the merged proposal).
    * ``FINAL`` — paid AFTER trial batches pass QC and the customer
      signs the FINAL spec sheet. Unlocks the label-design workflow
      (per-formulation, matches the existing LabelDesign gate).

    The two together sum to 100% of the proposal total, split by
    ``Proposal.deposit_percent`` (asked at proposal creation). Either
    edge can be 0 — a 0% deposit means no deposit gate exists (trial
    batches are unlocked immediately on kiosk-sign), a 100% deposit
    means no final gate exists (label design is unlocked immediately
    once the final spec is customer-signed).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="payments",
    )
    kind = models.CharField(
        _("kind"),
        max_length=16,
        choices=PaymentKind.choices,
        default=PaymentKind.FINAL,
        db_index=True,
        help_text=_(
            "Which gate this payment opens — DEPOSIT (unlocks trial "
            "batches, per-proposal) or FINAL (unlocks label design, "
            "per-formulation). Existing rows pre-migration were all "
            "the label-gate variant so the default keeps them intact."
        ),
    )
    formulation = models.ForeignKey(
        "formulations.Formulation",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="payments",
        help_text=_(
            "Set on FINAL payments (per-formulation). Null on DEPOSIT "
            "payments — deposits are bundle-level and identify their "
            "target via ``proposal`` instead. PROTECT because a "
            "formulation that received a payment cannot be silently "
            "deleted — finance audit relies on the linkage."
        ),
    )
    proposal = models.ForeignKey(
        "proposals.Proposal",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="payments",
        help_text=_(
            "Set on DEPOSIT payments (per-proposal). Null on FINAL "
            "payments. One deposit covers every formulation on a "
            "bundled proposal — the trial-batch gate for each "
            "formulation walks back to its accepted proposal to check."
        ),
    )
    label_design = models.ForeignKey(
        "label_design.LabelDesign",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="payments",
        help_text=_(
            "FINAL payments only — the downstream label-design "
            "workflow this payment unlocks. SET_NULL so the payment "
            "record survives if the label workflow is ever deleted "
            "(which should be rare — kept conservative for the "
            "audit trail)."
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

    assigned_finance_officer = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="assigned_payments",
        help_text=_(
            "Finance-team member who owns this payment (recording, "
            "chasing, reconciliation). Pointer-only — being assigned "
            "grants no capabilities. Gated by the "
            "``finance.assign_officer`` capability. Mirrors the "
            "``sales_person`` / ``lead_scientist`` pointer convention "
            "and drives the ``scope=mine`` filter on the finance "
            "queue."
        ),
    )

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
