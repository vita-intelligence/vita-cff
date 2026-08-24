"""Models for the trial-batches app.

A :class:`TrialBatch` is the scientist's scale-up worksheet: they take
a saved :class:`~apps.formulations.models.FormulationVersion` snapshot
and multiply every active, excipient and shell weight by the number of
finished units they plan to manufacture. Procurement then reads the
resulting kg-per-batch BOM straight into MRPeasy (or whichever ERP the
org uses) instead of the scientist copy-pasting cells out of the
``BOM Actives Calculation`` sheet in Excel.

Like :class:`~apps.specifications.models.SpecificationSheet`, the batch
pins against a *version* rather than the mutable formulation. Catalogue
edits or line tweaks made after the batch was planned must not silently
rewrite a procurement document that may have already left the building.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class BatchKind(models.TextChoices):
    """Two flavours of R&D manufacturing run — chosen once at
    creation, drives everything downstream.

    ``TRIAL`` is a **bench-scale test**: the entered ``batch_size_units``
    is the raw count of finished individual capsules / tablets /
    scoops the scientist wants to produce (typically 10-50 to prove
    the recipe blends, encapsulates, tastes right, etc). No pack
    multiplier. On PSP the linked MO gets ``project_type = "trial"``,
    which bypasses Final Release and short-circuits the R&D chain
    back to the R&D warehouse after Output QC passes.

    ``SAMPLE`` is a **customer-sample production run**: the entered
    ``batch_size_units`` is a number of finished packs and the BOM
    scales by the formulation's ``servings_per_pack`` snapshot
    ("plan 1 000 bottles of 60 capsules"). On PSP the linked MO
    gets ``project_type = "sample"``, which follows the full
    commercial release path — put-away to quarantine, Final Release
    signed off, then available for dispatch. Same procedure a real
    order would follow so ops can practice the flow end-to-end.
    """

    TRIAL = "trial", _("Trial")
    SAMPLE = "sample", _("Sample")


class TrialBatch(models.Model):
    """A planned manufacturing run against a frozen formulation version."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="trial_batches",
    )
    formulation_version = models.ForeignKey(
        "formulations.FormulationVersion",
        on_delete=models.PROTECT,
        related_name="trial_batches",
        help_text=_(
            "Immutable snapshot the batch scales against. Editing the "
            "underlying formulation never rewrites this batch's BOM."
        ),
    )

    label = models.CharField(
        _("label"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Optional human-readable name — e.g. "
            "``Pilot run 2026-04-17`` or ``First production lot``."
        ),
    )
    batch_size_units = models.PositiveIntegerField(
        _("batch size"),
        help_text=_(
            "Numeric input; interpretation depends on ``kind``. "
            "For ``sample`` this is the number of finished packs "
            "(bottles/pouches/tubs) and scales by servings_per_pack; "
            "for ``trial`` it is the raw count of individual "
            "capsules/tablets/scoops (no pack multiplier)."
        ),
    )
    kind = models.CharField(
        _("kind"),
        max_length=8,
        choices=BatchKind.choices,
        default=BatchKind.SAMPLE,
        help_text=_(
            "``trial`` = bench-scale test, raw unit count, PSP MO "
            "runs as project_type=trial (bypasses Final Release). "
            "``sample`` = customer-sample production, entered number "
            "× servings_per_pack, PSP MO runs as project_type=sample "
            "(follows the commercial release path)."
        ),
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    #: Optional packaging overlay for ``sample``-kind batches. Null
    #: everywhere else (``trial``-kind bench runs never have
    #: packaging). When set, the linked PSP MO's packaging BOM lines
    #: are replaced by this combo's items at MO-create time — the
    #: same mechanism the proposal → CO flow will use, so a sample MO
    #: rehearses the exact packaging cascade a real customer order
    #: would trigger. When null on a sample batch, the MO runs
    #: without any packaging (loose-bulk output).
    #:
    #: SET_NULL on delete so removing a formulation-level combo
    #: doesn't wipe the batch's audit trail — the row survives with
    #: a null pointer, and the PSP MO already has its own copy of
    #: the combo items baked in.
    packaging_combo = models.ForeignKey(
        "formulations.PackagingCombo",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="trial_batches",
        help_text=_(
            "Optional packaging overlay for sample batches. NULL = no "
            "combo picked (loose-bulk output or trial-kind bench run); "
            "populated = the PSP MO's packaging BOM lines are replaced "
            "by the combo's items at MO-create time."
        ),
    )

    #: The customer-sample Payment this batch is fulfilling, if any.
    #: Populated when a scientist creates the batch from the R&D
    #: Samples page (:module:`apps.trial_batches.api.samples_views`)
    #: so the fulfilment queue can filter it out — "which sample
    #: requests have I not yet turned into a batch?" is a
    #: ``Payment WHERE NOT EXISTS (…source_payment=payment.id)``
    #: query rather than fuzzy matching on customer + formulation.
    #:
    #: SET_NULL on payment delete so voiding / rewriting a Payment
    #: row doesn't cascade the batch away — the fulfilled work
    #: survives with a null pointer, and the audit trail already
    #: records who / when the batch was created.
    source_payment = models.ForeignKey(
        "payments.Payment",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="fulfilled_by_trial_batches",
        help_text=_(
            "Sample Payment this batch fulfils. NULL for batches "
            "started from the per-project trial-batches tab (no "
            "payment context); populated when the batch is created "
            "from the R&D Samples fulfilment queue."
        ),
    )

    #: PSP Manufacturing Order uuid this batch spawned. Nullable —
    #: blank until the scientist clicks "Create MO on PSP". Populated
    #: on that action + used as the idempotency handle for retry-safe
    #: creates (PSP's ``manufacturing_orders_npd_trial_batch_uuid``
    #: unique partial index enforces one MO per trial). We store the
    #: raw uuid rather than an FK because PSP lives in its own
    #: database — the uuid is the cross-system reference.
    psp_manufacturing_order_uuid = models.UUIDField(
        null=True,
        blank=True,
        help_text=_(
            "Cross-system handle for the PSP Manufacturing Order this "
            "trial batch spawned."
        ),
    )

    #: Cached "every stage MO in the linked chain has status =
    #: completed" flag. Kept locally so the QC-tab wizard gate on the
    #: project overview doesn't have to make an HTTP hop to PSP on
    #: every render. Refreshed:
    #:
    #: * whenever the trial-batch detail page fetches the MO chain
    #:   (the panel polls at 20s), or
    #: * by the overview endpoint itself when it notices a linked
    #:   batch is still ``False`` — silent-degrade on any PSP error.
    #:
    #: Once ``True`` the shop floor has finished producing the batch
    #: and QC / validation is fair game. Default ``False`` because a
    #: brand-new batch (with or without a linked MO) has never been
    #: manufactured.
    psp_all_stages_completed = models.BooleanField(
        default=False,
        help_text=_(
            "Cached: every stage MO in the PSP chain has "
            "``status = completed``. Drives the QC tab gate."
        ),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_trial_batches",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_trial_batches",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("trial batch")
        verbose_name_plural = _("trial batches")
        ordering = ("-updated_at",)
        indexes = [
            models.Index(fields=("organization", "-updated_at")),
            models.Index(fields=("formulation_version", "-created_at")),
        ]

    def __str__(self) -> str:
        return self.label or str(self.id)


# ---------------------------------------------------------------------------
# Trial-batch cycle — sequential sample production against a signed
# proposal.
#
# A cycle wraps N slots (one per sample the customer paid for in the
# post-proposal ``SampleAllocation``). Slots are worked STRICTLY
# sequentially: slot N+1 does not become creatable until slot N has
# been delivered AND the customer has recorded a verdict on it.
#
# Each slot walks its own :class:`TrialBatch` → PSP sample MO →
# shipment → delivery loop, so a cycle with three slots produces
# three separate sample-kind PSP customer-orders + MOs over time.
# When the customer marks a slot ``needs_iteration`` the scientist
# tweaks the recipe, generates a new ``FormulationVersion``, and the
# next slot uses that snapshot instead of the previous one — the
# same primitive the current per-batch flow already relies on.
# ---------------------------------------------------------------------------


class TrialBatchCycleStatus(models.TextChoices):
    """State machine for :class:`TrialBatchCycle`.

    * ``IN_PROGRESS`` — at least one slot is still open (either
      awaiting the scientist or in production / awaiting feedback).
    * ``SATISFIED`` — the customer marked a slot ``satisfied``.
      Final-spec-sign unlocks. May coexist with remaining slots that
      the customer opted to keep receiving (see
      ``keep_producing_remaining`` on the satisfying slot).
    * ``TERMINATED_BY_TEAM`` — an internal user closed the cycle
      early (customer is happy via out-of-band contact, or the deal
      was mutually cancelled). Same downstream effect as
      ``SATISFIED`` but attributed to a staff member.
    * ``MAX_REACHED`` — all slots consumed and none were flagged as
      satisfied. The cycle is closed pending a decision — the customer
      can request additional samples (which resurrects the cycle back
      into ``IN_PROGRESS``) or the team can close by override.
    """

    IN_PROGRESS = "in_progress", _("In progress")
    SATISFIED = "satisfied", _("Satisfied")
    TERMINATED_BY_TEAM = "terminated_by_team", _("Terminated by team")
    MAX_REACHED = "max_reached", _("Max reached")


class TrialBatchSlotStatus(models.TextChoices):
    """State machine for :class:`TrialBatchSlot`.

    Progresses left-to-right; only the ``CLOSED_*`` states are
    terminal.

    * ``AWAITING_SCIENTIST`` — the slot is open for the scientist to
      spin up a :class:`TrialBatch` and push a PSP Manufacturing
      Order for it. Covers BOTH the "no batch yet" and the "batch
      drafted on NPD but no PSP MO yet" cases — until a physical MO
      exists nothing is being produced, so the portal card + count
      logic both treat these as unstarted.
    * ``IN_PRODUCTION`` — a PSP MO has been created against the
      linked batch; the PSP-side manufacturing state machine is
      running. Set by
      :func:`apps.trial_batches.cycle_services.promote_slot_to_in_production`
      from the successful PSP-MO-create hook — never at
      batch-link time.
    * ``SHIPPED`` — reserved for future use — once the PSP shipment
      is picked up. Today we jump straight from ``IN_PRODUCTION`` to
      ``DELIVERED`` on the portal confirm-delivery hook.
    * ``DELIVERED`` — the customer / operator confirmed receipt.
      Feedback capture opens on the portal card.
    * ``FEEDBACK_PENDING`` — synonym for ``DELIVERED`` in the current
      wire; kept as a distinct state so we can visually differentiate
      "arrived" from "arrived, waiting on your feedback" on the FE
      without a code change.
    * ``CLOSED_ITERATED`` — customer flagged the slot as needing
      changes. Scientist tweaks recipe → generates a new
      ``FormulationVersion`` → opens the next slot against that
      version.
    * ``CLOSED_SATISFIED`` — customer flagged the slot as satisfying
      the brief. Cycle transitions to ``SATISFIED``.
    * ``CLOSED_CANCELLED`` — the slot was auto-cancelled because the
      customer flagged an earlier slot as satisfied and did NOT opt
      into the "still send the remaining samples I paid for" branch.
    """

    AWAITING_SCIENTIST = "awaiting_scientist", _("Awaiting scientist")
    IN_PRODUCTION = "in_production", _("In production")
    SHIPPED = "shipped", _("Shipped")
    DELIVERED = "delivered", _("Delivered")
    FEEDBACK_PENDING = "feedback_pending", _("Feedback pending")
    CLOSED_ITERATED = "closed_iterated", _("Closed — iterating")
    CLOSED_SATISFIED = "closed_satisfied", _("Closed — satisfied")
    CLOSED_CANCELLED = "closed_cancelled", _("Closed — cancelled")


class TrialBatchSlotVerdict(models.TextChoices):
    """Customer's verdict on a delivered slot, recorded via the
    portal feedback card.

    * ``NEEDS_ITERATION`` — recipe isn't right yet. Scientist takes
      the feedback into account, tweaks the formulation, opens the
      next slot against a new ``FormulationVersion``.
    * ``SATISFIED`` — recipe is on-brief. Cycle transitions to
      ``SATISFIED`` and final-spec-sign unlocks. Combined with
      ``TrialBatchSlot.keep_producing_remaining`` = True the
      remaining paid slots continue in production against the same
      formulation-version snapshot; False cancels them.
    """

    NEEDS_ITERATION = "needs_iteration", _("Needs iteration")
    SATISFIED = "satisfied", _("Satisfied")


class TrialBatchCycle(models.Model):
    """One cycle per custom-formulation project. Created when the
    bundled deposit+samples Payment is approved by finance. Owns the
    sequential production of N :class:`TrialBatchSlot` rows against
    the customer's post-proposal :class:`SampleAllocation` pick.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="trial_batch_cycles",
    )
    formulation = models.OneToOneField(
        "formulations.Formulation",
        on_delete=models.CASCADE,
        related_name="trial_batch_cycle",
        help_text=_(
            "The custom-formulation project this cycle is producing "
            "samples against. OneToOne because a formulation only "
            "ever has one active trial-batch cycle at a time — "
            "additional samples extend the same cycle rather than "
            "starting a fresh one."
        ),
    )
    sample_allocation = models.ForeignKey(
        "payments.SampleAllocation",
        on_delete=models.PROTECT,
        related_name="trial_batch_cycles",
        help_text=_(
            "The customer's post-proposal sample-count pick. Seed for "
            "``total_slots`` at creation time."
        ),
    )
    seed_payment = models.ForeignKey(
        "payments.Payment",
        on_delete=models.PROTECT,
        related_name="seeded_trial_batch_cycles",
        help_text=_(
            "The bundled deposit+samples Payment whose approval "
            "spawned this cycle."
        ),
    )

    status = models.CharField(
        _("status"),
        max_length=32,
        choices=TrialBatchCycleStatus.choices,
        default=TrialBatchCycleStatus.IN_PROGRESS,
    )

    #: Total slots the cycle is producing across its lifetime. Starts
    #: at ``sample_allocation.quantity_ordered``, bumped by finance-
    #: approved :class:`AdditionalSampleRequest` rows.
    total_slots = models.PositiveIntegerField(_("total slots"), default=0)

    #: Optional attribution when the cycle closes via team override
    #: rather than customer verdict. Populated together with
    #: ``status = TERMINATED_BY_TEAM``.
    terminated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="+",
        null=True,
        blank=True,
    )
    terminated_reason = models.TextField(
        _("termination reason"), blank=True, default=""
    )
    closed_at = models.DateTimeField(_("closed at"), null=True, blank=True)

    #: Set when the customer explicitly answers "no more samples" at
    #: the terminal-choice prompt. Distinct from ``closed_at`` because
    #: a cycle can be at a terminal status (satisfied / max_reached /
    #: terminated_by_team) while still awaiting the customer's
    #: explicit "we're done" decision — the final-spec stage only
    #: unlocks once this is populated. Also the gate that prevents
    #: the cycle from advancing while a top-up request is still
    #: awaiting finance approval.
    customer_confirmed_done_at = models.DateTimeField(
        _("customer confirmed done at"), null=True, blank=True,
    )

    #: Portal-display offset for slot counts. Bumped to the current
    #: slot count whenever a top-up request is approved AFTER the
    #: team closed the cycle (``TERMINATED_BY_TEAM``) — the customer
    #: should see the newly-ordered samples counted from zero, not
    #: appended to the pre-close history. Slots with
    #: ``sequence_no <= offset`` are hidden from the portal ladder
    #: and excluded from the ``total_slots`` / ``slots_used``
    #: display; internal scientist views ignore the offset and
    #: continue to see the full slot history.
    slots_display_offset = models.PositiveIntegerField(
        _("slots display offset"), default=0,
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("trial-batch cycle")
        verbose_name_plural = _("trial-batch cycles")
        ordering = ("-updated_at",)
        indexes = [
            models.Index(fields=("organization", "-updated_at")),
            models.Index(fields=("status",)),
        ]

    def __str__(self) -> str:
        return f"Cycle for {self.formulation_id} ({self.status})"


class TrialBatchSlot(models.Model):
    """One sample slot within a :class:`TrialBatchCycle`. Slots are
    worked sequentially by ``sequence_no`` — slot N+1 doesn't become
    ``AWAITING_SCIENTIST`` until slot N reaches a terminal
    ``CLOSED_*`` state.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    cycle = models.ForeignKey(
        TrialBatchCycle,
        on_delete=models.CASCADE,
        related_name="slots",
    )
    sequence_no = models.PositiveIntegerField(_("sequence number"))

    #: The formulation-version snapshot this slot's :class:`TrialBatch`
    #: will be produced against. Seeded from whichever draft spec was
    #: customer-signed at cycle-creation for slot 1; scientist picks
    #: (usually a freshly-tweaked version) for slots 2..N.
    formulation_version = models.ForeignKey(
        "formulations.FormulationVersion",
        on_delete=models.PROTECT,
        related_name="+",
    )

    status = models.CharField(
        _("status"),
        max_length=32,
        choices=TrialBatchSlotStatus.choices,
        default=TrialBatchSlotStatus.AWAITING_SCIENTIST,
    )

    #: The scientist-created :class:`TrialBatch` this slot is fulfilling
    #: (populated when the scientist opens the batch from the "trial
    #: batches in flight" dashboard module). Null while the slot is
    #: still ``AWAITING_SCIENTIST``.
    trial_batch = models.OneToOneField(
        TrialBatch,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="cycle_slot",
    )

    #: Customer's verdict from the portal feedback card. Populated
    #: together with ``verdict_at`` when the slot transitions to
    #: ``CLOSED_*``.
    verdict = models.CharField(
        _("verdict"),
        max_length=32,
        choices=TrialBatchSlotVerdict.choices,
        null=True,
        blank=True,
    )
    verdict_at = models.DateTimeField(_("verdict at"), null=True, blank=True)

    #: Only meaningful when ``verdict = SATISFIED``. True = customer
    #: chose "I'm happy, but still send me the remaining samples I
    #: paid for". False (default) = cancel the remaining slots.
    keep_producing_remaining = models.BooleanField(
        _("keep producing remaining slots"), default=False,
    )

    #: Denormalised copy of the customer's free-text feedback for
    #: convenient scientist inbox rendering. The authoritative
    #: threaded conversation lives on the polymorphic Comment module
    #: pointed at this slot.
    feedback_summary = models.TextField(
        _("feedback summary"), blank=True, default=""
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("trial-batch slot")
        verbose_name_plural = _("trial-batch slots")
        ordering = ("cycle", "sequence_no")
        constraints = [
            models.UniqueConstraint(
                fields=("cycle", "sequence_no"),
                name="trial_batch_slot_unique_per_cycle",
            ),
        ]
        indexes = [
            models.Index(fields=("cycle", "status")),
        ]

    def __str__(self) -> str:
        return f"Slot {self.sequence_no} of {self.cycle_id} ({self.status})"


class AdditionalSampleRequestStatus(models.TextChoices):
    AWAITING_FINANCE = "awaiting_finance", _("Awaiting finance approval")
    APPROVED = "approved", _("Approved")
    REJECTED = "rejected", _("Rejected")


class AdditionalSampleRequest(models.Model):
    """Customer-initiated request to top up an active cycle with more
    samples. Fires when the customer clicks "Request another sample"
    from the portal card. Creates a pending :class:`Payment` on the
    finance queue (kind=``ADDITIONAL_SAMPLES``); on approval the
    cycle's ``total_slots`` is bumped and new
    :class:`TrialBatchSlot` rows appended.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    cycle = models.ForeignKey(
        TrialBatchCycle,
        on_delete=models.CASCADE,
        related_name="additional_sample_requests",
    )
    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="+",
    )

    requested_quantity = models.PositiveIntegerField(_("requested quantity"))

    #: Unit-price snapshot at request time — matches the currently-
    #: configured :class:`SamplePricingConfig` unit-price. Snapshotting
    #: matches how the initial sample allocation freezes its own
    #: breakdown.
    unit_price_snapshot = models.DecimalField(
        _("unit price snapshot"), max_digits=12, decimal_places=4,
    )
    currency_code = models.CharField(
        _("currency code"), max_length=3, default="GBP",
    )
    total_amount_snapshot = models.DecimalField(
        _("total amount snapshot"), max_digits=14, decimal_places=2,
    )

    #: The finance-facing Payment row this request generated. Nullable
    #: only for the brief window between request-create and
    #: payment-create; population is transactional in the service.
    payment = models.OneToOneField(
        "payments.Payment",
        on_delete=models.PROTECT,
        related_name="additional_sample_request",
        null=True,
        blank=True,
    )

    status = models.CharField(
        _("status"),
        max_length=32,
        choices=AdditionalSampleRequestStatus.choices,
        default=AdditionalSampleRequestStatus.AWAITING_FINANCE,
    )

    #: Portal actor who initiated the request (client-account, not
    #: an internal user). Nullable for defence-in-depth; populated in
    #: normal flow via ``request.user`` on the portal endpoint.
    requested_by = models.ForeignKey(
        "client_portal.ClientAccount",
        on_delete=models.PROTECT,
        related_name="+",
        null=True,
        blank=True,
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)
    approved_at = models.DateTimeField(_("approved at"), null=True, blank=True)

    class Meta:
        verbose_name = _("additional-sample request")
        verbose_name_plural = _("additional-sample requests")
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("cycle", "status")),
        ]

    def __str__(self) -> str:
        return f"AddlReq {self.requested_quantity} on {self.cycle_id}"
