"""Serializers for the formulations API."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.formulations.models import (
    DosageFormChoices,
    Formulation,
    FormulationLine,
    FormulationStage,
    FormulationVersion,
    PowderTypeChoices,
    ProjectStatus,
    ProjectType,
)


class FormulationStageReadSerializer(serializers.ModelSerializer):
    """Per-stage read shape emitted on the formulation detail
    response. Mirrors the FE builder's stage-strip cards 1:1 — the
    picker fetches PSP's ``/api/integration/workstation-groups``
    separately for the "run on" dropdown; here we just carry the
    stored UUID + the snapshot name so the strip can render even
    when PSP is unreachable.
    """

    class Meta:
        model = FormulationStage
        fields = (
            "id",
            "sort_order",
            "name",
            "stage_key",
            "workstation_group_uuid",
            "workstation_group_name",
            "operation_description",
            "setup_time_min",
            "cycle_time_min",
            "fixed_cost",
            "variable_cost",
            "capacity",
            "other_fixed_cost",
            "other_variable_cost",
            "other_variable_cost_basis",
            "worker_psp_uuids",
            "psp_semi_finished_uuid",
            "psp_bom_uuid",
            "psp_item_type",
            "psp_item_name",
            "psp_item_external_sku",
            "psp_item_description",
            "psp_item_attributes",
            "psp_item_barcode",
            "psp_item_stock_uom_uuid",
            "psp_item_product_family_uuid",
            "psp_finished_product_spec",
            "servings_per_output_unit",
            "notes",
        )
        read_only_fields = fields


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


def _user_chip(user) -> dict[str, str] | None:
    """Flat ``{id, email, name}`` projection of a user FK for the
    project read serializer's owner chips (sales person, lead
    scientist). ``name`` falls back to email so accounts without a
    display name still render something human-readable.
    """

    if user is None:
        return None
    full_name = getattr(user, "full_name", "") or getattr(
        user, "get_full_name", lambda: ""
    )()
    return {
        "id": str(user.id),
        "email": user.email,
        "name": (full_name or user.email).strip(),
    }


class FormulationLineReadSerializer(serializers.ModelSerializer):
    #: Polymorphic identity — every ``item_*`` field below routes
    #: through the ``effective_item_*`` properties so a local-
    #: sourced line and a PSP-sourced line serialise to the same
    #: wire shape. FE consumers don't need to branch on source.
    item_name = serializers.SerializerMethodField()
    item_internal_code = serializers.SerializerMethodField()
    #: The PSP UUID this line's item mirrors, resolved off either the
    #: local ``Item.psp_source_uuid`` (local-sourced lines) or the
    #: ``psp_item_uuid`` snapshot on the line itself (PSP-sourced).
    #: Drives the "Open on PSP" deep-link from every downstream
    #: display (fine-tune / stage BOM / routing) without the caller
    #: having to branch on ``item_source``. ``null`` when neither
    #: side has a PSP identity (fully local + never mirrored).
    item_psp_source_uuid = serializers.SerializerMethodField()
    item_attributes = serializers.SerializerMethodField()
    #: Item's stock UoM string (``"kg"``, ``"g"``, ``"l"``, ``"ml"``,
    #: ``"unit"``, ``"ea"``, …). Feeds the FE ratio compute so a
    #: stage-scoped ``per_unit`` ratio at a mass-UoM item resolves to
    #: the right per-serving mg. Empty when the item is a PSP
    #: snapshot that didn't capture unit — the FE falls back to a
    #: unit_factor of 1 (count semantic).
    item_unit = serializers.SerializerMethodField()
    #: Source discriminator surfaced so the FE picker can decide
    #: whether to render a local Item edit link or a PSP deep-link.
    #: Every existing row is ``"local"`` after migration 0036.
    item_source = serializers.CharField(read_only=True)
    #: PSP UUID for lines with ``item_source == "psp"``; ``null``
    #: on local-sourced lines.
    psp_item_uuid = serializers.UUIDField(read_only=True, allow_null=True)
    #: Stage this line runs in — ``null`` on legacy lines that
    #: predate the stages model. The FE groups lines by stage in
    #: the builder; NULL bucket rides along with the terminal stage
    #: at push time.
    stage_id = serializers.SerializerMethodField()

    class Meta:
        model = FormulationLine
        fields = (
            "id",
            "item",
            "item_name",
            "item_internal_code",
            "item_psp_source_uuid",
            "item_attributes",
            "item_source",
            "psp_item_uuid",
            "stage_id",
            "source_kind",
            "band_key",
            "display_order",
            "label_claim_mg",
            "serving_size_override",
            "purity_override",
            "overage_override",
            "extract_ratio_override",
            "mg_per_serving_cached",
            "notes",
            "stage_ratio_mode",
            "stage_ratio_value",
            "item_unit",
        )
        read_only_fields = fields

    def get_stage_id(self, obj: FormulationLine) -> str | None:
        return str(obj.stage_id) if obj.stage_id else None

    def get_item_name(self, obj: FormulationLine) -> str:
        return obj.effective_item_name

    def get_item_internal_code(self, obj: FormulationLine) -> str:
        return obj.effective_item_internal_code

    def get_item_unit(self, obj: FormulationLine) -> str:
        # Local-sourced: read off the catalogue Item's ``unit`` column.
        # PSP-sourced: pull from the snapshot's ``unit`` key when the
        # picker captured it (older snapshots may not). Empty string
        # is the safe fallback — the FE ratio compute treats missing
        # as "count semantic" (unit_factor = 1).
        if obj.item_source == "psp":
            snap = obj.psp_item_snapshot or {}
            return str(snap.get("unit") or "").strip().lower()
        item = getattr(obj, "item", None)
        return str(getattr(item, "unit", "") or "").strip().lower()

    def get_item_psp_source_uuid(self, obj: FormulationLine) -> str | None:
        # PSP-sourced lines carry the identity on the line itself; the
        # local Item.psp_source_uuid field is null in that path.
        psp_uuid = getattr(obj, "psp_item_uuid", None)
        if psp_uuid:
            return str(psp_uuid)
        item = getattr(obj, "item", None)
        source = getattr(item, "psp_source_uuid", None) if item else None
        return str(source) if source else None

    def get_item_attributes(self, obj: FormulationLine) -> dict[str, object]:
        """Return the attributes the formulation math + label copy need.

        The full ``item.attributes`` JSON blob can be dozens of fields
        wide (nutrition, risk scores, allergens). Here we surface the
        subset the client uses to run its live cascade — math inputs
        (``type``, ``purity``, ``extract_ratio``, ``overage``), label
        copy (``ingredient_list_name``, ``nutrition_information_name``),
        and the four compliance flags — so the response payload stays
        small while still letting the builder render totals,
        compliance chips, and the ingredient declaration without an
        extra round-trip per line.
        """

        attributes = obj.effective_item_attributes
        return {
            "type": attributes.get("type"),
            "purity": attributes.get("purity"),
            "extract_ratio": attributes.get("extract_ratio"),
            "overage": attributes.get("overage"),
            "ingredient_list_name": attributes.get("ingredient_list_name"),
            "nutrition_information_name": attributes.get(
                "nutrition_information_name"
            ),
            # ``use_as`` classifier — Active / Acidity Regulator /
            # Sweeteners / etc. The builder mirrors the server's
            # ``item_missing_use_as`` warning live (without waiting
            # for a save round-trip) so blank-use_as items surface in
            # the viability panel as you add them.
            "use_as": attributes.get("use_as"),
            # PSP's item-level type (``raw_material`` / ``packaging`` /
            # ``semi_finished`` / ``finished_product``). Only populated
            # on PSP-mirrored items. The Builder readiness check reads
            # this to require at least one packaging line before Spec
            # sheets unlocks.
            "psp_item_type": attributes.get("psp_item_type"),
            "vegan": attributes.get("vegan"),
            "organic": attributes.get("organic"),
            "halal": attributes.get("halal"),
            "kosher": attributes.get("kosher"),
            # Allergen data — drives the builder's live allergen row
            # in the Compliance panel + bolded entries in the live
            # ingredient declaration. Stored as the same ``Yes/No``
            # + free-text strings the spec sheet snapshot uses.
            "allergen": attributes.get("allergen"),
            "allergen_source": attributes.get("allergen_source"),
            # Nutrient Reference Value in mg — the builder divides the
            # ingredient's label claim by this to surface ``%NRV`` next
            # to each line. Stored as the same tolerant ``text``/``N/A``
            # string the Excel workbook emits.
            "nrv_mg": attributes.get("nrv_mg"),
        }


class FormulationReadSerializer(serializers.ModelSerializer):
    lines = FormulationLineReadSerializer(many=True, read_only=True)
    stages = FormulationStageReadSerializer(many=True, read_only=True)
    sales_person = serializers.SerializerMethodField()
    lead_scientist = serializers.SerializerMethodField()
    gummy_base_item_ids = serializers.SerializerMethodField()
    gummy_base_items = serializers.SerializerMethodField()
    flavouring_item_ids = serializers.SerializerMethodField()
    flavouring_items = serializers.SerializerMethodField()
    colour_item_ids = serializers.SerializerMethodField()
    colour_items = serializers.SerializerMethodField()
    sweetener_item_ids = serializers.SerializerMethodField()
    sweetener_items = serializers.SerializerMethodField()
    glazing_item_ids = serializers.SerializerMethodField()
    glazing_items = serializers.SerializerMethodField()
    gelling_item_ids = serializers.SerializerMethodField()
    gelling_items = serializers.SerializerMethodField()
    premix_sweetener_item_ids = serializers.SerializerMethodField()
    premix_sweetener_items = serializers.SerializerMethodField()
    acidity_item_ids = serializers.SerializerMethodField()
    acidity_items = serializers.SerializerMethodField()
    capsule_shell_item_ids = serializers.SerializerMethodField()
    capsule_shell_items = serializers.SerializerMethodField()
    mcc_carrier_item_ids = serializers.SerializerMethodField()
    mcc_carrier_items = serializers.SerializerMethodField()
    dcp_carrier_item_ids = serializers.SerializerMethodField()
    dcp_carrier_items = serializers.SerializerMethodField()
    anti_caking_item_ids = serializers.SerializerMethodField()
    anti_caking_items = serializers.SerializerMethodField()
    powder_carrier_item_ids = serializers.SerializerMethodField()
    powder_carrier_items = serializers.SerializerMethodField()
    #: Auto-derived from ingredient allergen tags — Setup tab pre-
    #: checks these on the allergen matrix; scientist overrides via
    #: ``allergen_uuids`` above.
    derived_allergen_keys = serializers.SerializerMethodField()
    derived_allergen_uuids = serializers.SerializerMethodField()
    #: Trial-batch gate status — deposit paid / pending / not required.
    #: FE reads this on the project detail page to render the banner
    #: and to disable the "New trial batch" button. Same blob shape
    #: as :func:`apps.payments.services.trial_batch_gate_status`.
    deposit_gate = serializers.SerializerMethodField()
    packaging_combos_count = serializers.SerializerMethodField()
    #: Gate for RTG publish. Flips true when this project has a
    #: FINAL-kind spec sheet in ``approved`` / ``sent`` / ``accepted``
    #: status — the workflow definition of "the product is finished
    #: and ready to be sold." The publish panel disables its Publish
    #: button until this is true so scientists can't accidentally
    #: expose an unfinished SKU on the customer catalog.
    has_approved_final_spec = serializers.SerializerMethodField()
    #: Photos on the RTG catalog storefront (``purpose='catalog'``).
    #: Ordered primary-first so the FE gallery + portal can pluck the
    #: hero without extra sorting. Photos on the internal Setup tab
    #: (``purpose='internal'``) surface via a separate endpoint —
    #: they're deliberately not on this payload to keep the RTG panel
    #: read-model focused.
    catalog_photos = serializers.SerializerMethodField()

    class Meta:
        model = Formulation
        fields = (
            "id",
            "code",
            "name",
            "description",
            "dosage_form",
            "capsule_size",
            "tablet_size",
            "serving_size",
            "servings_per_pack",
            "target_fill_weight_mg",
            "powder_type",
            "water_volume_ml",
            "gummy_base_item_ids",
            "gummy_base_items",
            "flavouring_item_ids",
            "flavouring_items",
            "colour_item_ids",
            "colour_items",
            "sweetener_item_ids",
            "sweetener_items",
            "glazing_item_ids",
            "glazing_items",
            "gelling_item_ids",
            "gelling_items",
            "premix_sweetener_item_ids",
            "premix_sweetener_items",
            "acidity_item_ids",
            "acidity_items",
            "capsule_shell_item_ids",
            "capsule_shell_items",
            "mcc_carrier_item_ids",
            "mcc_carrier_items",
            "dcp_carrier_item_ids",
            "dcp_carrier_items",
            "anti_caking_item_ids",
            "anti_caking_items",
            "powder_carrier_item_ids",
            "powder_carrier_items",
            "excipient_overrides",
            "directions_of_use",
            "suggested_dosage",
            "appearance",
            "disintegration_spec",
            # Finished-product spec — Setup tab is source of truth,
            # cascade mirrors these to the finished stage's PSP spec.
            "regulatory_category",
            "warnings_text",
            "shelf_life_months",
            "storage_conditions",
            "target_markets",
            "net_quantity",
            "net_quantity_uom_uuid",
            "serving_size_uom_uuid",
            # Phase 4a
            "storage_tags",
            "min_stock_qty",
            "target_stock_qty",
            "allergen_uuids",
            "derived_allergen_keys",
            "derived_allergen_uuids",
            "may_contain_allergen_keys",
            "may_contain_justification",
            "project_status",
            "project_type",
            "approved_version_number",
            "sales_person",
            "lead_scientist",
            "deposit_gate",
            "lines",
            "stages",
            # Ready-to-Go marketing block. Empty / default on Custom
            # rows; the FE only mounts the publish panel when
            # ``project_type=='ready_to_go'`` so the extra fields
            # never surface on a Custom detail page.
            # PSP integration link — the finished-product Item on
            # PSP this formulation is the recipe for. Populated by
            # the "Pick from PSP catalogue" picker at new-project
            # creation; drives the on-save BOM push.
            "psp_finished_product_uuid",
            "is_rtg_published",
            "rtg_display_name",
            "rtg_short_description",
            "rtg_long_description",
            "rtg_page_content",
            "rtg_hero_image",
            "rtg_base_price",
            "rtg_moq",
            "rtg_packaging_options",
            "rtg_currency_code",
            "packaging_combos_count",
            "has_approved_final_spec",
            "catalog_photos",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields

    def get_gummy_base_item_ids(self, obj: Formulation) -> list[str]:
        """Flat list of picked item ids — drives the multi-select
        dropdown's ``selected`` state without chasing nested dicts."""

        return [str(item.id) for item in obj.gummy_base_items.all()]

    def get_flavouring_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list — drives the flavouring multi-select."""

        return [str(item.id) for item in obj.flavouring_items.all()]

    def get_colour_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list — drives the colour multi-select."""

        return [str(item.id) for item in obj.colour_items.all()]

    def get_sweetener_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list — drives the powder sweetener multi-select."""

        return [str(item.id) for item in obj.sweetener_items.all()]

    def get_glazing_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the glazing-agent multi-select."""

        return [str(item.id) for item in obj.glazing_items.all()]

    def get_gelling_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the gelling-agent multi-select."""

        return [str(item.id) for item in obj.gelling_items.all()]

    def get_premix_sweetener_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the premix-sweetener multi-select."""

        return [str(item.id) for item in obj.premix_sweetener_items.all()]

    def get_acidity_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the acidity-regulator multi-select."""

        return [str(item.id) for item in obj.acidity_items.all()]

    def get_acidity_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked acidity-regulator items so the
        builder chips render without a second request.

        Adds ``water_dose_mg_per_ml`` on top of the shared echo shape
        so the client-side formulation math can mirror the server's
        per-item powder acidity rate (mg per ml of reconstitution
        water) without a second round-trip to the catalogue API.
        Empty / unset values surface as ``None`` so the client can
        emit the same "missing dose rate" warning the server does.
        """

        from apps.formulations.constants import (
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
        )

        return self._attach_per_item_rate(
            self._echo_picks(obj.acidity_items),
            obj.acidity_items,
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
            "water_dose_mg_per_ml",
        )

    def get_capsule_shell_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the capsule shell picker. Typically
        one pick per formulation — the M2M shape matches every
        other excipient picker for a consistent FE component."""

        return [str(item.id) for item in obj.capsule_shell_items.all()]

    def get_capsule_shell_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked capsule shells so the builder can
        render the chip + drive the BOM SHELL row without an extra
        round-trip. Downstream compute reads the shell's
        ``attributes.capsule_size`` / ``attributes.shell_weight_mg``
        for fill capacity + shell mass."""

        return self._echo_picks(obj.capsule_shell_items)

    def get_mcc_carrier_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the capsule + tablet MCC carrier
        multi-select. Drives the picker's ``selected`` state."""

        return [str(item.id) for item in obj.mcc_carrier_items.all()]

    def get_mcc_carrier_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked MCC carrier items so the builder
        renders chips without a second round-trip."""

        return self._echo_picks(obj.mcc_carrier_items)

    def get_dcp_carrier_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the tablet DCP carrier multi-select."""

        return [str(item.id) for item in obj.dcp_carrier_items.all()]

    def get_dcp_carrier_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked DCP carrier items."""

        return self._echo_picks(obj.dcp_carrier_items)

    def get_anti_caking_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the capsule + tablet anti-caking multi-select.
        Empty list = the formulation ships with no anti-caking band at
        all (no Stearate / Silica rows on the spec sheet)."""

        return [str(item.id) for item in obj.anti_caking_items.all()]

    def get_anti_caking_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked anti-caking items so the builder chips
        render without a second round-trip."""

        return self._echo_picks(obj.anti_caking_items)

    def get_powder_carrier_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the powder carrier multi-select. Drives
        the builder picker's checked state."""

        return [str(item.id) for item in obj.powder_carrier_items.all()]

    def get_powder_carrier_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked powder carrier items so the builder
        chips render without a second round-trip."""

        return self._echo_picks(obj.powder_carrier_items)

    def get_glazing_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked glazing items (same shape as the other
        M2M echoes) so the builder renders chips without a second
        round-trip."""

        return self._echo_picks(obj.glazing_items)

    def get_derived_allergen_keys(self, obj: Formulation) -> list[str]:
        """Union of ingredient-declared allergen keys — Setup tab uses
        this to pre-check the allergen matrix. Scientist overrides via
        the ``allergen_uuids`` field on the model."""

        from apps.formulations.services import derive_ingredient_allergens

        return derive_ingredient_allergens(formulation=obj)["keys"]

    def get_deposit_gate(self, obj: Formulation) -> dict[str, Any]:
        """Trial-batch gate — deposit paid / pending / not required.

        Same blob shape as
        :func:`apps.payments.services.trial_batch_gate_status`
        so a single source of truth drives both the FE banner and
        the create-batch guard. Lazy import to avoid a circular
        formulations ↔ payments ↔ proposals dependency at boot.
        """

        from apps.payments.services import trial_batch_gate_status

        return trial_batch_gate_status(obj)

    def get_packaging_combos_count(self, obj: Formulation) -> int:
        """Number of packaging combos on this formulation. Zero for
        Custom rows (they don't use the combo picker); N for RTG
        rows. Powers the catalog card chip so the FE doesn't need a
        second round-trip just to render "3 packaging options"."""

        # Reads through the reverse-FK count aggregate — a single
        # ``COUNT(*)`` per row. Cheap enough for the list serializer
        # to keep as an inline field.
        return obj.packaging_combos.count()

    def get_has_approved_final_spec(self, obj: Formulation) -> bool:
        """True when there's a FINAL spec sheet on this project whose
        status is at or past ``approved``. Drives the RTG publish gate:
        the panel refuses to expose an unfinished SKU on the customer
        catalog until quality has signed off on the FINAL spec.

        ``sent`` / ``accepted`` also count — they're both post-approval
        states in the spec lifecycle. Kept as a single ``.exists()`` so
        the field costs one indexed lookup per formulation."""

        from apps.specifications.models import (
            SpecificationDocumentKind,
            SpecificationSheet,
            SpecificationStatus,
        )

        return (
            SpecificationSheet.objects
            .filter(
                formulation_version__formulation=obj,
                document_kind=SpecificationDocumentKind.FINAL,
                status__in=(
                    SpecificationStatus.APPROVED,
                    SpecificationStatus.SENT,
                    SpecificationStatus.ACCEPTED,
                ),
            )
            .exists()
        )

    def get_catalog_photos(self, obj: Formulation) -> list[dict[str, Any]]:
        """Serialised photos in the RTG catalog scope, primary first.

        Deliberately narrow (id / url / caption / is_primary /
        sort_order) — the FE gallery + portal storefront don't need
        the PSP mirror uuid or upload metadata that Setup > Photos
        surfaces. Keeps the RTG payload lean."""

        from apps.formulations.models import FormulationPhoto

        rows = obj.photos.filter(
            purpose=FormulationPhoto.Purpose.CATALOG,
        ).order_by("-is_primary", "sort_order", "uploaded_at")
        return [
            {
                "id": str(p.id),
                "url": p.image.url if p.image else None,
                "caption": p.caption,
                "is_primary": p.is_primary,
                "sort_order": p.sort_order,
            }
            for p in rows
        ]

    def get_derived_allergen_uuids(self, obj: Formulation) -> list[str]:
        """Parallel list to :meth:`get_derived_allergen_keys` — the
        UUIDs are what the PSP push cascade forwards to the finished-
        product item's allergen M:N."""

        from apps.formulations.services import derive_ingredient_allergens

        return derive_ingredient_allergens(formulation=obj)["uuids"]

    def _echo_picks(self, manager) -> list[dict]:
        """Common shape for the M2M echo blocks (gummy base, flavouring,
        colour, glazing) so the builder can chip-render every pick list
        from a single round-trip without per-band branching.

        Sorts in Python rather than with ``.order_by("name")`` so the
        list endpoint's prefetch cache (see ``_FORMULATION_LIST_PREFETCH``
        on the services side) is reused. ``manager.all().order_by(...)``
        invalidates the prefetch by appending an ORDER BY and forcing
        a fresh query per row -- the very N+1 the prefetch exists to
        avoid. Pick lists are tiny (single-digit items per band), so
        sorting in Python is essentially free.
        """

        rows: list[dict] = []
        items = sorted(
            manager.all(), key=lambda i: (i.name or "").lower()
        )
        for item in items:
            attrs = item.attributes or {}
            rows.append(
                {
                    "id": str(item.id),
                    "name": item.name,
                    "internal_code": item.internal_code or "",
                    "ingredient_list_name": (
                        attrs.get("ingredient_list_name") or ""
                    ),
                    "use_as": attrs.get("use_as") or "",
                    # PSP origin marker — lets the picker map the
                    # local pick back onto its PSP catalogue row on
                    # mount, so a page refresh keeps the checkbox
                    # ticked instead of showing the freshly-fetched
                    # PSP option as an unchecked twin.
                    "psp_source_uuid": (
                        str(item.psp_source_uuid)
                        if item.psp_source_uuid
                        else None
                    ),
                    # Full attributes map so downstream FE compute
                    # can read pick-specific overrides without a
                    # separate items-detail round-trip. Consumers:
                    # capsule shell picks (``capsule_size``,
                    # ``shell_weight_mg``), and any future picker
                    # whose compute-critical fields live in the
                    # dynamic attributes bag.
                    "attributes": attrs,
                }
            )
        return rows

    def _attach_per_item_rate(
        self,
        rows: list[dict],
        manager,
        attribute_key: str,
        output_key: str,
    ) -> list[dict]:
        """Splice a per-item rate (mg/g of powder, mg/ml of water, etc.)
        into the echoed rows in-place.

        Lets each per-item-rated band (acidity / flavouring / sweetener
        / colour) reuse the standard ``_echo_picks`` output and tack
        the band-specific rate on the side without duplicating the
        chip-shaping logic.
        """

        items_by_id = {str(item.id): item for item in manager.all()}
        for row in rows:
            item = items_by_id.get(row["id"])
            attrs = (item.attributes or {}) if item is not None else {}
            raw_rate = attrs.get(attribute_key)
            try:
                rate = (
                    float(raw_rate)
                    if raw_rate not in (None, "")
                    else None
                )
            except (TypeError, ValueError):
                rate = None
            row[output_key] = rate
        return rows

    def get_flavouring_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked flavouring item + the unified
        ``powder_water_dose_mg_per_ml`` rate from the catalogue. For
        Flavouring picks the math interprets the value as mg per
        gram of finished powder; the field name on the catalogue is
        kept singular ("Powder Water Dose") so scientists set one
        number per raw material regardless of band."""

        from apps.formulations.constants import (
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
        )

        return self._attach_per_item_rate(
            self._echo_picks(obj.flavouring_items),
            obj.flavouring_items,
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
            "powder_rate_mg_per_g",
        )

    def get_colour_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked colour item + the unified
        per-item rate. The math interprets the value as mg per gram
        of finished powder for Colour picks."""

        from apps.formulations.constants import (
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
        )

        return self._attach_per_item_rate(
            self._echo_picks(obj.colour_items),
            obj.colour_items,
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
            "powder_rate_mg_per_g",
        )

    def get_sweetener_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked sweetener item + the unified
        per-item rate. The math interprets the value as mg per gram
        of finished powder for Sweetener picks."""

        from apps.formulations.constants import (
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
        )

        return self._attach_per_item_rate(
            self._echo_picks(obj.sweetener_items),
            obj.sweetener_items,
            POWDER_WATER_DOSE_ATTRIBUTE_KEY,
            "powder_rate_mg_per_g",
        )

    def get_gelling_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked gelling items (pectin, gelatin, etc.)
        so the builder chips render without a second request."""

        return self._echo_picks(obj.gelling_items)

    def get_premix_sweetener_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked premix-sweetener items so the builder
        chips render without a second request."""

        return self._echo_picks(obj.premix_sweetener_items)

    def get_gummy_base_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked gummy base so the builder can
        render the chip list without a second round-trip. Empty when
        nothing's been picked yet."""

        return self._echo_picks(obj.gummy_base_items)

    def get_sales_person(
        self, obj: Formulation
    ) -> dict[str, str] | None:
        return _user_chip(obj.sales_person)

    def get_lead_scientist(
        self, obj: Formulation
    ) -> dict[str, str] | None:
        return _user_chip(obj.lead_scientist)


class FormulationWriteSerializer(serializers.Serializer):
    """Input shape for create + update.

    Every metadata field except lines lives here. Lines are managed
    via a dedicated ``PUT`` endpoint on the nested resource so the
    "save metadata" and "save ingredients" flows stay independent —
    that's how the scientist's spreadsheet workflow splits them too.
    """

    # Custom projects: caller supplies the code (scientist's own
    # reference — appears on BOMs / spec sheets / proposals).
    # RTG projects: blank is accepted and the service auto-assigns
    # ``RTG#####``. Same relaxation for name — RTG rows have only one
    # customer-facing name (edited on the overview page), so we
    # default a blank input to the code so the model constraint stays
    # happy. Update is unaffected (``partial=True`` — omit to leave).
    code = serializers.CharField(max_length=64, allow_blank=True, required=False, default="")
    name = serializers.CharField(max_length=200, allow_blank=True, required=False, default="")
    # PSP integration link. Optional — a formulation without a
    # linked finished-product still saves + versions normally, no
    # BOM push fires. Populated by the "Pick from PSP catalogue"
    # picker at project creation (the picker emits the item's PSP
    # uuid alongside the code+name it auto-fills).
    psp_finished_product_uuid = serializers.UUIDField(
        required=False, allow_null=True
    )
    description = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    dosage_form = serializers.ChoiceField(
        choices=DosageFormChoices.choices, required=False
    )
    capsule_size = serializers.CharField(
        max_length=32, required=False, allow_blank=True
    )
    tablet_size = serializers.CharField(
        max_length=32, required=False, allow_blank=True
    )
    serving_size = serializers.IntegerField(min_value=1, required=False)
    servings_per_pack = serializers.IntegerField(min_value=1, required=False)
    target_fill_weight_mg = serializers.DecimalField(
        max_digits=12,
        decimal_places=4,
        required=False,
        allow_null=True,
    )
    powder_type = serializers.ChoiceField(
        choices=PowderTypeChoices.choices, required=False
    )
    water_volume_ml = serializers.DecimalField(
        max_digits=8,
        decimal_places=2,
        required=False,
        allow_null=True,
        min_value=0,
    )
    gummy_base_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used together as the "
            "gummy base. The base total is split equally across picks. "
            "Every id must belong to the same org AND carry use_as ∈ "
            "(Sweeteners, Bulking Agent). Ignored for non-gummy forms."
        ),
    )
    flavouring_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used together as the "
            "Flavouring block. The flavour total (0.4% of target gummy "
            "weight) is split equally across picks. Every id must "
            "belong to the same org AND carry use_as = 'Flavouring'. "
            "Ignored for non-gummy forms."
        ),
    )
    colour_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used together as the "
            "Colour block. The colour total (2% of target gummy "
            "weight, or 0.04 mg/ml × water volume on a powder) is "
            "split equally across picks. Every id must belong to the "
            "same org AND carry use_as = 'Colour'. Used by both gummy "
            "and powder forms."
        ),
    )
    sweetener_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used together as the "
            "powder Sweetener block (Sucralose, Stevia, Steviol, etc.). "
            "The sweetener total (0.06 mg/ml × water volume) is split "
            "equally across picks. Every id must belong to the same "
            "org AND carry use_as = 'Sweeteners'. Ignored for non-"
            "powder forms — gummies use ``gummy_base_item_ids`` and "
            "``premix_sweetener_item_ids`` instead."
        ),
    )
    glazing_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used together as the "
            "Glazing Agent block (carnauba wax, coconut oil, beeswax, "
            "etc.). The glaze total (0.1% of target gummy weight) is "
            "split equally across picks. Every id must carry use_as = "
            "'Glazing Agent'. Ignored for non-gummy forms."
        ),
    )
    gelling_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used together as "
            "the Gelling Agent block — pectin, gelatin, agar, "
            "carrageenan, etc. The gelling total (3% of target gummy "
            "weight, default) is split equally across picks. Every "
            "id must carry use_as = 'Gelling Agent'. An empty list "
            "means a non-gelling gummy and skips both the gelling "
            "and the premix-sweetener bands. Ignored for non-gummy "
            "forms."
        ),
    )
    premix_sweetener_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items combined with the "
            "gelling agent into the in-house 'Pectin Premix' BOM "
            "line. Picks pull from the gummy-base catalogue pool "
            "(use_as ∈ Sweeteners, Bulking Agent). The premix-"
            "sweetener total (6% of target, default) is carved out "
            "of the gummy base remainder. Only emitted when "
            "gelling_item_ids is non-empty."
        ),
    )
    acidity_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used as the "
            "Acidity Regulator block — Citric Acid, Trisodium "
            "Citrate, etc. Each pick must carry use_as = 'Acidity "
            "Regulator'. The acidity total (2% of target gummy "
            "weight) is split equally across picks. Empty list "
            "leaves a placeholder row."
        ),
    )
    capsule_shell_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of catalogue Items used as the empty capsule "
            "shell. Each pick must carry use_as = 'Capsule Shell'. "
            "Downstream compute reads the pick's "
            "``attributes.capsule_size`` (drives fill capacity) "
            "and ``attributes.shell_weight_mg`` (drives declared "
            "shell mass). Empty list falls back to the hardcoded "
            "per-size shell weight table. Ignored for non-capsule "
            "dosage forms."
        ),
    )
    mcc_carrier_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used as the MCC "
            "(microcrystalline cellulose) carrier on a capsule or "
            "tablet. Each pick must carry use_as = 'Bulking Agent'. "
            "The MCC total (remainder for capsules, fixed % for "
            "tablets) is split equally across picks. Empty list "
            "falls back to the generic 'Microcrystalline Cellulose "
            "(Carrier)' placeholder and surfaces an "
            "``mcc_carrier_unpicked`` viability warning. Ignored "
            "for powder / gummy forms."
        ),
    )
    dcp_carrier_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used as the DCP "
            "(dicalcium phosphate) carrier on a tablet. Each pick "
            "must carry use_as = 'Bulking Agent'. The DCP total "
            "(10% of total active) is split equally across picks. "
            "Empty list falls back to the generic 'Dicalcium "
            "Phosphate' placeholder and surfaces a "
            "``dcp_carrier_unpicked`` warning. Ignored for non-"
            "tablet forms."
        ),
    )
    anti_caking_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used as the "
            "anti-caking band on a capsule, tablet, or powder. Each "
            "pick must carry use_as = 'Anti-caking Agent'. "
            "Contribution is dynamic per pick: silica-only -> 0.4%, "
            "stearate-only -> 1.0%, both -> 1.4% of total active. "
            "**Empty list = no anti-caking on the formulation at "
            "all** (no Stearate or Silica rows). Ignored for gummy."
        ),
    )
    powder_carrier_item_ids = serializers.ListField(
        child=serializers.UUIDField(),
        required=False,
        allow_empty=True,
        help_text=(
            "IDs of raw_materials catalogue Items used as the "
            "powder carrier band -- typically Maltodextrin. Each "
            "pick must carry use_as in ('Carrier', 'Bulking "
            "Agent'). The carrier fills the remainder of the sachet "
            "after actives + other excipient bands; empty list = no "
            "carrier band on the formulation. Ignored for capsule, "
            "tablet, gummy, and liquid forms."
        ),
    )
    excipient_overrides = serializers.DictField(
        required=False,
        allow_null=True,
        child=serializers.FloatField(min_value=0.0, max_value=1.0),
        help_text=(
            "Per-band percentage overrides for the gummy excipient "
            "system. Keys: water, acidity, flavouring, colour, "
            "glazing, gelling, premix_sweetener. Values are decimal "
            "fractions (0.02 = 2%, 0.06 = 6%). Pass an empty dict "
            "to clear all overrides; ``null`` means no change. "
            "Unknown keys are rejected with "
            "``invalid_excipient_overrides``."
        ),
    )
    directions_of_use = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    suggested_dosage = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    appearance = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    disintegration_spec = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    # ------------------------------------------------------------------
    # Finished-product spec — Setup tab source of truth. Every field
    # here rides the same PATCH endpoint the other metadata fields do;
    # the FE reads them back from the returned formulation DTO. Without
    # these declarations DRF silently strips them from
    # ``validated_data`` on ``is_valid()``, ``update_formulation``
    # never sees them, they never get written to the DB, and Setup
    # values "disappear" on the next save round-trip. That was the
    # bug behind "I filled everything and Save version wiped it".
    # ------------------------------------------------------------------
    regulatory_category = serializers.CharField(
        required=False, allow_blank=True, allow_null=True
    )
    warnings_text = serializers.CharField(
        required=False, allow_blank=True, allow_null=True
    )
    shelf_life_months = serializers.IntegerField(
        required=False, allow_null=True, min_value=0
    )
    storage_conditions = serializers.CharField(
        required=False, allow_blank=True, allow_null=True
    )
    target_markets = serializers.ListField(
        required=False, allow_empty=True, child=serializers.CharField()
    )
    net_quantity = serializers.DecimalField(
        max_digits=12,
        decimal_places=4,
        required=False,
        allow_null=True,
    )
    net_quantity_uom_uuid = serializers.UUIDField(
        required=False, allow_null=True
    )
    serving_size_uom_uuid = serializers.UUIDField(
        required=False, allow_null=True
    )
    # Phase 4a — warehouse identity + allergen declaration.
    storage_tags = serializers.ListField(
        required=False, allow_empty=True, child=serializers.CharField()
    )
    min_stock_qty = serializers.DecimalField(
        max_digits=14,
        decimal_places=3,
        required=False,
        allow_null=True,
    )
    target_stock_qty = serializers.DecimalField(
        max_digits=14,
        decimal_places=3,
        required=False,
        allow_null=True,
    )
    allergen_uuids = serializers.ListField(
        required=False, allow_empty=True, child=serializers.UUIDField()
    )
    may_contain_allergen_keys = serializers.ListField(
        required=False, allow_empty=True, child=serializers.CharField()
    )
    may_contain_justification = serializers.CharField(
        required=False, allow_blank=True, allow_null=True
    )
    project_status = serializers.ChoiceField(
        choices=ProjectStatus.choices, required=False
    )
    project_type = serializers.ChoiceField(
        choices=ProjectType.choices, required=False
    )

    def validate_name(self, value: str) -> str:
        # Blank is intentionally allowed — the service layer defaults
        # the name to the (auto-)assigned code for RTG rows so the
        # user isn't forced to type an "internal name" alongside the
        # customer-facing display name. Custom-project callers can
        # still submit a name; we just trim it.
        return (value or "").strip()

    def validate_code(self, value: str) -> str:
        # Blank is intentionally allowed here too — the service
        # auto-assigns ``RTG#####`` for ready-to-go rows. Custom
        # projects still require a non-blank code, but that guard
        # lives in the service (``FormulationCodeRequired``) so both
        # paths funnel through a single place.
        return (value or "").strip()


class FormulationLineWriteSerializer(serializers.Serializer):
    item_id = serializers.UUIDField()
    label_claim_mg = serializers.DecimalField(max_digits=12, decimal_places=4)
    serving_size_override = serializers.IntegerField(
        min_value=1, required=False, allow_null=True
    )
    # Per-line overrides for the catalogue's purity / overage / extract
    # ratio. Null (the default) means "use the catalogue value"; any
    # non-null value wins for THIS formulation only.
    purity_override = serializers.DecimalField(
        max_digits=8,
        decimal_places=4,
        required=False,
        allow_null=True,
        min_value=Decimal("0"),
    )
    overage_override = serializers.DecimalField(
        max_digits=8,
        decimal_places=4,
        required=False,
        allow_null=True,
        min_value=Decimal("0"),
    )
    extract_ratio_override = serializers.DecimalField(
        max_digits=10,
        decimal_places=4,
        required=False,
        allow_null=True,
        min_value=Decimal("0"),
    )
    display_order = serializers.IntegerField(min_value=0, required=False)
    notes = serializers.CharField(required=False, allow_blank=True, default="")
    # Stage this line runs in. Optional — nullable lines fall into
    # the terminal stage's BOM on the push cascade. UUIDs referencing
    # a stage on a different formulation are validated at save time
    # by :func:`replace_lines`.
    stage_id = serializers.UUIDField(required=False, allow_null=True)
    # ``source_kind`` distinguishes the picker that spawned the row —
    # ``active`` (Formulation-tab active picker), ``band_pick``
    # (compute-derived excipient), or ``manual`` (Routing-tab
    # inventory picker). Preserved across replace_lines round-trips
    # so the Routing tab's ×-remove affordance only shows on rows a
    # scientist added directly there.
    source_kind = serializers.ChoiceField(
        choices=["active", "band_pick", "manual"],
        required=False,
        allow_null=True,
    )
    # Preserves the excipient-band discriminator across ``replace_lines``
    # round-trips. Without this the server-side recreate wipes
    # ``band_key`` to NULL on every save, the FE baseline key changes
    # shape from ``band:flavouring:<item>`` to ``band::<item>``, and the
    # stage dropdown snaps back to "Unassigned" because the display
    # look-up key no longer matches.
    band_key = serializers.CharField(
        required=False,
        allow_blank=True,
        allow_null=True,
    )
    # Stage-scoped consumption ratio for lines that don't fit the
    # actives ``label_claim_mg`` semantic (coatings, packaging, glazes,
    # capsule shells, syrups). See FormulationLine.stage_ratio_mode
    # docstring for the resolver semantics + immutability rules.
    stage_ratio_mode = serializers.ChoiceField(
        choices=["none", "per_unit", "percent_of_mass"],
        required=False,
        allow_null=True,
    )
    stage_ratio_value = serializers.DecimalField(
        max_digits=14,
        decimal_places=6,
        required=False,
        allow_null=True,
        min_value=Decimal("0"),
    )


class ReplaceLinesSerializer(serializers.Serializer):
    lines = serializers.ListField(
        child=FormulationLineWriteSerializer(), allow_empty=True
    )


class FormulationVersionReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = FormulationVersion
        fields = (
            "id",
            "version_number",
            "label",
            "snapshot_metadata",
            "snapshot_lines",
            "snapshot_totals",
            "snapshot_stage_boms",
            "is_auto",
            "is_complete",
            "created_at",
        )
        read_only_fields = fields


class SaveVersionSerializer(serializers.Serializer):
    label = serializers.CharField(
        max_length=150, required=False, allow_blank=True, default=""
    )
    #: Per-stage compute-derived BOM snapshot, keyed by stage uuid.
    #: Each row: ``{"item_id": "<local uuid>", "mg": <float>,
    #: "sort_order": <int>, "label": "...", "code": "..."}``.
    #: Optional — omitted payloads store an empty dict and history
    #: falls back to the (denormalised) ``snapshot_lines`` per-line
    #: ``stage_id`` for reconstruction. FE always sends it now so
    #: version history preserves exactly what each stage's PSP BOM
    #: held at save time (actives + excipient bands + prior-semi).
    stage_boms = serializers.DictField(
        child=serializers.ListField(child=serializers.DictField()),
        required=False,
        default=dict,
    )
    #: Set true when the FE fires this call from Save draft's
    #: background auto-snapshot flow. The Versions sub-tab hides
    #: auto entries by default; the Activity sub-tab uses them to
    #: give every audit row a revert target.
    is_auto = serializers.BooleanField(required=False, default=False)


class RollbackVersionSerializer(serializers.Serializer):
    version_number = serializers.IntegerField(min_value=1)


class WizardRoutingSerializer(serializers.Serializer):
    """POST body for ``/formulations/<id>/wizard-routing/``.

    ``line_assignments`` — ``{line_uuid: stage_uuid_or_null}``. Updates
    the ``stage`` FK on each existing active :class:`FormulationLine`.

    ``band_assignments`` — list of
    ``{item_id, band_key, mg, stage_id, unassign?}``. PATCH-only:
    upserts on (item, band_key). A missing / null ``stage_id`` is
    treated as "no routing intent" and leaves any existing stage
    alone; pass ``unassign: true`` alongside a null ``stage_id`` to
    actually clear the assignment. Rows the payload doesn't
    reference stay untouched — the picker sync service handles
    removing FormulationLine rows for M2M picks the operator
    un-ticked.
    """

    line_assignments = serializers.DictField(
        child=serializers.UUIDField(allow_null=True),
        required=False,
        default=dict,
    )
    band_assignments = serializers.ListField(
        child=serializers.DictField(),
        required=False,
        default=list,
    )


class SetApprovedVersionSerializer(serializers.Serializer):
    """``POST`` ``/.../formulations/<id>/approved-version/``.

    ``version_number=null`` clears the pointer. Any positive integer
    has to correspond to an existing version of *this* formulation —
    the service layer enforces that cross-check, the serializer only
    validates the shape.
    """

    version_number = serializers.IntegerField(
        min_value=1, required=False, allow_null=True
    )
