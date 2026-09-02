"""Serializers for the trial-batches API."""

from __future__ import annotations

from rest_framework import serializers

from apps.formulations.constants import dosage_form_unit_label
from apps.product_validation.models import ProductValidation, ValidationStatus
from apps.trial_batches.models import BatchKind, TrialBatch


class TrialBatchReadSerializer(serializers.ModelSerializer):
    formulation_id = serializers.UUIDField(
        source="formulation_version.formulation_id", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation_version.formulation.name", read_only=True
    )
    formulation_version_number = serializers.IntegerField(
        source="formulation_version.version_number", read_only=True
    )
    #: ``custom`` vs ``ready_to_go``. Exposed so FE surfaces can gate
    #: RTG-specific behaviour off the batch payload without a second
    #: formulation fetch. Load-bearing on the trial-batch detail page:
    #: the "Start validation" CTA is meaningless on RTG customer-
    #: sample runs (the RTG SKU's FINAL-spec approval IS the
    #: validation gate — every sample fulfillment is just production,
    #: not an R&D validation).
    formulation_project_type = serializers.CharField(
        source="formulation_version.formulation.project_type",
        read_only=True,
    )
    created_by_name = serializers.SerializerMethodField()
    #: Terminal-or-in-progress validation status attached to this
    #: batch. Nullable — batches without a validation record return
    #: ``None``. FE uses this to gate the delete button (passed →
    #: delete refused with an audit-trail-integrity 409).
    validation_status = serializers.SerializerMethodField()
    #: Human-readable combo name, denormalised into the read payload
    #: so the FE can render a chip without a second fetch. Empty
    #: string when no combo is set (sample "no packaging" or trial).
    packaging_combo_name = serializers.SerializerMethodField()
    #: ``True`` when *another* batch of the same formulation (any
    #: version) already has a ``passed`` validation. The FE uses this
    #: to hide the "Start validation" CTA on sample batches — once
    #: the product is proven, subsequent customer-sample runs inherit
    #: the proof and don't need re-validation. Scoped to formulation,
    #: not version, so a version bump on the same product doesn't
    #: silently unlock re-validation on samples. Deliberately
    #: excludes ``self`` because a batch that's already validated
    #: renders "Open validation" via its own ``validation_status``.
    formulation_validated = serializers.SerializerMethodField()
    #: Denormalised finished-product ``servings_per_pack`` (bottle
    #: fill count). Exposed so the FE's Create-MO modal can offer a
    #: "complete packs vs individual units" toggle for sample batches
    #: — the user commonly wants to ship 5-8 loose capsules instead
    #: of full 60-cap bottles. Server converts on the actual create-
    #: MO call; this field just powers the preview + toggle enable/
    #: disable. ``1`` when the formulation ships one-per-pack or the
    #: value is unset (toggle is hidden in that case).
    servings_per_pack = serializers.SerializerMethodField()
    #: Canonical singular / plural unit nouns for the formulation's
    #: dosage form — e.g. ``("capsule", "capsules")``,
    #: ``("scoop", "scoops")``, ``("dose", "doses")``. Powers the
    #: Create-MO modal's dosage-form-aware copy so the "5 caps"
    #: preview swaps to "5 scoops" for powder, "5 doses" for
    #: liquid, etc. Falls back to ``("unit", "units")`` on legacy
    #: rows with no dosage form recorded.
    dosage_form = serializers.SerializerMethodField()
    unit_label_singular = serializers.SerializerMethodField()
    unit_label_plural = serializers.SerializerMethodField()

    def get_created_by_name(self, obj) -> str:
        user = obj.created_by
        return (user.get_full_name() or user.email or "").strip()

    def get_validation_status(self, obj) -> str | None:
        validation = getattr(obj, "validation", None)
        return validation.status if validation is not None else None

    def get_packaging_combo_name(self, obj) -> str:
        combo = obj.packaging_combo
        return combo.name if combo is not None else ""

    def get_formulation_validated(self, obj) -> bool:
        return ProductValidation.objects.filter(
            trial_batch__formulation_version__formulation_id=(
                obj.formulation_version.formulation_id
            ),
            status=ValidationStatus.PASSED,
        ).exclude(trial_batch_id=obj.id).exists()

    def get_servings_per_pack(self, obj) -> int:
        formulation = obj.formulation_version.formulation
        raw = getattr(formulation, "servings_per_pack", None) or 1
        try:
            value = int(raw)
        except (TypeError, ValueError):
            return 1
        return max(1, value)

    def _dosage_form(self, obj) -> str:
        # Prefer the frozen version snapshot (matches what the batch
        # was actually planned against); fall back to the live
        # formulation.dosage_form for legacy versions that predate the
        # snapshot metadata.
        md = getattr(obj.formulation_version, "snapshot_metadata", None) or {}
        snap = (md.get("dosage_form") or "").strip() if isinstance(md, dict) else ""
        if snap:
            return snap
        formulation = obj.formulation_version.formulation
        return (getattr(formulation, "dosage_form", "") or "").strip()

    def get_dosage_form(self, obj) -> str:
        return self._dosage_form(obj)

    def get_unit_label_singular(self, obj) -> str:
        return dosage_form_unit_label(self._dosage_form(obj))[0]

    def get_unit_label_plural(self, obj) -> str:
        return dosage_form_unit_label(self._dosage_form(obj))[1]

    class Meta:
        model = TrialBatch
        fields = (
            "id",
            "label",
            "batch_size_units",
            "kind",
            "packaging_combo_id",
            "packaging_combo_name",
            "notes",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "formulation_project_type",
            "psp_manufacturing_order_uuid",
            "validation_status",
            "formulation_validated",
            "servings_per_pack",
            "dosage_form",
            "unit_label_singular",
            "unit_label_plural",
            "created_by_name",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class TrialBatchCreateSerializer(serializers.Serializer):
    formulation_version_id = serializers.UUIDField()
    batch_size_units = serializers.IntegerField(min_value=1)
    kind = serializers.ChoiceField(
        choices=BatchKind.choices, required=False
    )
    #: Optional packaging combo. Only meaningful for ``kind=sample`` —
    #: the service refuses it on ``kind=trial`` batches. ``null`` (or
    #: absent) means "no combo picked".
    packaging_combo_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    label = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    notes = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    #: Optional. Set when the batch is created from the R&D Samples
    #: fulfilment queue so the queue can filter the payment out on
    #: the next fetch. Cross-org / missing payment silently drops
    #: the link — see ``create_batch`` for the reasoning.
    source_payment_id = serializers.UUIDField(
        required=False, allow_null=True
    )


class TrialBatchUpdateSerializer(serializers.Serializer):
    label = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    batch_size_units = serializers.IntegerField(required=False, min_value=1)
    kind = serializers.ChoiceField(
        choices=BatchKind.choices, required=False
    )
    packaging_combo_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    notes = serializers.CharField(required=False, allow_blank=True)
