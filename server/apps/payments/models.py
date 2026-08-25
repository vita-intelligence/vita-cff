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
        max_length=32,
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
    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="payments",
        help_text=_(
            "Address-book customer the payment is billed to. "
            "Denormalized alongside the formulation / proposal FKs so "
            "the finance queue can surface 'who ordered this' without "
            "walking two joins per row. Backfilled from "
            "``formulation.customer`` (FINAL) / ``proposal.customer`` "
            "(DEPOSIT) at migration time; new rows get it set at "
            "``record_payment`` time. SET_NULL keeps the audit trail "
            "intact when a customer row is archived."
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


class PaymentFile(models.Model):
    """Invoice / evidence document attached to a Payment.

    Mirrors ``FormulationFile`` (bytes on our storage, not a URL) so
    the audit trail can point at the actual PDF finance was working
    against. Payments don't push to any external system, so there's
    no ``psp_uuid`` column — this is a local-only artefact.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    payment = models.ForeignKey(
        Payment,
        on_delete=models.CASCADE,
        related_name="invoices",
    )
    file = models.FileField(_("file"), upload_to="payment-invoices/")
    filename = models.CharField(max_length=255)
    mime = models.CharField(max_length=120)
    byte_size = models.PositiveIntegerField()
    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="+",
    )
    uploaded_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("payment file")
        verbose_name_plural = _("payment files")
        ordering = ("-uploaded_at",)
        indexes = [
            models.Index(fields=("payment", "-uploaded_at")),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return f"PaymentFile({self.filename})"


# ---------------------------------------------------------------------------
# Sample pricing — org-scoped configuration that drives the bundled
# deposit+samples invoice generated on the customer's sample-selection
# confirm. See ``apps.organizations.modules.SamplePricingCapability`` for
# the read/edit gate + ``apps.payments.services`` for the price compute.
# ---------------------------------------------------------------------------


class SamplePricingConfig(models.Model):
    """One row per organization — the pricing knobs finance owns for
    the customer's post-proposal sample-selection stage.

    The customer signs a proposal, then picks how many trial samples
    they want. The first ``free_samples_included`` are bundled with
    the deposit; anything above that is priced at
    ``price_per_extra_sample`` and (optionally) discounted via one of
    the :class:`SamplePricingDiscountTier` rows attached to this
    config. The resulting extras-subtotal is added to the deposit
    amount and a single bundled ``Payment(kind=DEPOSIT)`` row is
    generated for the customer to pay — one line item on the finance
    queue, not two.

    Lazily created — the first time a portal surface asks for a
    given org's sample pricing, we create defaults (2 free, £250
    per extra, no discount tiers) so finance never has to explicitly
    "set up" the module to unblock a customer.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    organization = models.OneToOneField(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="sample_pricing_config",
    )

    #: How many trial samples the deposit ALWAYS covers. Below this
    #: threshold the customer sees "£0 extra". Above it, each
    #: additional sample multiplies against
    #: ``price_per_extra_sample`` before any discount tier applies.
    #: Default 2 matches the historical Vita norm; every org edits.
    free_samples_included = models.PositiveIntegerField(
        _("free samples included"), default=2,
    )

    #: Per-unit price for anything beyond the free allowance, in the
    #: org's chosen currency. Applied per extra sample BEFORE the
    #: discount tier. e.g. free=2, price=250, tier at qty=10 is 15% →
    #: 10 samples = 8 extras × £250 = £2,000 × (1 - 0.15) = £1,700.
    price_per_extra_sample = models.DecimalField(
        _("price per extra sample"),
        max_digits=12,
        decimal_places=2,
        default=0,
    )

    #: 3-char ISO 4217. Defaults blank so the FE / service falls back
    #: to ``organization.company.currency_code`` (per the codebase's
    #: monetary-field rule — the settings page reads the company's
    #: currency, never hardcoded).
    currency_code = models.CharField(
        _("currency code"), max_length=3, blank=True, default="",
    )

    #: One-off fee charged when the customer picks ``design_by_us`` on
    #: the label workflow. Approval of the resulting
    #: ``Payment(kind=LABEL_DESIGN)`` unlocks the design brief step.
    #: 0 or unset skips the fee gate entirely — the customer's choice
    #: goes straight to ``DESIGN_PREFERENCES_PENDING``. Currency
    #: shares ``currency_code`` above so finance only manages one
    #: currency knob for the module.
    label_design_fee_amount = models.DecimalField(
        _("label-design fee"),
        max_digits=12,
        decimal_places=2,
        default=0,
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )

    class Meta:
        verbose_name = _("sample pricing config")
        verbose_name_plural = _("sample pricing configs")

    def __str__(self) -> str:  # pragma: no cover
        return f"SamplePricingConfig({self.organization_id})"


class SamplePricingDiscountTier(models.Model):
    """Editable list of "buy N samples, get X% off" rows attached to a
    :class:`SamplePricingConfig`. Discount is applied at the end to the
    extras subtotal (``extras_count × price_per_extra_sample``) — NOT
    per-sample and NOT to the deposit portion of the bundled invoice.

    Tier selection: highest ``quantity_threshold`` whose value is ``≤
    ordered_quantity`` wins. e.g. tiers ``[5→5%, 10→15%]``:
      * 5 samples → 5% tier
      * 8 samples → 5% tier
      * 10 samples → 15% tier
      * 25 samples → 15% tier (no larger tier defined)

    Tiers are org-scoped via the parent config's FK. Adding or
    removing rows is idempotent — the settings surface performs a
    wholesale replace of the tier list on save, mirroring the
    stage-templates pattern.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    config = models.ForeignKey(
        SamplePricingConfig,
        on_delete=models.CASCADE,
        related_name="discount_tiers",
    )

    #: Order-size at which the discount kicks in. Uniqueness enforced
    #: at the ORM layer so finance can't fat-finger two rows for the
    #: same threshold (would create ambiguity on tier resolution).
    quantity_threshold = models.PositiveIntegerField(
        _("quantity threshold"),
    )

    #: 0.00 .. 100.00. Stored to 2 decimal places — sub-percent tiers
    #: aren't a real business need and would just muddle the settings
    #: UI. Validated at serializer level (BE) + input constraint (FE).
    discount_percent = models.DecimalField(
        _("discount percent"),
        max_digits=5,
        decimal_places=2,
        default=0,
    )

    #: Display order in the settings UI. Not used by the compute path
    #: (which sorts by ``quantity_threshold`` regardless) — kept as a
    #: separate field so admin re-ordering doesn't shift the
    #: threshold semantics.
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("sample pricing discount tier")
        verbose_name_plural = _("sample pricing discount tiers")
        ordering = ("sort_order", "quantity_threshold")
        constraints = [
            models.UniqueConstraint(
                fields=("config", "quantity_threshold"),
                name="uniq_sample_pricing_tier_threshold",
            ),
        ]

    def __str__(self) -> str:  # pragma: no cover
        return (
            f"SamplePricingDiscountTier(qty>={self.quantity_threshold} "
            f"→ {self.discount_percent}%)"
        )


class SampleAllocationStatus(models.TextChoices):
    """State machine for :class:`SampleAllocation`.

    * ``DRAFT`` — the customer opened the picker but hasn't
      confirmed a quantity yet. Not paid, not billed, no
      downstream side-effect. Overwritten freely as the customer
      changes their mind.
    * ``CONFIRMED`` — the customer clicked Confirm; the
      allocation is locked. In PR #3 this will auto-generate the
      bundled deposit+samples Payment and gate the trial-batch
      scheduler; in this PR (#2) it's the terminal state — the
      pipeline chip flips to done and the customer can proceed.
    """

    DRAFT = "draft", _("Draft")
    CONFIRMED = "confirmed", _("Confirmed")


class SampleAllocation(models.Model):
    """The customer's post-proposal choice of "how many trial samples
    do I want" for a project.

    One row per formulation (OneToOne). Snapshots the computed price
    breakdown at confirm-time — ``quantity_ordered``,
    ``extras_count``, ``unit_price``, ``discount_percent``,
    ``total_extras_cost`` — so a mid-project change to the org's
    :class:`SamplePricingConfig` never retroactively re-prices a
    customer who already committed. Snapshotting matches how
    :class:`Payment.currency` + ``proposal.deposit_percent`` are
    treated on their respective rows.

    Confirmed rows drive:

      * PR #3 — bundled deposit+samples Payment auto-generation
        (deposit_amount + this row's ``total_extras_cost`` = the
        single line the finance team sees on their queue).
      * PR #3 — trial-batch scheduler picks the ordered_quantity
        instead of the pricing config's ``free_samples_included``
        default.

    The FSM in :class:`SampleAllocationStatus` intentionally keeps
    ``DRAFT`` as a legit terminal state — the customer can open the
    picker, poke around, close the tab, and come back later without
    any side-effect on Finance / Ops.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    formulation = models.OneToOneField(
        "formulations.Formulation",
        on_delete=models.CASCADE,
        related_name="sample_allocation",
    )
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.PROTECT,
        related_name="+",
    )

    status = models.CharField(
        _("status"),
        max_length=16,
        choices=SampleAllocationStatus.choices,
        default=SampleAllocationStatus.DRAFT,
    )

    #: The customer's chosen order size, including free samples.
    quantity_ordered = models.PositiveIntegerField(
        _("quantity ordered"), default=0,
    )

    # ---- Snapshotted breakdown (only meaningful once confirmed) ----
    #
    # These mirror the return of
    # :func:`apps.payments.services.compute_sample_extras_cost`
    # AT CONFIRM TIME so a subsequent settings-page edit never
    # retroactively re-prices a locked allocation. FE / finance
    # invoicing reads STRICTLY from here after confirmation.

    free_samples_included_snapshot = models.PositiveIntegerField(
        _("free samples included (snapshot)"), default=0,
    )
    extras_count = models.PositiveIntegerField(
        _("extras count"), default=0,
    )
    unit_price = models.DecimalField(
        _("unit price"),
        max_digits=12,
        decimal_places=2,
        default=0,
    )
    subtotal = models.DecimalField(
        _("subtotal"),
        max_digits=12,
        decimal_places=2,
        default=0,
    )
    discount_percent = models.DecimalField(
        _("discount percent"),
        max_digits=5,
        decimal_places=2,
        default=0,
    )
    discount_amount = models.DecimalField(
        _("discount amount"),
        max_digits=12,
        decimal_places=2,
        default=0,
    )
    total_extras_cost = models.DecimalField(
        _("total extras cost"),
        max_digits=12,
        decimal_places=2,
        default=0,
    )
    currency_code = models.CharField(
        _("currency code"), max_length=3, blank=True, default="",
    )
    tier_threshold = models.PositiveIntegerField(
        _("winning tier threshold"), null=True, blank=True,
    )

    confirmed_at = models.DateTimeField(null=True, blank=True)
    confirmed_by = models.ForeignKey(
        "client_portal.ClientAccount",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    #: The bundled deposit+samples ``Payment`` this allocation
    #: auto-generated on confirm. Nullable because (a) legacy rows
    #: pre-dating the auto-gen exist, (b) the generator no-ops when
    #: no proposal or no deposit_percent applies. ``SET_NULL`` on
    #: delete so voiding the Payment (e.g. finance sends the
    #: customer a corrected invoice) doesn't cascade-nuke the
    #: allocation row that records the customer's choice.
    deposit_payment = models.ForeignKey(
        "payments.Payment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="sample_allocation_source",
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("sample allocation")
        verbose_name_plural = _("sample allocations")

    def __str__(self) -> str:  # pragma: no cover
        return (
            f"SampleAllocation(formulation={self.formulation_id}, "
            f"qty={self.quantity_ordered}, status={self.status})"
        )
