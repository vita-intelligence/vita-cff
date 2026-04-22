"""Serializers for the product-validation API."""

from __future__ import annotations

from rest_framework import serializers

from apps.product_validation.models import ProductValidation, ValidationStatus


class _ActorField(serializers.SerializerMethodField):
    """Render a FK-to-user as ``{id, name, email}`` or ``null``.

    Repeated across every signature field on the validation DTO, so
    it lives here instead of being inlined four times.
    """

    def __init__(self, *, source_attr: str, **kwargs):
        self._source_attr = source_attr
        super().__init__(**kwargs)

    def bind(self, field_name, parent):  # type: ignore[override]
        super().bind(field_name, parent)

        def resolver(obj, _attr=self._source_attr):
            user = getattr(obj, _attr, None)
            if user is None:
                return None
            return {
                "id": str(user.id),
                "name": (user.get_full_name() or user.email or "").strip(),
                "email": user.email,
            }

        setattr(parent, f"get_{field_name}", resolver)


class ProductValidationReadSerializer(serializers.ModelSerializer):
    trial_batch_id = serializers.UUIDField(read_only=True)
    formulation_id = serializers.UUIDField(
        source="trial_batch.formulation_version.formulation_id",
        read_only=True,
    )
    formulation_name = serializers.CharField(
        source="trial_batch.formulation_version.formulation.name",
        read_only=True,
    )
    formulation_version_number = serializers.IntegerField(
        source="trial_batch.formulation_version.version_number",
        read_only=True,
    )
    batch_label = serializers.CharField(
        source="trial_batch.label", read_only=True
    )

    scientist = _ActorField(source_attr="scientist_signature")
    rd_manager = _ActorField(source_attr="rd_manager_signature")

    class Meta:
        model = ProductValidation
        fields = (
            "id",
            "trial_batch_id",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "batch_label",
            "weight_test",
            "hardness_test",
            "thickness_test",
            "disintegration_test",
            "organoleptic_test",
            "mrpeasy_checklist",
            "notes",
            "status",
            "scientist",
            "scientist_signed_at",
            "scientist_signature_image",
            "rd_manager",
            "rd_manager_signed_at",
            "rd_manager_signature_image",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class ProductValidationCreateSerializer(serializers.Serializer):
    trial_batch_id = serializers.UUIDField()
    notes = serializers.CharField(
        required=False, allow_blank=True, default=""
    )


class ProductValidationUpdateSerializer(serializers.Serializer):
    """Partial update of any subset of the JSON test blobs + notes.

    We accept each test as a plain ``dict`` and let the service layer
    store it wholesale — validating individual numeric fields server-
    side would duplicate the form constraints already enforced on the
    client, and the stats function is tolerant of missing values.
    """

    weight_test = serializers.DictField(required=False)
    hardness_test = serializers.DictField(required=False)
    thickness_test = serializers.DictField(required=False)
    disintegration_test = serializers.DictField(required=False)
    organoleptic_test = serializers.DictField(required=False)
    mrpeasy_checklist = serializers.DictField(required=False)
    notes = serializers.CharField(required=False, allow_blank=True)


class ProductValidationStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=ValidationStatus.choices)
    # The drawn signature data URL. Optional at the serializer layer
    # because the service decides per-transition whether it is
    # required — rewinding ``in_progress → draft`` and re-signing an
    # existing sign-off do not need a fresh image.
    signature_image = serializers.CharField(
        required=False,
        allow_blank=True,
        trim_whitespace=False,
    )
