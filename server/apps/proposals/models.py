"""Domain models for the proposals app.

A :class:`Proposal` is the commercial counterpart to the spec sheet:
a price + terms document the client signs alongside the technical
specification. Where the spec sheet says *what we are making*, the
proposal says *what it costs*. The two are co-signed on the same
kiosk page — a scientist never wants a customer to accept the
specification without also agreeing to the price, and vice versa.

The proposal snapshots against a frozen :class:`FormulationVersion`
for the same reason the spec sheet does: catalogue or price edits
made after the document is sent must not silently rewrite what the
client has already seen. Scientist regenerates when they want the
latest data.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class ProposalStatus(models.TextChoices):
    """Lifecycle of one commercial offer.

    Mirrors :class:`SpecificationStatus` one-for-one so the two
    documents progress in lock-step when they're bundled on the
    kiosk. ``accepted`` is terminal for the customer; ``rejected``
    kills the proposal without signing.
    """

    DRAFT = "draft", _("Draft")
    IN_REVIEW = "in_review", _("In review")
    APPROVED = "approved", _("Approved")
    SENT = "sent", _("Sent")
    ACCEPTED = "accepted", _("Accepted")
    REJECTED = "rejected", _("Rejected")


class ProposalTemplateType(models.TextChoices):
    """Which .docx template the proposal renders against.

    Snapshotted from :attr:`Formulation.project_type` at creation
    time so later changes to the project type don't rewrite sent
    proposals. The two templates differ in lead times, the 30%
    deposit clause, and whether the development phase is mentioned.
    """

    CUSTOM = "custom", _("Custom")
    READY_TO_GO = "ready_to_go", _("Ready to Go")


class Proposal(models.Model):
    """A commercial offer pinned to a frozen formulation version."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="proposals",
    )
    formulation_version = models.ForeignKey(
        "formulations.FormulationVersion",
        on_delete=models.PROTECT,
        related_name="proposals",
        help_text=_(
            "Immutable snapshot the proposal pins against. Editing "
            "the underlying formulation never rewrites a sent proposal."
        ),
    )
    specification_sheet = models.OneToOneField(
        "specifications.SpecificationSheet",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="proposal",
        help_text=_(
            "Optional link to the spec sheet this proposal accompanies. "
            "When set, the kiosk page renders both documents together "
            "and the customer's single accept-and-sign action marks "
            "both ``ACCEPTED`` at the same time."
        ),
    )
    customer = models.ForeignKey(
        "customers.Customer",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="proposals",
        help_text=_(
            "Optional link to the org's customer record so the same "
            "client is searchable across proposals. When set, the "
            "proposal's ``customer_*`` fields are seeded from the "
            "customer's address-book entry on create; scientists can "
            "still override any field per-proposal without losing the "
            "link."
        ),
    )

    code = models.CharField(
        _("code"),
        max_length=64,
        blank=True,
        help_text=_("Proposal reference code (e.g. ``PROP-0001``)."),
    )
    template_type = models.CharField(
        _("template type"),
        max_length=16,
        choices=ProposalTemplateType.choices,
        default=ProposalTemplateType.CUSTOM,
    )
    status = models.CharField(
        _("status"),
        max_length=16,
        choices=ProposalStatus.choices,
        default=ProposalStatus.DRAFT,
    )

    # ------------------------------------------------------------------
    # Customer details. Kept on the proposal rather than joined from the
    # spec sheet so a proposal can exist standalone (e.g. a re-order of
    # an already-signed formulation) without needing a matching sheet.
    # ------------------------------------------------------------------
    customer_name = models.CharField(
        _("customer name"), max_length=200, blank=True, default=""
    )
    customer_email = models.EmailField(
        _("customer email"), blank=True, default=""
    )
    customer_phone = models.CharField(
        _("customer phone"), max_length=60, blank=True, default=""
    )
    customer_company = models.CharField(
        _("customer company"), max_length=200, blank=True, default=""
    )
    invoice_address = models.TextField(
        _("invoice address"), blank=True, default=""
    )
    delivery_address = models.TextField(
        _("delivery address"), blank=True, default=""
    )
    dear_name = models.CharField(
        _("dear name"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Appears on the ``Dear <name>,`` greeting. Defaults to the "
            "customer name; scientists can override for formal "
            "salutations."
        ),
    )
    reference = models.CharField(
        _("reference"),
        max_length=120,
        blank=True,
        default="",
        help_text=_(
            "Free-text reference printed on the ``Ref:`` line of the "
            "proposal. Typically an internal quote id or the client's "
            "PO number."
        ),
    )
    sales_person = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="proposals_as_sales_person",
        help_text=_(
            "Optional per-proposal override of the sales person whose "
            "name closes out the ``Yours sincerely,`` block. Falls back "
            "to the linked project's ``sales_person`` when unset so "
            "single-project proposals keep the project's owner by "
            "default. Multi-project proposals need the override because "
            "different lines may belong to projects with different "
            "assigned owners."
        ),
    )

    # ------------------------------------------------------------------
    # Commercial terms. Single product line per proposal for now
    # (matches the workbook's one-row pricing table). quantity is the
    # number of finished packs the client is ordering; unit_price is
    # the per-pack price. freight + total are auto-computed and kept
    # in the snapshot so historical proposals can re-render without
    # recomputing prices.
    # ------------------------------------------------------------------
    currency = models.CharField(
        _("currency"),
        max_length=3,
        default="GBP",
        help_text=_("ISO 4217 code. Proposals only support one currency per document."),
    )
    quantity = models.PositiveIntegerField(
        _("quantity"),
        default=1,
        help_text=_(
            "Number of finished packs (bottles/pouches/tubs) the "
            "client is ordering."
        ),
    )
    unit_price = models.DecimalField(
        _("unit price"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    freight_amount = models.DecimalField(
        _("freight amount"),
        max_digits=12,
        decimal_places=2,
        null=True,
        blank=True,
        help_text=_(
            "Freight charge (Ready to Go only — Custom quotes bundle "
            "it into the unit price). Blank leaves the freight row off "
            "the rendered proposal."
        ),
    )
    material_cost_per_pack = models.DecimalField(
        _("material cost per pack"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "Computed from raw-material ``cost_price_per_kg`` × "
            "mg-per-pack at creation. Informational — the unit price "
            "the client pays is edited separately."
        ),
    )
    margin_percent = models.DecimalField(
        _("margin %"),
        max_digits=6,
        decimal_places=2,
        null=True,
        blank=True,
        help_text=_(
            "Target margin the scientist picked when creating the "
            "proposal. Drives the auto-suggested unit price."
        ),
    )

    cover_notes = models.TextField(
        _("cover notes"), blank=True, default=""
    )
    valid_until = models.DateField(
        _("valid until"),
        null=True,
        blank=True,
        help_text=_(
            "Offer validity date. The workbook template defaults to "
            "14 days from issue — pre-filled on create but editable."
        ),
    )

    # ------------------------------------------------------------------
    # Signatures — three distinct role slots, mirroring the spec sheet
    # so the co-signing kiosk flow stays symmetric.
    # ------------------------------------------------------------------
    prepared_by_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="prepared_proposals",
    )
    prepared_by_signed_at = models.DateTimeField(
        _("prepared-by signed at"), null=True, blank=True
    )
    prepared_by_signature_image = models.TextField(
        _("prepared-by signature image"), blank=True, default=""
    )
    director_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="approved_proposals",
    )
    director_signed_at = models.DateTimeField(
        _("director signed at"), null=True, blank=True
    )
    director_signature_image = models.TextField(
        _("director signature image"), blank=True, default=""
    )
    customer_signer_name = models.CharField(
        _("customer signer name"), max_length=200, blank=True, default=""
    )
    customer_signer_email = models.EmailField(
        _("customer signer email"), blank=True, default=""
    )
    customer_signer_company = models.CharField(
        _("customer signer company"), max_length=200, blank=True, default=""
    )
    customer_signed_at = models.DateTimeField(
        _("customer signed at"), null=True, blank=True
    )
    customer_signature_image = models.TextField(
        _("customer signature image"), blank=True, default=""
    )

    public_token = models.UUIDField(
        _("public token"),
        null=True,
        blank=True,
        unique=True,
        db_index=True,
        default=None,
        help_text=_(
            "Opaque UUID that grants unauthenticated read-only access "
            "to this proposal via the public kiosk URL. When set, the "
            "proposal-centric kiosk at ``/p/proposal/<token>`` renders "
            "the proposal alongside every attached specification "
            "sheet (via ``ProposalLine.specification_sheet``) with a "
            "dedicated signature pad per document. The legacy spec-"
            "only kiosk at ``/p/<spec_token>`` stays live for sheets "
            "shared on their own."
        ),
    )

    # PDF render cache — rendering via docx2pdf / LibreOffice drives
    # an external application and takes several seconds per call.
    # Storing the rendered bytes + the digest the generator was run
    # against lets every subsequent request serve instantly until the
    # proposal changes. The digest is a cheap string (updated_at +
    # sum of lines' updated_at) so a single SQL lookup decides
    # whether the cache is stale.
    rendered_pdf = models.BinaryField(
        _("rendered pdf"),
        null=True,
        blank=True,
        editable=False,
        help_text=_(
            "Cached PDF bytes of the most recent render. Invalidated "
            "whenever ``rendered_pdf_digest`` no longer matches the "
            "current proposal state."
        ),
    )
    rendered_pdf_digest = models.CharField(
        _("rendered pdf digest"),
        max_length=200,
        blank=True,
        default="",
        editable=False,
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_proposals",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_proposals",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("proposal")
        verbose_name_plural = _("proposals")
        ordering = ("-updated_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "code"),
                condition=~models.Q(code=""),
                name="proposals_unique_code_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=("organization", "status")),
            models.Index(fields=("organization", "-updated_at")),
        ]

    def __str__(self) -> str:
        return self.code or str(self.id)

    @property
    def subtotal(self):
        """``unit_price × quantity`` — returns ``None`` when either
        value is missing so the caller can render ``TBC``."""

        if self.unit_price is None or self.quantity is None:
            return None
        return self.unit_price * self.quantity

    @property
    def total_excl_vat(self):
        """Subtotal plus freight (when set). VAT is left to the
        invoice stage — the workbook template is a pre-VAT quote."""

        sub = self.subtotal
        if sub is None:
            return None
        if self.freight_amount is None:
            return sub
        return sub + self.freight_amount


class ProposalLine(models.Model):
    """One product row on a proposal.

    A proposal is the commercial envelope (one customer, one letter,
    one set of signatures). The envelope can carry N products — a
    client ordering a burner capsule + an energy powder + a sleep
    gummy signs one proposal that quotes all three. Each line pins
    to a :class:`FormulationVersion` snapshot so later edits to the
    formulation do not silently rewrite the quote, and optionally
    to a :class:`SpecificationSheet` so the kiosk can bundle every
    product's technical spec behind the same signing flow.

    Snapshot fields (``product_code``, ``description``) are copied
    from the formulation at create time; they are the values that
    render into the proposal's pricing table and become frozen
    history once the proposal is signed.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    proposal = models.ForeignKey(
        Proposal,
        on_delete=models.CASCADE,
        related_name="lines",
    )
    formulation_version = models.ForeignKey(
        "formulations.FormulationVersion",
        on_delete=models.PROTECT,
        related_name="proposal_lines",
        null=True,
        blank=True,
        help_text=_(
            "Frozen formulation snapshot this line quotes. Nullable "
            "so a scientist can add a free-text ad-hoc line (e.g. "
            "'Shipping crate') that does not correspond to a project."
        ),
    )
    specification_sheet = models.ForeignKey(
        "specifications.SpecificationSheet",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="proposal_lines",
        help_text=_(
            "Optional link to the spec sheet for this line's product. "
            "When set, the kiosk renders the spec sheet inside the "
            "bundled signing flow. One proposal can bundle multiple "
            "spec sheets — one per line."
        ),
    )

    product_code = models.CharField(
        _("product code"),
        max_length=200,
        blank=True,
        default="",
    )
    description = models.CharField(
        _("description"),
        max_length=500,
        blank=True,
        default="",
    )
    quantity = models.PositiveIntegerField(_("quantity"), default=1)
    unit_cost = models.DecimalField(
        _("unit cost"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "What it costs Vita NPD to produce one pack of this line. "
            "Informational — the margin percentage is derived from "
            "this number and ``unit_price``."
        ),
    )
    unit_price = models.DecimalField(
        _("unit price"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    display_order = models.PositiveIntegerField(
        _("display order"),
        default=0,
        help_text=_(
            "Sort key the rendered proposal uses to order lines in "
            "the pricing table. Scientists drag to reorder; zeroes "
            "break ties by ``created_at``."
        ),
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("proposal line")
        verbose_name_plural = _("proposal lines")
        ordering = ("display_order", "created_at")
        indexes = [
            models.Index(fields=("proposal", "display_order")),
        ]

    def __str__(self) -> str:
        return f"{self.product_code or '—'} × {self.quantity}"

    @property
    def subtotal(self):
        """``unit_price × quantity`` — ``None`` when either is
        missing so the caller can render ``TBC`` instead of zero."""

        if self.unit_price is None or self.quantity is None:
            return None
        return self.unit_price * self.quantity


class ProposalStatusTransition(models.Model):
    """Audit row for every status change on a proposal.

    Mirrors :class:`SpecificationStatusTransition` so the bundled
    spec sheet + proposal flow emits matching history entries. The
    kiosk page reads this list to show the client the signing
    timeline.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    proposal = models.ForeignKey(
        Proposal,
        on_delete=models.CASCADE,
        related_name="transitions",
    )
    from_status = models.CharField(max_length=16)
    to_status = models.CharField(max_length=16)
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="proposal_transitions",
    )
    notes = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("proposal status transition")
        verbose_name_plural = _("proposal status transitions")
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("proposal", "-created_at")),
        ]

    def __str__(self) -> str:
        return f"{self.proposal_id}: {self.from_status} → {self.to_status}"
