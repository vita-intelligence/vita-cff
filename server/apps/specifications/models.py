"""Domain models for the specifications app.

A :class:`SpecificationSheet` is a client-facing deliverable wrapping
an immutable snapshot of a formulation (via ``formulation_version``)
plus the client-specific context: who it's for, the negotiated price,
any cover notes, and the approval state.

Freezing against a *version* rather than the mutable formulation is
deliberate — catalogue edits or line tweaks made after a sheet is
generated must never silently rewrite what the client has already
seen. The scientist regenerates the sheet against a newer version
when they want the latest data.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _


class SpecificationStatus(models.TextChoices):
    DRAFT = "draft", _("Draft")
    IN_REVIEW = "in_review", _("In review")
    APPROVED = "approved", _("Approved")
    SENT = "sent", _("Sent")
    ACCEPTED = "accepted", _("Accepted")
    REJECTED = "rejected", _("Rejected")


class SpecificationDocumentKind(models.TextChoices):
    """Whether a sheet is issued as a working draft or a final document.

    Separate from :class:`SpecificationStatus` on purpose — status is
    the approval lifecycle ("has a director signed?"), kind is what the
    scientist *intends* the document to be. A ``final`` draft-lifecycle
    sheet is perfectly valid (e.g. a reference copy for the client to
    sight-check before signing), and a ``draft`` kind always reads as
    unfinished even after it's approved. Watermarking keys off this
    field so scientists control it explicitly instead of relying on
    a status transition they haven't triggered yet.
    """

    DRAFT = "draft", _("Draft")
    FINAL = "final", _("Final")


class SpecificationSheet(models.Model):
    """A single client-facing specification sheet instance."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="specification_sheets",
    )
    formulation_version = models.ForeignKey(
        "formulations.FormulationVersion",
        on_delete=models.PROTECT,
        related_name="specification_sheets",
        help_text=_(
            "Immutable snapshot the sheet renders against. Editing the "
            "underlying formulation never rewrites this sheet."
        ),
    )

    code = models.CharField(
        _("code"),
        max_length=64,
        blank=True,
        help_text=_("Sheet reference code. Optional, unique per org when set."),
    )
    client_name = models.CharField(
        _("client name"), max_length=200, blank=True, default=""
    )
    client_email = models.EmailField(
        _("client email"), blank=True, default=""
    )
    client_company = models.CharField(
        _("client company"), max_length=200, blank=True, default=""
    )

    margin_percent = models.DecimalField(
        _("margin %"),
        max_digits=6,
        decimal_places=2,
        null=True,
        blank=True,
        help_text=_("Optional target margin for the quote."),
    )
    final_price = models.DecimalField(
        _("final price"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    cover_notes = models.TextField(
        _("cover notes"), blank=True, default=""
    )

    total_weight_label = models.CharField(
        _("total weight label"),
        max_length=64,
        blank=True,
        default="",
        help_text=_(
            "Free-text override for the spec sheet's Total Weight (mg) "
            "row. Blank renders as ``TBC`` to match the workbook's "
            "convention — the filled-capsule weight depends on the "
            "physical shell delivered by the manufacturer and is "
            "set by hand once known."
        ),
    )

    # Packaging-spec rows the workbook's printable sheet exposes
    # beyond the four hard-linked catalogue slots above. Each is a
    # free-text string so the scientist can encode ranges, vendor
    # nuances, or language like "As applicable" without the UI
    # gaining a separate picker for every value.
    unit_quantity = models.CharField(
        _("unit quantity"), max_length=64, blank=True, default=""
    )
    food_contact_status = models.CharField(
        _("food contact status"),
        max_length=200,
        blank=True,
        default="",
    )
    shelf_life = models.CharField(
        _("shelf life"), max_length=64, blank=True, default=""
    )
    storage_conditions = models.CharField(
        _("storage conditions"),
        max_length=200,
        blank=True,
        default="",
    )
    weight_uniformity = models.CharField(
        _("weight uniformity"),
        max_length=64,
        blank=True,
        default="",
        help_text=_(
            "Per-sheet override for the Weight Uniformity row. Blank "
            "falls back to the organization default (10% for "
            "capsule/tablet, ``Not applicable`` for powder/liquid)."
        ),
    )

    # ------------------------------------------------------------------
    # Signatures. Three distinct role-scoped slots — the sheet cannot
    # advance through its status machine without the corresponding
    # signature image captured.
    #
    # * ``prepared_by`` — scientist who drafted the sheet. Signs on
    #   ``draft → in_review``.
    # * ``director`` — internal commercial owner. Signs on
    #   ``in_review → approved``.
    # * ``customer`` — end-client. Signs from the public / kiosk page
    #   on ``sent → accepted``. The actor FK is nullable because the
    #   signer is not a platform user — their identity comes from the
    #   kiosk session (name + email + company label) captured on the
    #   sheet at sign time.
    # ------------------------------------------------------------------
    prepared_by_user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="prepared_spec_sheets",
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
        related_name="approved_spec_sheets",
    )
    director_signed_at = models.DateTimeField(
        _("director signed at"), null=True, blank=True
    )
    director_signature_image = models.TextField(
        _("director signature image"), blank=True, default=""
    )
    customer_name = models.CharField(
        _("customer signer name"), max_length=200, blank=True, default=""
    )
    customer_email = models.EmailField(
        _("customer signer email"), blank=True, default=""
    )
    customer_company = models.CharField(
        _("customer signer company"), max_length=200, blank=True, default=""
    )
    customer_signed_at = models.DateTimeField(
        _("customer signed at"), null=True, blank=True
    )
    customer_signature_image = models.TextField(
        _("customer signature image"), blank=True, default=""
    )

    # Electronic-signature audit trail captured at kiosk sign time.
    # Mirror of the proposal-side columns so a kiosk signature on a
    # bundled spec is just as defensible in court as the proposal
    # signature itself. ESIGN/UETA evidence: who (UA + IP), against
    # what (SHA-256 of rendered HTML).
    customer_sign_ip = models.CharField(
        _("customer sign ip"),
        max_length=45,
        blank=True,
        default="",
        help_text=_("Source IP recorded at kiosk sign time. IPv6 fits in 45 chars."),
    )
    customer_sign_user_agent = models.TextField(
        _("customer sign user agent"),
        blank=True,
        default="",
        help_text=_("Raw User-Agent header recorded at kiosk sign time."),
    )
    customer_sign_document_hash = models.CharField(
        _("customer sign document hash"),
        max_length=64,
        blank=True,
        default="",
        help_text=_(
            "SHA-256 hex digest of the rendered HTML the customer "
            "saw at sign time. Lets us detect post-sign drift."
        ),
    )

    limits_override = models.JSONField(
        _("limits override"),
        default=dict,
        blank=True,
        help_text=_(
            "Per-sheet overrides for the Microbiological / PAH / "
            "Pesticides / Heavy Metal block. Keys match the canonical "
            "slug list (``total_aerobic``, ``total_yeast``, ``e_coli``, "
            "``salmonella``, ``pah``, ``heavy_metal``, ``pesticides``, "
            "``others``); values are free-text limit strings. Empty dict "
            "means fall back to the organization's ``default_limits``."
        ),
    )

    # Phase G5a — last-mile spec sheet edits before sending to a
    # client. Stores per-section overrides on top of the frozen
    # :class:`FormulationVersion.snapshot_totals`. The render layer
    # (``apps.specifications.services.render_context``) deep-merges
    # this dict over the snapshot at view time so the underlying
    # formulation snapshot stays untouched.
    #
    # Schema (every key optional):
    #     {
    #       "formulation": {
    #         "directions_of_use": "...",
    #         "suggested_dosage":  "...",
    #         "appearance":        "...",
    #         "disintegration_spec": "..."
    #       },
    #       "declaration": { "text": "..." },
    #       "allergens":   { "sources": ["Milk", "Soy"] },
    #       "compliance":  {
    #         "vegan":   "yes" | "no" | "unknown",
    #         "organic": "yes" | "no" | "unknown",
    #         "halal":   "yes" | "no" | "unknown",
    #         "kosher":  "yes" | "no" | "unknown"
    #       },
    #       "actives": {
    #         "<line_id>": {
    #           "label_claim_mg": "200",
    #           "nrv_pct":         "100"
    #         }
    #       }
    #     }
    snapshot_overrides = models.JSONField(
        _("snapshot overrides"),
        default=dict,
        blank=True,
        help_text=_(
            "Per-sheet overrides applied on top of the frozen "
            "formulation snapshot at render time. Lets sales tweak "
            "directions, declaration text, allergen list, compliance "
            "flags and per-active claims for a specific client "
            "without forking the underlying formulation. Empty dict "
            "= render the snapshot verbatim."
        ),
    )

    section_visibility = models.JSONField(
        _("section visibility"),
        default=dict,
        blank=True,
        help_text=_(
            "Map of section-slug → bool that decides which blocks the "
            "customer-facing sheet renders. Absence of a key is "
            "interpreted as ``True`` so existing sheets keep showing "
            "everything; toggling a section off writes ``False`` here. "
            "The ``manage_spec_visibility`` capability gates writes."
        ),
    )

    section_order = models.JSONField(
        _("section order"),
        default=list,
        blank=True,
        help_text=_(
            "Ordered list of section slugs that overrides the default "
            "top-down layout of the customer-facing sheet. Missing or "
            "unknown slugs fall back to the canonical order, so a stale "
            "override cannot hide a newly-added section. Gated by the "
            "same ``manage_spec_visibility`` capability as the "
            "on/off toggles."
        ),
    )

    # Packaging selection — each slot points at one row in the org's
    # ``packaging`` catalogue. Nullable so a sheet can be saved before
    # packaging is finalised (F4.1 fills the four placeholders that
    # currently render as ``TBD`` on the spec sheet). PROTECT stops a
    # packaging row in active use from being silently deleted and
    # orphaning the sheet's declared spec.
    packaging_lid = models.ForeignKey(
        "catalogues.Item",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="specification_sheets_as_lid",
        help_text=_(
            "Closure / lid from the org's packaging catalogue. "
            "Renders on the spec sheet's Lid Description row."
        ),
    )
    packaging_container = models.ForeignKey(
        "catalogues.Item",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="specification_sheets_as_container",
        help_text=_(
            "Primary container (bottle, pouch, tub) from the packaging "
            "catalogue. Renders on the spec sheet's Bottle/Pouch/Tub row."
        ),
    )
    packaging_label = models.ForeignKey(
        "catalogues.Item",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="specification_sheets_as_label",
        help_text=_(
            "Product label from the packaging catalogue. Renders on "
            "the spec sheet's Label Size row."
        ),
    )
    packaging_antitemper = models.ForeignKey(
        "catalogues.Item",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="specification_sheets_as_antitemper",
        help_text=_(
            "Tamper-evidence component from the packaging catalogue. "
            "Renders on the spec sheet's Antitemper row."
        ),
    )

    public_token = models.UUIDField(
        _("public token"),
        null=True,
        blank=True,
        unique=True,
        db_index=True,
        default=None,
        help_text=_(
            "Opaque UUID that, when set, grants unauthenticated "
            "read-only access to this sheet via the public preview URL. "
            "Null by default — sheets are private unless a link is "
            "explicitly generated. Rotating the token invalidates every "
            "previously-shared link in one write."
        ),
    )

    status = models.CharField(
        _("status"),
        max_length=16,
        choices=SpecificationStatus.choices,
        default=SpecificationStatus.DRAFT,
    )
    document_kind = models.CharField(
        _("document kind"),
        max_length=16,
        choices=SpecificationDocumentKind.choices,
        default=SpecificationDocumentKind.DRAFT,
        help_text=_(
            "Whether this sheet prints as a working draft (with the "
            "diagonal DRAFT watermark) or as a final document (clean). "
            "Independent of ``status`` — scientists flip it explicitly "
            "so an internal draft can circulate with the watermark "
            "even on an ``approved`` sheet, and vice versa."
        ),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_specification_sheets",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_specification_sheets",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    # Commercial pricing attached to the spec — mirrors the trio the
    # proposal modal has used since day one (``unit_cost`` +
    # ``margin_percent`` → derived ``unit_price``) so the math the
    # scientist sees here is byte-identical to what sales does later.
    #
    # ``margin_percent`` and ``final_price`` already existed on the
    # model from earlier work but were never wired into a UI. We
    # reuse them: ``margin_percent`` keeps its name, ``final_price``
    # represents the per-unit price (semantically the proposal
    # modal's ``unit_price``). The new fields below are ``unit_cost``,
    # ``quantity``, and ``currency``.
    #
    # Every pricing field is nullable for backwards compat: every
    # spec that existed before this migration carries ``None`` for
    # the new columns and the UI shows a yellow "no price set"
    # badge until the team fills it in.
    #
    # Pricing freezes once the sheet hits ``approved`` (the director
    # signs the snapshot — including its price). The service layer
    # enforces the lock; the model fields stay writable so a future
    # migration that *needs* to backfill historical pricing isn't
    # blocked at the DB layer.
    unit_cost = models.DecimalField(
        _("unit cost"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "What the unit costs us to make. Combined with "
            "``margin_percent`` to compute the customer unit price "
            "(stored on ``final_price``)."
        ),
    )
    quantity = models.PositiveIntegerField(
        _("quantity"),
        default=1,
        help_text=_(
            "Number of units in the order this price quotes. The "
            "proposal modal seeds its own ``quantity`` from this "
            "value when the spec is selected."
        ),
    )
    currency = models.CharField(
        _("currency"),
        max_length=3,
        default="GBP",
        help_text=_(
            "ISO-4217 currency code. Defaults to GBP; override per "
            "spec when quoting in another currency."
        ),
    )

    # Delivery evidence captured at ``sent`` transition time. Answers
    # the audit question "how did the customer receive this document?"
    # so a signed sheet has provenance from build → send → sign.
    # Populated exclusively by ``transition_status`` when moving into
    # ``SENT`` — the fields are otherwise read-only from the app.
    SENT_DELIVERY_PUBLIC_LINK = "public_link"
    SENT_DELIVERY_EMAIL = "email"
    SENT_DELIVERY_OTHER = "other"
    SENT_DELIVERY_CHOICES = (
        (SENT_DELIVERY_PUBLIC_LINK, _("Public preview link")),
        (SENT_DELIVERY_EMAIL, _("Email")),
        (SENT_DELIVERY_OTHER, _("Other")),
    )
    sent_at = models.DateTimeField(
        _("sent at"),
        null=True,
        blank=True,
        help_text=_(
            "Timestamp at which the sheet was moved to ``sent`` and "
            "the delivery evidence was captured. Null on any sheet "
            "that has never left ``approved``."
        ),
    )
    sent_delivery_method = models.CharField(
        _("sent delivery method"),
        max_length=16,
        blank=True,
        default="",
        choices=SENT_DELIVERY_CHOICES,
        help_text=_(
            "How the customer received the sheet: the auto-generated "
            "public preview link, an email attachment, or a manual "
            "channel (courier / in-person / etc.). Captured at the "
            "``approved → sent`` transition; empty until then."
        ),
    )
    sent_recipient = models.CharField(
        _("sent recipient"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Recipient identifier for the sent delivery — an email "
            "address for the ``email`` channel, a free-text note "
            "(e.g. ``courier: Sarah at DHL``) for ``other``, or the "
            "public preview URL for ``public_link``. Frozen at the "
            "``approved → sent`` transition; empty on any sheet "
            "still in earlier states."
        ),
    )

    class Meta:
        verbose_name = _("specification sheet")
        verbose_name_plural = _("specification sheets")
        ordering = ("-updated_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "code"),
                condition=~models.Q(code=""),
                name="specifications_unique_code_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=("organization", "status")),
            models.Index(fields=("organization", "-updated_at")),
            # Workspace panel + project header both join via
            # ``formulation_version_id`` to surface a project's
            # current spec sheets. Postgres can auto-index the FK
            # column for joins, but the dedicated index keeps the
            # plan stable across upgrades / config changes.
            models.Index(
                fields=("formulation_version",),
                name="specs_formulation_version_idx",
            ),
            # ``transition_status`` runs a review-slot uniqueness
            # query on every send-for-review and approve action:
            # ``filter(formulation_version__formulation_id=...,
            # document_kind=..., status=IN_REVIEW)``. Without a
            # composite, that query scans every spec sheet in the
            # database to enforce a per-project rule.
            models.Index(
                fields=("formulation_version", "document_kind", "status"),
                name="specs_fv_kind_status_idx",
            ),
        ]

    def __str__(self) -> str:
        return self.code or str(self.id)


class SpecificationTransition(models.Model):
    """Append-only audit log of every status change on a spec sheet.

    Each row stamps *who* moved the sheet *from where* to *where*,
    *when*, and optionally *why*. The rows are the electronic equivalent
    of the handwritten signature boxes on the printed sheet — together
    they let the business prove end-to-end who approved what before it
    went to the client, without tying the sheet's forward progress to
    a physical signature first.

    Rows are never updated or deleted by application code; if a
    transition was wrong the remediation is to reverse it with another
    transition (``rejected → draft``), not to edit history.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    sheet = models.ForeignKey(
        SpecificationSheet,
        on_delete=models.CASCADE,
        related_name="transitions",
    )
    from_status = models.CharField(
        _("from status"),
        max_length=16,
        choices=SpecificationStatus.choices,
        help_text=_(
            "Status the sheet left. Recorded alongside ``to_status`` "
            "so the audit trail is readable in isolation, without "
            "joining against the previous transition row."
        ),
    )
    to_status = models.CharField(
        _("to status"),
        max_length=16,
        choices=SpecificationStatus.choices,
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="specification_transitions",
    )
    notes = models.TextField(
        _("notes"),
        blank=True,
        default="",
        help_text=_(
            "Optional free-text justification the actor left at "
            "transition time — e.g. ``approved pending pack change``."
        ),
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("specification transition")
        verbose_name_plural = _("specification transitions")
        # Most recent first so history queries land on the right
        # order without extra sorting in the view layer.
        ordering = ("-created_at",)
        indexes = [
            models.Index(fields=("sheet", "-created_at")),
        ]

    def __str__(self) -> str:
        return f"{self.sheet_id}: {self.from_status} → {self.to_status}"
