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
