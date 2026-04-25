"""Serializers for the formulations API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.formulations.models import (
    DosageFormChoices,
    Formulation,
    FormulationLine,
    FormulationVersion,
    PowderTypeChoices,
    ProjectStatus,
    ProjectType,
)


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


class FormulationLineReadSerializer(serializers.ModelSerializer):
    item_name = serializers.CharField(source="item.name", read_only=True)
    item_internal_code = serializers.CharField(
        source="item.internal_code", read_only=True
    )
    item_attributes = serializers.SerializerMethodField()

    class Meta:
        model = FormulationLine
        fields = (
            "id",
            "item",
            "item_name",
            "item_internal_code",
            "item_attributes",
            "display_order",
            "label_claim_mg",
            "serving_size_override",
            "mg_per_serving_cached",
            "notes",
        )
        read_only_fields = fields

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

        attributes = obj.item.attributes or {}
        return {
            "type": attributes.get("type"),
            "purity": attributes.get("purity"),
            "extract_ratio": attributes.get("extract_ratio"),
            "overage": attributes.get("overage"),
            "ingredient_list_name": attributes.get("ingredient_list_name"),
            "nutrition_information_name": attributes.get(
                "nutrition_information_name"
            ),
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
    sales_person = serializers.SerializerMethodField()
    gummy_base_item_ids = serializers.SerializerMethodField()
    gummy_base_items = serializers.SerializerMethodField()
    flavouring_item_ids = serializers.SerializerMethodField()
    flavouring_items = serializers.SerializerMethodField()
    colour_item_ids = serializers.SerializerMethodField()
    colour_items = serializers.SerializerMethodField()
    glazing_item_ids = serializers.SerializerMethodField()
    glazing_items = serializers.SerializerMethodField()

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
            "glazing_item_ids",
            "glazing_items",
            "directions_of_use",
            "suggested_dosage",
            "appearance",
            "disintegration_spec",
            "project_status",
            "project_type",
            "approved_version_number",
            "sales_person",
            "lines",
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

    def get_glazing_item_ids(self, obj: Formulation) -> list[str]:
        """Flat id list for the glazing-agent multi-select."""

        return [str(item.id) for item in obj.glazing_items.all()]

    def get_glazing_items(self, obj: Formulation) -> list[dict]:
        """Light echo of picked glazing items (same shape as the other
        M2M echoes) so the builder renders chips without a second
        round-trip."""

        rows: list[dict] = []
        for item in obj.glazing_items.all().order_by("name"):
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
                }
            )
        return rows

    def _echo_picks(self, manager) -> list[dict]:
        """Common shape for the M2M echo blocks (gummy base, flavouring,
        colour, glazing) so the builder can chip-render every pick list
        from a single round-trip without per-band branching."""

        rows: list[dict] = []
        for item in manager.all().order_by("name"):
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
                }
            )
        return rows

    def get_flavouring_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked flavouring item so the builder
        renders the chip list without a second round-trip."""

        return self._echo_picks(obj.flavouring_items)

    def get_colour_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked colour item so the builder
        renders the chip list without a second round-trip."""

        return self._echo_picks(obj.colour_items)

    def get_gummy_base_items(self, obj: Formulation) -> list[dict]:
        """Light echo of every picked gummy base so the builder can
        render the chip list without a second round-trip. Empty when
        nothing's been picked yet; attribute lookups are best-effort
        (a missing ``ingredient_list_name`` falls back to the item's
        canonical name)."""

        rows: list[dict] = []
        for item in obj.gummy_base_items.all().order_by("name"):
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
                }
            )
        return rows

    def get_sales_person(
        self, obj: Formulation
    ) -> dict[str, str] | None:
        user = obj.sales_person
        if user is None:
            return None
        # Flat, predictable shape so the frontend can render a chip
        # without a second request. ``name`` falls back to email so
        # accounts without a display name still render something
        # human-readable.
        full_name = getattr(user, "full_name", "") or getattr(user, "get_full_name", lambda: "")()
        return {
            "id": str(user.id),
            "email": user.email,
            "name": (full_name or user.email).strip(),
        }


class FormulationWriteSerializer(serializers.Serializer):
    """Input shape for create + update.

    Every metadata field except lines lives here. Lines are managed
    via a dedicated ``PUT`` endpoint on the nested resource so the
    "save metadata" and "save ingredients" flows stay independent —
    that's how the scientist's spreadsheet workflow splits them too.
    """

    # Mandatory on create — the project code is the scientist's own
    # reference and the system no longer auto-generates it. On update
    # the serializer is instantiated with ``partial=True`` so omitting
    # ``code`` is still fine when only other fields are changing; a
    # caller who *does* submit it must still provide a non-blank value.
    code = serializers.CharField(max_length=64)
    name = serializers.CharField(max_length=200)
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
            "weight) is split equally across picks. Every id must "
            "belong to the same org AND carry use_as = 'Colour'. "
            "Ignored for non-gummy forms."
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
    project_status = serializers.ChoiceField(
        choices=ProjectStatus.choices, required=False
    )
    project_type = serializers.ChoiceField(
        choices=ProjectType.choices, required=False
    )

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed

    def validate_code(self, value: str) -> str:
        trimmed = (value or "").strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


class FormulationLineWriteSerializer(serializers.Serializer):
    item_id = serializers.UUIDField()
    label_claim_mg = serializers.DecimalField(max_digits=12, decimal_places=4)
    serving_size_override = serializers.IntegerField(
        min_value=1, required=False, allow_null=True
    )
    display_order = serializers.IntegerField(min_value=0, required=False)
    notes = serializers.CharField(required=False, allow_blank=True, default="")


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
            "created_at",
        )
        read_only_fields = fields


class SaveVersionSerializer(serializers.Serializer):
    label = serializers.CharField(
        max_length=150, required=False, allow_blank=True, default=""
    )


class RollbackVersionSerializer(serializers.Serializer):
    version_number = serializers.IntegerField(min_value=1)


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
