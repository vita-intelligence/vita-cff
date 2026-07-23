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
from decimal import Decimal

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
    #: EU regulatory classification for the finished product. Drives
    #: which labelling rules apply on PSP + downstream compliance.
    #: NPD stores it once at the formulation level; the push cascade
    #: mirrors it into the finished-product stage's PSP spec.
    REGULATORY_CATEGORY_CHOICES = (
        ("food_supplement", _("Food supplement")),
        ("functional_food", _("Functional food")),
        ("cosmetic", _("Cosmetic")),
        ("medical_device", _("Medical device")),
    )
    regulatory_category = models.CharField(
        _("regulatory category"),
        max_length=32,
        choices=REGULATORY_CATEGORY_CHOICES,
        blank=True,
        default="",
    )
    #: Mandatory-on-label warnings text (EU 1169/2011 Art. 9(1)(j)).
    warnings_text = models.TextField(
        _("warnings text"), blank=True, default=""
    )
    #: Shelf life in months — drives the best-before stamp on the
    #: PSP finished-product side.
    shelf_life_months = models.PositiveIntegerField(
        _("shelf life (months)"), null=True, blank=True
    )
    #: Storage conditions declaration (EU 1169/2011 Art. 25).
    storage_conditions = models.TextField(
        _("storage conditions"), blank=True, default=""
    )
    #: List of ISO 3166-1 alpha-2 country codes the formulation is
    #: sold into. Empty list = no restriction declared.
    target_markets = models.JSONField(
        _("target markets"),
        default=list,
        blank=True,
    )
    #: Net quantity on the pack + its UOM. PSP resolves the UOM UUID
    #: to a local id on push; unknown UUIDs get dropped silently.
    net_quantity = models.DecimalField(
        _("net quantity"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    net_quantity_uom_uuid = models.UUIDField(
        _("net quantity UOM UUID"), null=True, blank=True
    )
    #: UOM UUID for the serving-size number (which is already an
    #: integer on this model; the pair together forms "1 capsule",
    #: "5 g", etc.).
    serving_size_uom_uuid = models.UUIDField(
        _("serving size UOM UUID"), null=True, blank=True
    )
    #: Warehouse storage tags applied to the finished-product PSP
    #: item. Free-form strings; PSP's goods-in auto-routes lots
    #: based on these tags at receive time.
    storage_tags = models.JSONField(
        _("storage tags"),
        default=list,
        blank=True,
    )
    #: Reorder-point pair mirrored to the finished-product PSP item.
    #: ``min_stock_qty`` triggers the reorder alert on PSP;
    #: ``target_stock_qty`` is the order-up-to level. Both nullable
    #: — a formulation that leaves them null simply doesn't
    #: participate in reorder tracking.
    min_stock_qty = models.DecimalField(
        _("min stock qty"),
        max_digits=14,
        decimal_places=3,
        null=True,
        blank=True,
    )
    target_stock_qty = models.DecimalField(
        _("target stock qty"),
        max_digits=14,
        decimal_places=3,
        null=True,
        blank=True,
    )
    #: Declared EU 1169 Annex II allergens on the finished product.
    #: List of PSP allergen UUIDs; the cascade forwards them to
    #: ``integration_item_controller`` which resolves + sets the M:N
    #: on the finished-product PSP item.
    allergen_uuids = models.JSONField(
        _("allergen UUIDs"),
        default=list,
        blank=True,
    )
    #: "May contain" cross-contamination declaration — list of PSP
    #: allergen ``key`` strings + a free-text justification. Both
    #: land on ``finished_product_spec.may_contain_allergens`` /
    #: ``may_contain_justification`` via the spec push.
    may_contain_allergen_keys = models.JSONField(
        _("may-contain allergen keys"),
        default=list,
        blank=True,
    )
    may_contain_justification = models.TextField(
        _("may-contain justification"),
        blank=True,
        default="",
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
    psp_finished_product_uuid = models.UUIDField(
        _("PSP finished product UUID"),
        null=True,
        blank=True,
        db_index=True,
        help_text=_(
            "PSP integration item this formulation is the recipe "
            "for — populated when a scientist picks a finished "
            "product from the 'Pick from PSP catalogue' surface on "
            "new-project creation. On every ``save_version``, NPD "
            "translates the formulation's actives + excipient picks "
            "into a BOM payload and pushes it to PSP at "
            "``PUT /api/integration/items/<uuid>/bom``, writing a "
            "fresh ``bom_version`` snapshot each save so PSP's "
            "history captures every R&D iteration. Nullable — "
            "formulations without a PSP link save + version "
            "normally, no push fires."
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
    #: Which production stage consumes this line. Optional — nullable
    #: for legacy formulations built before stages existed. On the push
    #: cascade to PSP a NULL stage is treated as belonging to the
    #: terminal (finished-product) stage so the flat-BOM behaviour
    #: remains the fallback. Set at pick time from the stage strip in
    #: the builder. ``SET_NULL`` on stage delete so removing a stage
    #: doesn't cascade-nuke the lines — they surface in a "no stage"
    #: bucket and the operator reassigns.
    stage = models.ForeignKey(
        "FormulationStage",
        on_delete=models.SET_NULL,
        related_name="lines",
        null=True,
        blank=True,
    )
    #: Provenance of this line so the routing wizard (Step 3) can
    #: differentiate operator-picked actives from compute-derived
    #: band picks (anti-caking, MCC, DCP, capsule shell, sweetener,
    #: flavour, colour, gelling, glazing, acidity, powder carrier,
    #: gummy base, premix sweetener). Both flavours persist as
    #: FormulationLine rows so per-stage BOM routing, PSP push, and
    #: version snapshots use one code path. Band picks get their
    #: mg re-derived from compute on every save; actives keep their
    #: hand-entered label_claim_mg untouched.
    SOURCE_KIND_ACTIVE = "active"
    SOURCE_KIND_BAND_PICK = "band_pick"
    #: Routing-tab manual pick — scientist added a raw material /
    #: semi-finished / packaging item directly from the Routing
    #: inventory picker (not via the Formulation-tab active picker,
    #: not via an M2M excipient band). The wizard shows an × on
    #: these rows so they can be removed inline; other kinds can
    #: only be removed from Formulation / M2M pickers.
    SOURCE_KIND_MANUAL = "manual"
    SOURCE_KIND_CHOICES = (
        (SOURCE_KIND_ACTIVE, _("Operator-picked active ingredient")),
        (SOURCE_KIND_BAND_PICK, _("Compute-derived excipient / band pick")),
        (SOURCE_KIND_MANUAL, _("Routing-tab manual pick")),
    )
    source_kind = models.CharField(
        _("source kind"),
        max_length=16,
        default=SOURCE_KIND_ACTIVE,
        choices=SOURCE_KIND_CHOICES,
        db_index=True,
    )
    #: When source_kind == 'band_pick' this identifies which excipient
    #: band the pick belongs to so the wizard can group and label
    #: rows correctly ("Anti-caking · Silicon Dioxide"). Also used
    #: by the sync service to figure out which M2M drives the row.
    #: NULL for source_kind == 'active'.
    BAND_KEY_ANTI_CAKING = "anti_caking"
    BAND_KEY_MCC = "mcc"
    BAND_KEY_DCP = "dcp"
    BAND_KEY_CAPSULE_SHELL = "capsule_shell"
    BAND_KEY_FLAVOURING = "flavouring"
    BAND_KEY_COLOUR = "colour"
    BAND_KEY_SWEETENER = "sweetener"
    BAND_KEY_GELLING = "gelling"
    BAND_KEY_GLAZING = "glazing"
    BAND_KEY_ACIDITY = "acidity"
    BAND_KEY_POWDER_CARRIER = "powder_carrier"
    BAND_KEY_GUMMY_BASE = "gummy_base"
    BAND_KEY_GUMMY_WATER = "gummy_water"
    BAND_KEY_PREMIX_SWEETENER = "premix_sweetener"
    BAND_KEY_CHOICES = (
        (BAND_KEY_ANTI_CAKING, _("Anti-caking")),
        (BAND_KEY_MCC, _("MCC carrier")),
        (BAND_KEY_DCP, _("DCP carrier")),
        (BAND_KEY_CAPSULE_SHELL, _("Capsule shell")),
        (BAND_KEY_FLAVOURING, _("Flavouring")),
        (BAND_KEY_COLOUR, _("Colour")),
        (BAND_KEY_SWEETENER, _("Sweetener")),
        (BAND_KEY_GELLING, _("Gelling agent")),
        (BAND_KEY_GLAZING, _("Glazing")),
        (BAND_KEY_ACIDITY, _("Acidity regulator")),
        (BAND_KEY_POWDER_CARRIER, _("Powder carrier")),
        (BAND_KEY_GUMMY_BASE, _("Gummy base")),
        (BAND_KEY_GUMMY_WATER, _("Gummy water")),
        (BAND_KEY_PREMIX_SWEETENER, _("Premix sweetener")),
    )
    band_key = models.CharField(
        _("band key"),
        max_length=32,
        null=True,
        blank=True,
        choices=BAND_KEY_CHOICES,
        db_index=True,
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

    # ------------------------------------------------------------------
    # Stage-scoped consumption ratio.
    #
    # For inputs that don't fit the actives-model ``label_claim_mg``
    # (per-serving) semantic — coating oils, glazes, packaging, capsule
    # shells, syrups, moisture adds — the scientist declares HOW MUCH
    # is consumed per unit of THIS LINE'S STAGE output. The compute
    # cascade walks the stage graph and resolves each stage's total
    # output mass/count, then multiplies by the ratio to land at
    # per-1-finished-unit BOM quantities without the scientist having
    # to do the algebra.
    #
    # Anchoring on the *stage* rather than the finished product means
    # a coating-oil line on the "coat" stage doesn't drift when yields
    # change or when a mid-stage semi feeds a downstream cascade — the
    # ratio is a property of the local stage, not of the whole recipe.
    #
    # Modes:
    #   * ``none``               — line uses label_claim_mg (actives).
    #                              Default for source_kind='active'.
    #   * ``per_unit``           — quantity per 1 output *count* of the
    #                              stage (bottles, labels, capsule
    #                              shells, "1 per finished unit").
    #   * ``percent_of_mass``    — % of the stage's total output mass
    #                              (coatings, glazes, syrups: "3%").
    #
    # ``stage_ratio_value``:
    #   * per_unit → quantity in the item's PSP UOM per 1 stage output
    #     unit. Typically 1.0 for bottles/labels; a decimal for
    #     fractional secondary packs (0.0833 = 1 per 12).
    #   * percent_of_mass → the percentage (5.0 = 5%, not 0.05).
    #
    # Immutability: once the linked spec sheet crosses ``approved``,
    # both fields freeze (enforced at the service layer, matching
    # traceability rules in CLAUDE.md).
    # ------------------------------------------------------------------
    STAGE_RATIO_MODE_NONE = "none"
    STAGE_RATIO_MODE_PER_UNIT = "per_unit"
    STAGE_RATIO_MODE_PERCENT_OF_MASS = "percent_of_mass"
    STAGE_RATIO_MODE_CHOICES = (
        (STAGE_RATIO_MODE_NONE, _("No ratio (actives use label claim)")),
        (STAGE_RATIO_MODE_PER_UNIT, _("Per 1 output unit of stage")),
        (STAGE_RATIO_MODE_PERCENT_OF_MASS, _("% of stage output mass")),
    )
    stage_ratio_mode = models.CharField(
        _("stage ratio mode"),
        max_length=24,
        default=STAGE_RATIO_MODE_NONE,
        choices=STAGE_RATIO_MODE_CHOICES,
    )
    stage_ratio_value = models.DecimalField(
        _("stage ratio value"),
        max_digits=14,
        decimal_places=6,
        null=True,
        blank=True,
        help_text=_(
            "per_unit: qty in the item's UOM per 1 stage output unit. "
            "percent_of_mass: percentage (5 = 5%, not 0.05)."
        ),
    )

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


class FormulationStage(models.Model):
    """One production stage on a formulation.

    Formulations are made in stages: a capsule product = *Powder Blend*
    (blend actives + excipients) → *Encapsulate* (fill shells) →
    *Bottle* (pack into container) → *Label*. Each non-terminal stage
    outputs a semi-finished item; the next stage consumes it.

    A stage carries the workstation group that runs it (a pointer at
    PSP's ``workstation_groups`` table) + setup/cycle time + fixed/
    variable cost that override the workstation-group defaults. When
    NPD pushes the formulation to PSP:

    * Each non-terminal stage becomes its own PSP semi-finished item
      + BOM + Routing. ``psp_semi_finished_uuid`` caches the PSP-side
      UUID after the first successful push so subsequent pushes hit
      the same row (idempotency via ``external_sku``).
    * The terminal stage becomes the finished product's own BOM +
      Routing; it consumes the prior stages' semi-finished outputs
      instead of raw materials directly.

    ``sort_order`` defines the flow — the stage with the lowest
    ``sort_order`` runs first; the highest is the terminal stage.
    """

    #: Well-known template keys — used to seed a default graph based
    #: on the formulation's dosage form. Every stage carries one so
    #: the FE can render a suitable icon / colour without matching on
    #: the free-text name. ``custom`` covers user-added stages that
    #: don't fit a known template.
    class StageKey(models.TextChoices):
        BLEND = "blend", _("Blend")
        ENCAPSULATE = "encapsulate", _("Encapsulate")
        BOTTLE = "bottle", _("Bottle")
        LABEL = "label", _("Label")
        FILL = "fill", _("Fill")
        COOK = "cook", _("Cook")
        DEPOSIT = "deposit", _("Deposit")
        CURE = "cure", _("Cure")
        COAT = "coat", _("Coat")
        PACKAGE = "package", _("Package")
        CUSTOM = "custom", _("Custom")

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="stages",
    )
    sort_order = models.PositiveIntegerField(_("sort order"), default=0)
    name = models.CharField(_("name"), max_length=120)
    stage_key = models.CharField(
        _("stage key"),
        max_length=32,
        choices=StageKey.choices,
        default=StageKey.CUSTOM,
    )
    #: PSP ``WorkstationGroup`` UUID this stage runs on. Nullable —
    #: operator may draft a stage before picking the machine. The
    #: builder's picker fetches the list from PSP's
    #: ``/api/integration/workstation-groups`` endpoint.
    workstation_group_uuid = models.UUIDField(
        _("PSP workstation group UUID"),
        null=True,
        blank=True,
        db_index=True,
    )
    #: Snapshot of the workstation group's display name at pick time.
    #: Rendered when PSP is unreachable so the stage strip still
    #: shows something meaningful. Refreshed on every successful push
    #: alongside ``psp_semi_finished_uuid``.
    workstation_group_name = models.CharField(
        _("workstation group name (snapshot)"),
        max_length=200,
        blank=True,
        default="",
    )
    #: Free-text operation description shown on the PSP routing
    #: detail page + on shop-floor MO cards. Auto-fills to the
    #: workstation group's ``default_operation_notes`` on the PSP
    #: side when blank. Distinct from :attr:`notes`, which is an
    #: internal comment the operator uses on NPD only.
    operation_description = models.TextField(
        _("operation description"), blank=True, default=""
    )
    setup_time_min = models.DecimalField(
        _("setup time (minutes)"),
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
    )
    cycle_time_min = models.DecimalField(
        _("cycle time (minutes)"),
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
    )
    fixed_cost = models.DecimalField(
        _("fixed cost"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    variable_cost = models.DecimalField(
        _("variable cost"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    #: Number of parallel workstations available for this operation.
    #: Mirrors PSP's ``routing_step.capacity`` — the scheduler uses
    #: it to cap concurrent operator time. Positive-only.
    capacity = models.DecimalField(
        _("capacity"),
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
    )
    #: Routing-header overhead — fixed + variable costs that aren't
    #: tied to a specific operation step. Mirrors PSP's
    #: ``routings.other_fixed_cost`` + ``other_variable_cost``.
    #: ``other_variable_cost_basis`` is the quantity the variable
    #: cost scales against (default 1 = per unit of output).
    other_fixed_cost = models.DecimalField(
        _("other fixed cost"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    other_variable_cost = models.DecimalField(
        _("other variable cost"),
        max_digits=12,
        decimal_places=4,
        null=True,
        blank=True,
    )
    other_variable_cost_basis = models.DecimalField(
        _("other variable cost basis"),
        max_digits=10,
        decimal_places=2,
        null=True,
        blank=True,
    )
    #: Default workers assigned to this stage's operation. Each entry
    #: is a PSP ``User`` UUID (the workers picker in the stage details
    #: fetches from PSP's ``GET /api/integration/users``). Forwarded
    #: to PSP as ``default_worker_uuids`` on the routing step so the
    #: shop-floor MO starts with the crew already assigned. Empty list
    #: = no default crew; scheduler falls back to whoever's on shift.
    worker_psp_uuids = models.JSONField(
        _("worker PSP UUIDs"),
        default=list,
        blank=True,
    )
    #: PSP semi-finished item this stage outputs. NULL until the
    #: first successful push. On subsequent pushes NPD uses this to
    #: skip re-creating the item + hits the same routing / BOM rows.
    #: Terminal (finished-product) stages leave this NULL — the
    #: finished-product item lives on
    #: :attr:`Formulation.psp_finished_product_uuid`.
    psp_semi_finished_uuid = models.UUIDField(
        _("PSP semi-finished item UUID"),
        null=True,
        blank=True,
        db_index=True,
    )
    #: PSP BOM UUID this stage's push landed on. Captured from PSP's
    #: ``put_bom`` response so the Preview tab's stage-title link can
    #: navigate to the actual BOM page (``/production/boms/<uuid>``)
    #: instead of a filtered search URL (PSP's BOM list doesn't
    #: respect ``?item_id=`` at the moment, so search-style deep
    #: links opened the full list). NULL until the first successful
    #: BOM push for this stage.
    psp_bom_uuid = models.UUIDField(
        _("PSP BOM UUID"),
        null=True,
        blank=True,
        db_index=True,
    )
    #: PSP item identity — the scientist's explicit call on how this
    #: stage manifests on PSP. Previously the item_type was inferred
    #: from position (last stage → finished_product, rest →
    #: semi_finished). Making it a first-class field lets scientists
    #: pick per stage; the cascade honours the pick instead of
    #: guessing from ``sort_order``. Enforced to exactly one
    #: ``finished_product`` per formulation at save time.
    PSP_ITEM_TYPE_CHOICES = (
        ("semi_finished", _("Semi-finished")),
        ("finished_product", _("Finished product")),
    )
    psp_item_type = models.CharField(
        _("PSP item type"),
        max_length=20,
        choices=PSP_ITEM_TYPE_CHOICES,
        default="semi_finished",
    )
    #: Override for the PSP item's display name. Blank falls back to
    #: the auto-derived ``{formulation.code} — {stage.name}`` the
    #: cascade has always used. When set, ships verbatim to PSP so
    #: scientists can override the label without contaminating the
    #: NPD-side stage name (which drives internal identifiers, BOM
    #: previews, and printed cards).
    psp_item_name = models.CharField(
        _("PSP item name"),
        max_length=200,
        blank=True,
        default="",
    )
    #: Explicit external SKU for the PSP item this stage produces. NULL
    #: falls back to the auto-generated ``NPD-STAGE-<id>-<sort_order>``
    #: (semi-finished) / ``NPD-FINISHED-<id>`` (finished-product) key
    #: the push cascade has always used, so legacy stages keep syncing.
    #: When set, the value is used verbatim as PSP's ``external_sku``
    #: — scientists can align it with their own SKU vocabulary.
    psp_item_external_sku = models.CharField(
        _("PSP external SKU"),
        max_length=100,
        blank=True,
        default="",
    )
    #: Free-text description shown on the PSP item detail page. Empty
    #: falls back to the auto-generated "Auto-created by NPD…" line.
    psp_item_description = models.TextField(
        _("PSP description"),
        blank=True,
        default="",
    )
    #: Custom-attributes bag mirrored to the PSP item's ``attributes``
    #: JSON column. Same shape scientists use on PSP's own item form
    #: (``use_as``, ``capsule_size``, ``shell_weight_mg``,
    #: ``extract_ratio`` …). Empty = no override; the PSP row keeps
    #: whatever it had. Downstream compute (NPD's own math) reads
    #: these too, so tweaking here changes both what NPD calculates
    #: and what PSP publishes.
    psp_item_attributes = models.JSONField(
        _("PSP item attributes"),
        default=dict,
        blank=True,
    )
    #: Barcode (GTIN-8 / 13 / 14) shown on the PSP item and used by
    #: goods-in scanning. Blank = no barcode. Validated at PSP save
    #: time; NPD forwards verbatim.
    psp_item_barcode = models.CharField(
        _("PSP barcode"),
        max_length=32,
        blank=True,
        default="",
    )
    #: PSP unit-of-measurement UUID the stage's output ships in
    #: (kg, mg, capsules, bottles, …). NPD fetches the catalogue from
    #: PSP's ``/api/integration/units-of-measurement`` picker; the
    #: cascade forwards the uuid on ``create_item`` and PSP resolves
    #: to its local FK id. NULL = leave whatever PSP already has.
    psp_item_stock_uom_uuid = models.UUIDField(
        _("PSP stock UOM UUID"),
        null=True,
        blank=True,
    )
    #: PSP product-family UUID the stage's output belongs to. Same
    #: mechanic as ``psp_item_stock_uom_uuid``. NULL = leave existing.
    psp_item_product_family_uuid = models.UUIDField(
        _("PSP product family UUID"),
        null=True,
        blank=True,
    )
    #: Finished-product spec bag mirrored to PSP's
    #: ``item_finished_product_spec`` sub-table. Only meaningful when
    #: this stage's ``psp_item_type == "finished_product"`` — the
    #: finished stage is the shipping product; semi-finished blends
    #: don't need EU 1169-style labelling data.
    #:
    #: Shape (all keys optional; missing = leave PSP's existing value
    #: alone):
    #:   * regulatory_category — food_supplement | functional_food |
    #:     cosmetic | medical_device
    #:   * dosage_form — capsule | tablet | powder | liquid | gummy |
    #:     other
    #:   * net_quantity — decimal, unit selected by
    #:     ``net_quantity_uom_uuid``
    #:   * net_quantity_uom_uuid — PSP UOM uuid
    #:   * serving_size — decimal, unit selected by
    #:     ``serving_size_uom_uuid``
    #:   * serving_size_uom_uuid — PSP UOM uuid
    #:   * servings_per_pack — integer
    #:   * directions_of_use — string
    #:   * suggested_dosage — string
    #:   * warnings_text — string
    #:   * shelf_life_months — integer
    #:   * storage_conditions — string
    #:   * target_markets — list of ISO 3166-1 alpha-2 codes
    psp_finished_product_spec = models.JSONField(
        _("PSP finished-product spec"),
        default=dict,
        blank=True,
    )
    notes = models.TextField(_("notes"), blank=True, default="")

    #: How many finished-good SERVINGS equal 1 stock-unit of this
    #: stage's PSP output item. Bridges NPD's per-serving mg values
    #: to PSP's "qty per 1 unit of parent" BOM convention.
    #:
    #: Worked example (500 mg capsule, 60 caps per bottle):
    #:   * Blending semi (Blend stocked in kg, 1 kg = 2000 servings):
    #:     ``servings_per_output_unit = 2000``
    #:   * Encapsulation finished (1 bottle = 60 servings):
    #:     ``servings_per_output_unit = 60``
    #:
    #: Push cascade converts:
    #:   ``psp_bom_line.qty = mg_per_serving
    #:                       × servings_per_output_unit
    #:                       × unit_factor(child_stock_uom)``
    #: where ``unit_factor`` maps mg → the child item's stock UoM
    #: (kg = 1e-6, g = 1e-3, mg = 1, count-based = 1).
    #:
    #: Default 1.0 preserves legacy behavior (numbers happen to work
    #: when every semi is stocked in "unit" and 1 unit = 1 serving).
    #: Scientists override per stage on the Stages tab.
    servings_per_output_unit = models.DecimalField(
        _("servings per output unit"),
        max_digits=12,
        decimal_places=4,
        default=Decimal("1.0000"),
    )

    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("formulation stage")
        verbose_name_plural = _("formulation stages")
        ordering = ("formulation", "sort_order")
        constraints = [
            models.UniqueConstraint(
                fields=("formulation", "sort_order"),
                name="uniq_formulation_stage_sort_order",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.formulation_id}#{self.sort_order} {self.name}"


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
    #: FE-computed per-stage BOM snapshot, keyed by stage uuid. Each
    #: entry is a list of ``{item_id, mg, sort_order, label, code}``
    #: rows representing what that stage's PSP item held at save
    #: time — actives assigned to the stage, plus excipient bands
    #: on the terminal stage, plus the synthesized "1× prior semi"
    #: link. History rehydration replays this back into the strip so
    #: the operator sees the exact BOM composition each version
    #: shipped with, even if the stage graph mutates later.
    snapshot_stage_boms: models.JSONField = models.JSONField(
        _("snapshot stage BOMs"),
        default=dict,
        blank=True,
    )

    #: True when this version was auto-cut on a ``Save draft`` (silent
    #: snapshot for full-history revert). False = scientist-triggered
    #: ``Save version`` — the milestones that show up in the Versions
    #: sub-tab by default. Auto-versions live in the same table so
    #: rollback + snapshot-BOM push cascades reuse the same code path;
    #: the History tab just filters them out for the milestone view.
    is_auto = models.BooleanField(
        _("auto-cut on save draft"),
        default=False,
        db_index=True,
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


class FormulationPhoto(models.Model):
    """Marketing / spec photo attached to a formulation.

    Photos live on NPD's own storage so the scientist gets instant
    persistence + preview. On sync the push cascade forwards any row
    with a null ``psp_uuid`` to PSP's finished-product item — the uuid
    the response returns caches back onto this row so re-syncs skip it.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="photos",
    )
    image = models.ImageField(
        _("image"),
        upload_to="formulation-photos/",
    )
    caption = models.CharField(
        _("caption"),
        max_length=200,
        blank=True,
        default="",
    )
    is_primary = models.BooleanField(
        _("is primary"),
        default=False,
        help_text=_(
            "Marks the hero shot used on catalog cards + label "
            "previews. Enforced single-primary in the service layer."
        ),
    )
    sort_order = models.PositiveIntegerField(
        _("sort order"),
        default=0,
    )
    original_filename = models.CharField(max_length=200, blank=True, default="")
    content_type = models.CharField(max_length=80, blank=True, default="")
    byte_size = models.PositiveIntegerField(default=0)

    psp_uuid = models.UUIDField(
        _("PSP item image UUID"),
        null=True,
        blank=True,
        help_text=_(
            "UUID PSP returned when this photo was first pushed to "
            "the finished-product item. Idempotency marker — a "
            "non-null value means PSP already has it, so re-syncs "
            "skip re-uploading."
        ),
    )

    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="+",
    )
    uploaded_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("formulation photo")
        verbose_name_plural = _("formulation photos")
        ordering = ("-is_primary", "sort_order", "uploaded_at")
        indexes = [
            models.Index(fields=("formulation", "-is_primary", "sort_order")),
        ]

    def __str__(self) -> str:
        return f"{self.formulation.name} · photo {self.id}"


class FormulationFile(models.Model):
    """Compliance file (spec sheet, DoC, migration test, …) attached
    to a formulation. Same push-cascade model as photos — mirror uuid
    on ``psp_uuid`` gates re-syncs.
    """

    class Kind(models.TextChoices):
        SPEC_SHEET = "spec_sheet", _("Spec sheet")
        FOOD_CONTACT_DECLARATION = (
            "food_contact_declaration",
            _("Food-contact declaration"),
        )
        MIGRATION_TEST = "migration_test", _("Migration test")
        SAFETY_DATA_SHEET = "safety_data_sheet", _("Safety data sheet")
        ALLERGEN_DECLARATION = "allergen_declaration", _("Allergen declaration")
        NUTRITIONAL_ANALYSIS = "nutritional_analysis", _("Nutritional analysis")
        OTHER = "other", _("Other")

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="files",
    )
    file = models.FileField(
        _("file"),
        upload_to="formulation-files/",
    )
    kind = models.CharField(
        _("kind"),
        max_length=32,
        choices=Kind.choices,
        default=Kind.OTHER,
    )
    filename = models.CharField(max_length=255)
    mime = models.CharField(max_length=120)
    byte_size = models.PositiveIntegerField()

    psp_uuid = models.UUIDField(
        _("PSP item file UUID"),
        null=True,
        blank=True,
        help_text=_(
            "UUID PSP returned when this file was first pushed to "
            "the finished-product item. Idempotency marker."
        ),
    )

    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="+",
    )
    uploaded_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("formulation file")
        verbose_name_plural = _("formulation files")
        ordering = ("-uploaded_at",)
        indexes = [
            models.Index(fields=("formulation", "-uploaded_at")),
        ]

    def __str__(self) -> str:
        return f"{self.formulation.name} · {self.kind} · {self.filename}"


class FormulationCertificate(models.Model):
    """Per-formulation certificate attachment. Mirrors the PSP
    ``item_certificates`` shape so ``_push_psp_certificates`` can
    replay every attach on the finished-product item after the BOM
    push — a scientist ticks certs on the NPD Setup panel and they
    show up in the item-detail Certificates section on PSP.

    The certificate registry itself is managed inside PSP; NPD only
    stores a reference to the cert's UUID plus per-attachment fields
    (number, validity window). ``psp_attachment_uuid`` is set on
    first successful push and gates re-syncs — a cascade skips rows
    with a non-null value so restarts are idempotent.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    formulation = models.ForeignKey(
        Formulation,
        on_delete=models.CASCADE,
        related_name="certificates",
    )

    # Certificate registry pointer (canonical UUID from PSP).
    psp_certificate_uuid = models.UUIDField(_("PSP certificate UUID"))
    # Denormalized for display without a PSP round-trip. Refreshed on
    # each attach save via a re-fetch of the catalog.
    psp_certificate_name = models.CharField(
        _("certificate name"),
        max_length=200,
    )
    psp_certificate_type = models.CharField(
        _("certificate type"),
        max_length=64,
        blank=True,
        default="",
    )
    psp_issuing_body = models.CharField(
        _("issuing body"),
        max_length=200,
        blank=True,
        default="",
    )

    # Per-attachment fields (mirror the PSP ItemCertificate form).
    certificate_number = models.CharField(
        _("certificate number"),
        max_length=200,
        blank=True,
        default="",
    )
    valid_from = models.DateField(_("valid from"), null=True, blank=True)
    valid_until = models.DateField(_("valid until"), null=True, blank=True)

    # Idempotency marker — set on first successful push, cleared when
    # PSP DELETE succeeds (soft-cascade). Non-null = attachment lives
    # on PSP with this UUID.
    psp_attachment_uuid = models.UUIDField(
        _("PSP attachment UUID"),
        null=True,
        blank=True,
        help_text=_(
            "UUID PSP returned when this cert was first attached to "
            "the finished-product item. Idempotency marker."
        ),
    )

    attached_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="+",
    )
    attached_at = models.DateTimeField(default=timezone.now, editable=False)

    class Meta:
        verbose_name = _("formulation certificate")
        verbose_name_plural = _("formulation certificates")
        ordering = ("psp_certificate_name",)
        constraints = [
            # A given PSP cert can only be attached once per
            # formulation — mirrors the PSP-side ``item_certificates``
            # (item_id, certificate_id) uniqueness.
            models.UniqueConstraint(
                fields=("formulation", "psp_certificate_uuid"),
                name="unique_formulation_certificate",
            ),
        ]
        indexes = [
            models.Index(fields=("formulation",)),
        ]

    def __str__(self) -> str:
        return f"{self.formulation.name} · {self.psp_certificate_name}"


class FormulationStageTemplate(models.Model):
    """Per-organization reusable stage graph — scientists pick one on
    project create (or apply to an existing formulation) to seed the
    stages tab without re-typing the same 3-5 rows every time.

    ``stages_json`` is a list of dicts matching the UpsertStageInput
    payload the wholesale-replace endpoint accepts, so applying a
    template is a straight pass-through to ``set_formulation_stages``.

    Templates are org-owned so an admin can tailor the default set to
    their workflow (rename "Blend" to "Compound", swap in the org's
    real workstation UUIDs, add a "QC Sampling" stage before Bottle).
    A seed migration lands sensible defaults for every dosage form
    on every existing org so nothing starts empty.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.CASCADE,
        related_name="formulation_stage_templates",
    )
    name = models.CharField(
        _("template name"),
        max_length=200,
    )
    description = models.TextField(
        _("description"),
        blank=True,
        default="",
        help_text=_(
            "Short human-readable summary shown next to the template "
            "in the picker (e.g. 'Standard 3-stage capsule route')."
        ),
    )
    #: Optional dosage-form hint. When set, the new-formulation dialog
    #: auto-suggests this template as the operator picks a matching
    #: dosage form. Blank = template shows for every dosage form.
    dosage_form = models.CharField(
        _("dosage form hint"),
        max_length=32,
        choices=DosageFormChoices.choices,
        blank=True,
        default="",
    )
    #: Ordered list of stage payloads. Shape mirrors
    #: :class:`UpsertStageInput` on the FE so apply is a straight
    #: pass-through with no field renaming.
    stages_json: models.JSONField = models.JSONField(
        _("stages"),
        default=list,
        blank=True,
    )
    #: Marks templates that came from the initial seed migration so
    #: the UI can prevent accidental deletion of the reference set
    #: (admins can still delete them via the settings CRUD when they
    #: want to prune, but the default guardrail is on).
    is_seeded = models.BooleanField(
        _("is seeded"),
        default=False,
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="+",
    )
    created_at = models.DateTimeField(default=timezone.now, editable=False)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("formulation stage template")
        verbose_name_plural = _("formulation stage templates")
        ordering = ("name",)
        constraints = [
            models.UniqueConstraint(
                fields=("organization", "name"),
                name="formulation_stage_template_unique_name_per_org",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.organization_id})"
