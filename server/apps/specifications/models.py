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
