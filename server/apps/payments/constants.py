"""Payment enums."""

from __future__ import annotations

from django.db import models
from django.utils.translation import gettext_lazy as _


class PaymentStatus(models.TextChoices):
    PENDING = "pending", _("Pending")
    APPROVED = "approved", _("Approved")
    VOIDED = "voided", _("Voided")


class PaymentMethod(models.TextChoices):
    BANK_TRANSFER = "bank_transfer", _("Bank transfer")
    CARD = "card", _("Card")
    STRIPE = "stripe", _("Stripe")
    OTHER = "other", _("Other")


class PaymentKind(models.TextChoices):
    #: Bundle-level, paid after kiosk sign, unlocks trial batches.
    DEPOSIT = "deposit", _("Deposit")
    #: Per-formulation, paid after FINAL spec sign, unlocks labelling.
    FINAL = "final", _("Final")
    #: Customer-initiated top-up during an active trial-batch cycle.
    #: Approval bumps ``TrialBatchCycle.total_slots`` and appends new
    #: :class:`~apps.trial_batches.models.TrialBatchSlot` rows for the
    #: extra samples paid for.
    ADDITIONAL_SAMPLES = "additional_samples", _("Additional samples")
    #: Per-formulation, paid when the customer picks
    #: ``design_by_us`` on the label workflow. Approval unlocks the
    #: MA-ST-B-009 design brief. Amount pulled from the org's
    #: :class:`~apps.payments.models.SamplePricingConfig`.
    #: ``label_design_fee_amount`` — 0 or unset skips the gate.
    LABEL_DESIGN = "label_design", _("Label design")
