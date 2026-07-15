"""Domain models for the formulations app.

A :class:`Formulation` is the working workspace a scientist edits to
turn a customer brief into a production-ready formula. It holds all
the mutable state (metadata + ingredient lines) that the builder UI
drives directly. Every save snapshots the current state into an
immutable :class:`FormulationVersion` so the scientist can iterate
freely and roll back without losing history.

``FormulationLine`` holds the active ingredient rows in their editable
form (FK to the parent formulation). Versions stash the same data as
a denormalised JSON snapshot — versions are frozen history, not a
mirror of mutable rows, so we never have to join back through the
line table to reconstruct an older state.
"""

from __future__ import annotations

import uuid

from django.conf import settings
from django.db import models
from django.utils import timezone
from django.utils.translation import gettext_lazy as _

from apps.formulations.constants import DosageForm, PowderType


class ProjectStatus(models.TextChoices):
    """Product-roadmap status of the project (==formulation).

    The single lifecycle chip surfaced on the project workspace.
    R&D sign-off (scientist + manager signatures) lives on version
    snapshots and validations rather than on the formulation
    header — separating "is the recipe done" from "where is the
    product going" had no real-world readers, so we collapsed to
    this one roadmap field.
    """

    CONCEPT = "concept", _("Concept")
    IN_DEVELOPMENT = "in_development", _("In development")
    PILOT = "pilot", _("Pilot")
    APPROVED = "approved", _("Approved")
    DISCONTINUED = "discontinued", _("Discontinued")


class ProjectType(models.TextChoices):
    """Commercial engagement model for a project.

    ``custom`` means the formulation is being developed bespoke for
    the client (laboratory development phase, deposit required, long
    lead time). ``ready_to_go`` means an existing validated recipe
    is being manufactured for them with no dev work. Drives which
    proposal template renders on the client kiosk — Custom.docx
    includes the development phase + 30% deposit language; Ready to
    Go.docx is a shorter straight-to-production quote.
    """

    CUSTOM = "custom", _("Custom")
    READY_TO_GO = "ready_to_go", _("Ready to Go")


class DosageFormChoices(models.TextChoices):
    POWDER = DosageForm.POWDER.value, _("Powder")
    CAPSULE = DosageForm.CAPSULE.value, _("Capsule")
    TABLET = DosageForm.TABLET.value, _("Tablet")
    GUMMY = DosageForm.GUMMY.value, _("Gummy")
    LIQUID = DosageForm.LIQUID.value, _("Liquid")
    OTHER_SOLID = DosageForm.OTHER_SOLID.value, _("Other solid")


class PowderTypeChoices(models.TextChoices):
    """Sub-variants of the powder dosage form.

    Only surfaced in the UI when ``dosage_form == POWDER``; the field
    stays at its default for every other form and is simply ignored
    by the math in those cases.
    """

    STANDARD = PowderType.STANDARD.value, _("Standard")
    PROTEIN = PowderType.PROTEIN.value, _("Protein")


class Formulation(models.Model):
    """A single product workspace inside an organization."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="formulations",
    )
    code = models.CharField(
        _("code"),
        max_length=64,
        blank=True,
        help_text=_("Internal product code. Optional, unique per org when set."),
    )
    name = models.CharField(_("name"), max_length=200)
    description = models.TextField(_("description"), blank=True, default="")

    dosage_form = models.CharField(
        _("dosage form"),
        max_length=32,
        choices=DosageFormChoices.choices,
        default=DosageFormChoices.CAPSULE,
    )
    #: Key from :data:`apps.formulations.constants.CAPSULE_SIZES`. Null
    #: when the scientist has not picked one yet — the math falls back
    #: to :func:`auto_pick_capsule_size`.
    capsule_size = models.CharField(
        _("capsule size"), max_length=32, blank=True, default=""
    )
    #: Key from :data:`apps.formulations.constants.TABLET_SIZES`.
    tablet_size = models.CharField(
        _("tablet size"), max_length=32, blank=True, default=""
    )

    serving_size = models.PositiveIntegerField(
        _("serving size"),
        default=1,
        help_text=_("Units (capsules/tablets/scoops) the customer consumes per serving."),
    )
    servings_per_pack = models.PositiveIntegerField(
        _("servings per pack"), default=60
    )
    directions_of_use = models.TextField(
        _("directions of use"), blank=True, default=""
    )
    suggested_dosage = models.TextField(
        _("suggested dosage"), blank=True, default=""
    )
    appearance = models.CharField(
        _("appearance"), max_length=200, blank=True, default=""
    )
    disintegration_spec = models.CharField(
        _("disintegration spec"),
        max_length=200,
        blank=True,
        default="",
        help_text=_("Target disintegration time (e.g. 'within 60 minutes')."),
    )
    target_fill_weight_mg = models.DecimalField(
        _("target fill weight (mg)"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "Target fill weight per serving unit — sachet mass for "
            "powders, single-gummy weight for gummies. Drives the "
            "fill-weight check (total ingredients should equal "
            "this target). Leave blank for capsule/tablet where "
            "the math uses the selected size instead."
        ),
    )
    powder_type = models.CharField(
        _("powder type"),
        max_length=16,
        choices=PowderTypeChoices.choices,
        default=PowderTypeChoices.STANDARD,
        help_text=_(
            "Sub-variant of the Powder dosage form. Protein powders "
            "omit Trisodium Citrate + Citric Acid from the flavour "
            "system because the protein matrix already buffers "
            "itself. Ignored for non-powder forms."
        ),
    )
    water_volume_ml = models.DecimalField(
        _("water volume (ml)"),
        max_digits=8,
        decimal_places=2,
        null=True,
        blank=True,
        help_text=_(
            "Volume of water the powder is designed to dissolve "
            "in (per serving). Drives the flavour-system mg "
            "concentrations — the preset values assume a 500ml "
            "reference serving, so lowering to 250ml halves every "
            "flavour row and raising to 1000ml doubles them. "
            "Ignored for non-powder forms."
        ),
    )
    gummy_base_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("gummy base items"),
        blank=True,
        related_name="gummy_base_formulations",
        help_text=_(
            "Raw-material items that make up the gummy base — e.g. a "
            "Xylitol + Maltitol blend. Each pick must have use_as ∈ "
            "(Sweeteners, Bulking Agent). The base total "
            "(target − water − actives − flavour, min 65% of target) "
            "is split **equally** across picked items. Nutrition + "
            "compliance + label copy flow from every picked item into "
            "the spec sheet under the EU category label (e.g. "
            "'Sweeteners (Xylitol, Maltitol)'). Ignored for non-gummy "
            "forms."
        ),
    )
    acidity_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("acidity regulator items"),
        blank=True,
        related_name="acidity_formulations",
        help_text=_(
            "Raw-material items used as the acidity regulator on a "
            "gummy — Citric Acid, Trisodium Citrate, Sodium Citrate, "
            "etc. Each pick must carry use_as = 'Acidity Regulator'. "
            "The acidity total (2% of target gummy weight) splits "
            "**equally** across picks; the declaration groups them "
            "as 'Acidity Regulator (Citric Acid, …)'. Empty list "
            "leaves a placeholder row — scientists must pick items "
            "before the MRPeasy BOM is procurement-ready."
        ),
    )
    flavouring_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("flavouring items"),
        blank=True,
        related_name="flavouring_formulations",
        help_text=_(
            "Raw-material items used as flavour agents — e.g. Natural "
            "Strawberry Flavour, Lemon Extract. Each pick must carry "
            "use_as = 'Flavouring'. The flavour total (0.4% of target "
            "gummy weight) splits equally across picks and groups on "
            "the spec sheet as 'Flavouring (Natural Strawberry, "
            "Lemon Extract)'. Ignored for non-gummy forms."
        ),
    )
    colour_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("colour items"),
        blank=True,
        related_name="colour_formulations",
        help_text=_(
            "Raw-material items used as colours — e.g. Beetroot "
            "Extract, Turmeric Oleoresin, Spirulina Powder. Each "
            "pick must carry use_as = 'Colour'. The colour total "
            "splits equally across picks and groups as "
            "'Colour (Beetroot Extract, Turmeric)' on the spec sheet. "
            "Used by both gummies (2% of target weight) and powders "
            "(0.04 mg/ml × water volume)."
        ),
    )
    sweetener_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("sweetener items"),
        blank=True,
        related_name="sweetener_formulations",
        help_text=_(
            "Raw-material items used as the sweetener on a powder — "
            "Sucralose, Stevia, Steviol, etc. Each pick must carry "
            "use_as = 'Sweeteners'. The sweetener total "
            "(0.06 mg/ml × water volume) splits equally across picks "
            "and groups as 'Sweetener (Sucralose, Stevia)' on the "
            "spec sheet. Empty list keeps the generic placeholder. "
            "Ignored for non-powder forms — gummies use "
            "``gummy_base_items`` and ``premix_sweetener_items`` "
            "instead."
        ),
    )
    glazing_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("glazing agent items"),
        blank=True,
        related_name="glazing_formulations",
        help_text=_(
            "Raw-material items applied as the surface glaze on a "
            "finished gummy — carnauba wax, coconut oil, beeswax, "
            "shellac, etc. Each pick must have use_as = 'Glazing "
            "Agent'. The glaze total (0.1% of target gummy weight) is "
            "split **equally** across picks; the declaration groups "
            "them as 'Glazing Agent (Carnauba Wax, Coconut Oil)'. "
            "Ignored for non-gummy forms."
        ),
    )
    gelling_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("gelling agent items"),
        blank=True,
        related_name="gelling_formulations",
        help_text=_(
            "Raw-material items used as the gel matrix on a gummy — "
            "pectin, gelatin, agar, carrageenan, etc. Each pick must "
            "carry use_as = 'Gelling Agent'. The gelling total (3% of "
            "target gummy weight, default) splits **equally** across "
            "picks; the declaration groups them as 'Gelling Agent "
            "(Pectin)'. An empty pick list means a non-gelling gummy "
            "and skips the gelling + premix-sweetener bands "
            "entirely. Ignored for non-gummy forms."
        ),
    )
    premix_sweetener_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("premix sweetener items"),
        blank=True,
        related_name="premix_sweetener_formulations",
        help_text=_(
            "Raw-material items combined with the gelling agent to "
            "form the in-house 'Pectin Premix' line on the MRPeasy "
            "BOM — typically maltitol, xylitol, sucrose. Picks pull "
            "from the same catalogue pool as the gummy base "
            "(use_as ∈ Sweeteners, Bulking Agent). The premix-"
            "sweetener total (6% of target, default) is **carved "
            "out** of the gummy base remainder so the visible base "
            "shrinks accordingly. Only emitted when gelling items "
            "are also picked."
        ),
    )
    capsule_shell_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("capsule shell items"),
        blank=True,
        related_name="capsule_shell_formulations",
        help_text=_(
            "Empty capsule shell items the finished pack is filled "
            "into. Each pick must carry use_as = 'Capsule Shell'. "
            "The shell's attributes.capsule_size drives the fill "
            "capacity for compute; attributes.shell_weight_mg "
            "drives the mg the declaration attributes to the shell "
            "row. Empty list falls back to the hardcoded per-size "
            "table (CAPSULE_SHELL_WEIGHTS in the FE, matching "
            "constants on the Python side) so legacy formulations "
            "keep rendering. Ignored for tablet / powder / gummy."
        ),
    )
    mcc_carrier_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("MCC carrier items"),
        blank=True,
        related_name="mcc_carrier_formulations",
        help_text=_(
            "Raw-material items used as the MCC (microcrystalline "
            "cellulose) carrier on a capsule or tablet. Each pick "
            "must carry use_as = 'Bulking Agent'. The MCC total "
            "(remainder for capsules, fixed ratio for tablets) "
            "splits **equally** across picks; the declaration emits "
            "one row per pick with the picked item's "
            "ingredient_list_name + nutrition + compliance flags "
            "flowing through. Empty list falls back to the generic "
            "'Microcrystalline Cellulose (Carrier)' placeholder so "
            "legacy formulations keep rendering — the spec sheet "
            "surfaces a soft warning so the scientist knows to "
            "tighten it up. Ignored for powders / gummies."
        ),
    )
    dcp_carrier_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("DCP carrier items"),
        blank=True,
        related_name="dcp_carrier_formulations",
        help_text=_(
            "Raw-material items used as the DCP (dicalcium "
            "phosphate) carrier on a tablet. Each pick must carry "
            "use_as = 'Bulking Agent'. The DCP total (10% of total "
            "active) splits **equally** across picks; same per-pick "
            "row + label + nutrition flow as the MCC carrier picker. "
            "Empty list falls back to the generic 'Dicalcium "
            "Phosphate' placeholder. Ignored for non-tablet forms."
        ),
    )
    anti_caking_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("anti-caking items"),
        blank=True,
        related_name="anti_caking_formulations",
        help_text=_(
            "Raw-material items used as the combined anti-caking "
            "agent on a capsule, tablet, or powder (typically "
            "Magnesium Stearate + Silicon Dioxide, but any item "
            "tagged use_as = 'Anti-caking Agent' is admissible). "
            "Contribution is dynamic per pick: a silica-only pick "
            "fires the 0.4% silica band, a stearate-only pick the "
            "1.0% lubricant band, and picking both lights up the "
            "full 1.4%. **Empty list = no anti-caking on the "
            "formulation at all** -- the spec sheet drops the row "
            "entirely, supporting scientists who deliberately ship "
            "without lubricants. Ignored for gummies."
        ),
    )
    powder_carrier_items = models.ManyToManyField(
        "catalogues.Item",
        verbose_name=_("powder carrier items"),
        blank=True,
        related_name="powder_carrier_formulations",
        help_text=_(
            "Raw-material items used as the structural carrier on a "
            "powder formulation -- typically Maltodextrin, but any "
            "item tagged use_as in ('Carrier', 'Bulking Agent') is "
            "admissible. The carrier total fills the remainder of "
            "the sachet after the actives and the other excipient "
            "bands, mirroring the way scientists historically added "
            "Maltodextrin as a real actives line. Empty list = no "
            "carrier band on the formulation. Ignored for capsule, "
            "tablet, gummy, and liquid forms."
        ),
    )
    excipient_overrides: models.JSONField = models.JSONField(
        _("excipient overrides"),
        default=dict,
        blank=True,
        help_text=_(
            "Per-band percentage overrides for the gummy excipient "
            "system. Keys: water, acidity, flavouring, colour, "
            "glazing, gelling, premix_sweetener. Values are decimal "
            "fractions (0.02 = 2%). Missing keys fall back to the "
            "constant defaults. Empty dict = no overrides. Used so "
            "scientists can fine-tune ratios at the trial-batch / "
            "spec-sheet stage without forking the global defaults."
        ),
    )

    project_status = models.CharField(
        _("project status"),
        max_length=16,
        choices=ProjectStatus.choices,
        default=ProjectStatus.CONCEPT,
        db_index=True,
        help_text=_(
            "Product-roadmap position. Drives the chip shown at the "
            "top of the project workspace and the project list filter."
        ),
    )
    project_type = models.CharField(
        _("project type"),
        max_length=16,
        choices=ProjectType.choices,
        default=ProjectType.CUSTOM,
        db_index=True,
        help_text=_(
            "Custom (bespoke development + deposit) vs Ready to Go "
            "(existing recipe, faster turnaround). Drives the proposal "
            "template rendered for the client."
        ),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_formulations",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="updated_formulations",
    )
    # Commercial owner of the project. Pointer-only: being the sales
    # person does not unlock any capabilities on its own. Assignment
    # is gated on the dedicated ``formulations.assign_sales_person``
    # capability and the candidate must be a member of the same
    # organization. ``SET_NULL`` keeps the project alive if the person
    # later leaves — the field clears, history of who held it lives in
    # the audit log.
    sales_person = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="sales_formulations",
        null=True,
        blank=True,
    )
    # R&D lead on the project. Mirrors :attr:`sales_person` exactly —
    # advisory pointer, no capability inheritance, ``SET_NULL`` on
    # the member leaving the org. Assignment gated on the
    # ``formulations.assign_lead_scientist`` capability and the
    # candidate must be a member of the same organization. Other R&D
    # members can still edit the workspace; this field only signals
    # who is responsible for steering the recipe work.
    lead_scientist = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="lead_scientist_formulations",
        null=True,
        blank=True,
    )
    approved_version_number = models.PositiveIntegerField(
        _("approved version number"),
        null=True,
        blank=True,
        help_text=_(
            "Points at the :class:`FormulationVersion` snapshot the "
            "scientist marked as the current approved recipe. Every "
            "version picker in the app (trial batch, spec sheet, "
            "QC) badges this number so a teammate never plans a "
            "procurement run off a stale draft."
        ),
    )

    # ------------------------------------------------------------------
    # Ready-to-Go catalog marketing block. Populated only on
    # ``project_type=ready_to_go`` formulations. Once ``is_rtg_published``
    # flips true, the row is discoverable in the customer portal's
    # RTG catalog at ``/portal/cffs/new/rtg`` — customers can order
    # the product without a bespoke development cycle. The service
    # layer (``publish_to_rtg_catalog``) enforces the invariants
    # (marketing copy present, MOQ >= 1, at least one packaging
    # option, project_type constraint) so the model stays additive.
    # ------------------------------------------------------------------
    is_rtg_published = models.BooleanField(
        _("published to RTG catalog"),
        default=False,
        db_index=True,
        help_text=_(
            "When true, this Ready-to-Go recipe surfaces in the "
            "portal catalog for org customers. Only meaningful when "
            "``project_type=ready_to_go``; the publish service "
            "refuses to flip this on for Custom projects."
        ),
    )
    rtg_display_name = models.CharField(
        _("RTG display name"),
        max_length=200,
        blank=True,
        default="",
        help_text=_(
            "Customer-facing name shown on the RTG catalog (staff "
            "hub + portal grid + order confirmation). Kept separate "
            "from ``name`` so R&D can keep the internal identifier "
            "(``PROT-042 · Vanilla Protein v3.2``) untouched "
            "for specs + audit while marketing uses a cleaner label "
            "(``Signature Vanilla Whey``). Blank falls back to "
            "``name`` in every consumer."
        ),
    )
    rtg_short_description = models.TextField(
        _("RTG short description"),
        blank=True,
        default="",
        help_text=_(
            "Marketing sub-copy shown on the catalog card (one to "
            "two sentences). Kept short so the grid stays scannable."
        ),
    )
    rtg_hero_image = models.ImageField(
        _("RTG hero image"),
        upload_to="rtg-hero/",
        blank=True,
        null=True,
        help_text=_(
            "Hero image for the catalog card. Optional — the FE "
            "falls back to a monogram tile when unset."
        ),
    )
    rtg_base_price = models.DecimalField(
        _("RTG base price"),
        max_digits=12,
        decimal_places=2,
        null=True,
        blank=True,
        help_text=_(
            "Per-unit price used to pre-fill the drafted proposal "
            "line when a customer orders this SKU from the catalog. "
            "Currency is ``rtg_currency_code``."
        ),
    )
    rtg_moq = models.PositiveIntegerField(
        _("RTG minimum order quantity"),
        null=True,
        blank=True,
        help_text=_(
            "Smallest quantity the customer may order in one go. "
            "Enforced server-side at submission — the portal short "
            "form refuses to submit below this value."
        ),
    )
    rtg_packaging_options: models.JSONField = models.JSONField(
        _("RTG packaging options"),
        default=list,
        blank=True,
        help_text=_(
            "List of packaging variant labels the customer picks "
            "from at order time (e.g. ``[\"120g jar\", \"60-count "
            "pouch\"]``). At least one entry required to publish. "
            "The submission service validates the chosen packaging "
            "against this list."
        ),
    )
    rtg_currency_code = models.CharField(
        _("RTG currency code"),
        max_length=3,
        default="GBP",
        help_text=_(
            "ISO 4217 code for ``rtg_base_price``. Snapshotted "
            "onto the drafted proposal so the customer's quote "
            "never drifts against a later catalog re-price."
        ),
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("formulation")
        verbose_name_plural = _("formulations")
        ordering = ("-updated_at",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "code"),
                condition=~models.Q(code=""),
                name="formulations_unique_code_per_org",
            ),
        ]
        indexes = [
            models.Index(fields=("organization", "-updated_at")),
            # Project status filter is the most-used drill-down on
            # the formulations list (in-progress / approved / archived
            # tabs). The composite keeps the org-scoped status query
            # off a sequential scan.
            models.Index(
                fields=("organization", "project_status"),
                name="formulations_org_status_idx",
            ),
            # Sales-person filter on the projects list bar narrows
            # the org-wide roster of formulations to one rep's book.
            # Without this composite the filter scans every row in
            # the org and discards the non-matches in Python.
            models.Index(
                fields=("organization", "sales_person"),
                name="formulations_org_sales_idx",
            ),
            # Mirror of the sales-person index for the R&D kanban —
            # the ``scope=mine`` view of ``/rd-pipeline`` filters on
            # ``WHERE organization=X AND lead_scientist=Y`` and would
            # otherwise scan every project row in the tenant before
            # evaluating the stage-EXISTS predicates. Big tenants
            # would feel this within months; cheaper to ship the
            # index up-front than chase a slow-page report later.
            models.Index(
                fields=("organization", "lead_scientist"),
                name="formulations_org_lead_sci_idx",
            ),
        ]

    def __str__(self) -> str:
        return self.name


class FormulationLine(models.Model):
    """An active ingredient row on a formulation.

    ``mg_per_serving_cached`` is the service-computed raw powder weight
    (label_claim divided by purity or extract ratio, with overage).
    We persist it so downstream views don't re-run the cascade on
    every render, and so the viability totals stay consistent with
    whatever the scientist saw in the UI at save time.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="lines",
    )
    #: Source discriminator. ``"local"`` — the classic path: the
    #: FK below points at a row in :mod:`apps.catalogues`. ``"psp"``
    #: — the item lives in the org's PSP catalogue; ``item`` is
    #: NULL and :attr:`psp_item_uuid` + :attr:`psp_item_snapshot`
    #: carry the identity + snapshotted attributes. Every existing
    #: row is ``"local"`` after the additive 0036 migration; new
    #: rows on PSP-live orgs land as ``"psp"``. The compute layer
    #: dispatches on this column so a single formulation line
    #: renders + computes identically regardless of source.
    item_source = models.CharField(
        _("item source"),
        max_length=16,
        default="local",
        choices=(("local", _("Local catalogue")), ("psp", _("PSP catalogue"))),
        db_index=True,
    )
    #: The local catalogue Item this line quotes. Nullable now that
    #: PSP-sourced lines exist — those carry ``item=None`` and
    #: reference the PSP row via :attr:`psp_item_uuid` /
    #: :attr:`psp_item_snapshot` instead. Downstream code that
    #: dereferences ``line.item`` MUST branch on
    #: :attr:`item_source` first (or use the ``line_item_*``
    #: helpers on services.py) to avoid ``NoneType`` errors on
    #: PSP rows.
    item = models.ForeignKey(
        "catalogues.Item",
        on_delete=models.PROTECT,
        related_name="formulation_lines",
        null=True,
        blank=True,
    )
    #: PSP integration items UUID. Populated iff
    #: :attr:`item_source` == ``"psp"``. Together with the
    #: snapshot below this is the durable identity of the picked
    #: PSP row — an operator disabling the PSP integration doesn't
    #: void the reference, and the compute layer can still render
    #: the line from the snapshot even if PSP is unreachable.
    psp_item_uuid = models.UUIDField(
        _("PSP item UUID"),
        null=True,
        blank=True,
        db_index=True,
    )
    #: Snapshot of the PSP item's compute-critical fields at pick
    #: time. Populated iff :attr:`item_source` == ``"psp"``. Shape:
    #:
    #: .. code-block:: json
    #:
    #:    {
    #:      "name": "Ashwagandha KSM-66",
    #:      "external_sku": "ASH-KSM",
    #:      "description": "Root extract 5%",
    #:      "attributes": {
    #:        "use_as": "active",
    #:        "purity": "0.05",
    #:        "overage": "0.1",
    #:        "extract_ratio": null,
    #:        "powder_standard_mg_per_g": "1000",
    #:        "powder_protein_mg_per_g": null,
    #:        "carrier_share_pct": null
    #:      }
    #:    }
    #:
    #: Refreshed by the picker on pick and by an explicit "refresh
    #: from PSP" action on the line — never silently drifted.
    #: Keeping the compute-critical fields snapshotted here means
    #: dose math doesn't need to hit PSP on every recompute + the
    #: line stays computable when PSP is momentarily unreachable.
    psp_item_snapshot = models.JSONField(
        _("PSP item snapshot"),
        default=dict,
        blank=True,
    )
    display_order = models.PositiveIntegerField(_("display order"), default=0)
    label_claim_mg = models.DecimalField(
        _("label claim (mg)"),
        max_digits=12,
        decimal_places=4,
    )
    serving_size_override = models.PositiveIntegerField(
        _("serving size override"),
        null=True,
        blank=True,
        help_text=_("Per-line override; falls back to the formulation's serving size."),
    )
    #: Optional per-line overrides for the three catalogue attributes
    #: that drive the purity/overage cascade. ``null`` (the default)
    #: means "use the source raw material's catalogue value"; any
    #: non-null value wins for THIS formulation only — the catalogue
    #: stays untouched. Scientists tune these per product when a
    #: specific batch / supplier deviates from the standard purity
    #: spec without polluting the global master.
    purity_override = models.DecimalField(
        _("purity override"),
        max_digits=8,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "Override the raw material's purity for this formulation "
            "only. Leave blank to use the catalogue value."
        ),
    )
    overage_override = models.DecimalField(
        _("overage override"),
        max_digits=8,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "Override the raw material's overage for this formulation "
            "only. Leave blank to use the catalogue value."
        ),
    )
    extract_ratio_override = models.DecimalField(
        _("extract ratio override"),
        max_digits=10,
        decimal_places=4,
        null=True,
        blank=True,
        help_text=_(
            "Override the raw material's extract ratio (botanical "
            "items only). Leave blank to use the catalogue value."
        ),
    )
    mg_per_serving_cached = models.DecimalField(
        _("mg per serving (cached)"),
        max_digits=14,
        decimal_places=4,
        null=True,
        blank=True,
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    # ------------------------------------------------------------------
    # Polymorphic helpers — every downstream reader that used to
    # dereference ``line.item.X`` should now go through these. The
    # helpers dispatch on :attr:`item_source` so the compute layer +
    # serializers work identically for local + PSP lines without
    # sprinkling ``if line.item_source ==`` branches at every call
    # site. When ``item_source == 'psp'`` the values come from
    # :attr:`psp_item_snapshot`; otherwise from the local FK.
    # ------------------------------------------------------------------

    @property
    def effective_item_name(self) -> str:
        if self.item_source == "psp":
            snap = self.psp_item_snapshot or {}
            return str(snap.get("name") or "")
        return self.item.name if self.item_id else ""

    @property
    def effective_item_internal_code(self) -> str:
        """The line's identifier as displayed on spec sheets + BOM.
        Local: ``item.internal_code``. PSP: ``external_sku`` from
        the snapshot (falls back to the PSP UUID's first 8 chars
        when the SKU is blank, matching the picker's convention)."""

        if self.item_source == "psp":
            snap = self.psp_item_snapshot or {}
            sku = str(snap.get("external_sku") or "").strip()
            if sku:
                return sku
            uuid_hex = str(self.psp_item_uuid or "").replace("-", "")
            return uuid_hex[:8]
        return self.item.internal_code if self.item_id else ""

    @property
    def effective_item_attributes(self) -> dict:
        """The catalogue-side ``attributes`` map. Local reads it
        off the ``Item`` row; PSP reads it from the pick-time
        snapshot. Compute paths that read ``use_as``, ``purity``,
        ``powder_standard_mg_per_g``, etc. must route through this
        property so a PSP line renders identically to a local one."""

        if self.item_source == "psp":
            snap = self.psp_item_snapshot or {}
            attrs = snap.get("attributes")
            return attrs if isinstance(attrs, dict) else {}
        return (self.item.attributes or {}) if self.item_id else {}

    @property
    def effective_item_reference(self) -> str:
        """Stable identity string for logging + audit rows: the
        local Item UUID or the PSP item UUID. Never blank on a
        legal row (each source guarantees one of the two)."""

        if self.item_source == "psp":
            return str(self.psp_item_uuid or "")
        return str(self.item_id or "")

    class Meta:
        verbose_name = _("formulation line")
        verbose_name_plural = _("formulation lines")
        ordering = ("display_order", "created_at")
        indexes = [
            models.Index(fields=("formulation", "display_order")),
        ]

    def __str__(self) -> str:
        return f"{self.item.name} ({self.label_claim_mg} mg)"


class FormulationVersion(models.Model):
    """Immutable snapshot of a formulation at save time.

    Snapshots intentionally denormalise into JSON rather than cloning
    line rows: versions are append-only history, rarely queried for
    analytics, and we avoid the foot-gun where rolling back "by FK"
    resurrects stale item references that no longer match the source
    catalogue.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="versions",
    )
    version_number = models.PositiveIntegerField(_("version number"))
    label = models.CharField(
        _("label"),
        max_length=150,
        blank=True,
        default="",
        help_text=_("Short scientist-written note (e.g. 'caffeine bumped to 200mg')."),
    )

    #: Denormalised snapshot of the formulation header at save time.
    snapshot_metadata: models.JSONField = models.JSONField(
        _("snapshot metadata"),
        default=dict,
        blank=True,
    )
    #: Denormalised snapshot of every line at save time. Each entry is
    #: ``{item_id, item_name, item_internal_code, label_claim_mg,
    #: serving_size_override, mg_per_serving, display_order, notes}``.
    snapshot_lines: models.JSONField = models.JSONField(
        _("snapshot lines"),
        default=list,
        blank=True,
    )
    #: Pre-computed totals block saved alongside the snapshot so
    #: history screens never re-run the math.
    snapshot_totals: models.JSONField = models.JSONField(
        _("snapshot totals"),
        default=dict,
        blank=True,
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_formulation_versions",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("formulation version")
        verbose_name_plural = _("formulation versions")
        ordering = ("-version_number",)
        constraints = [
            models.UniqueConstraint(
                fields=("formulation", "version_number"),
                name="formulations_version_unique_number_per_formulation",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.formulation.name} v{self.version_number}"
