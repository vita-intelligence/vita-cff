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
