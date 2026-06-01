"""Serializers for the staff-curated label-design template library.

Two read shapes (categories vs templates with file metadata) and
one multipart write shape (the upload payload).
"""

from __future__ import annotations

from rest_framework import serializers

from apps.label_design.models import (
    LabelDesignTemplate,
    LabelDesignTemplateCategory,
)


# Hard upper bound on uploaded template file size. 25 MB lands
# comfortably above PDF / PNG label artwork (typically <5 MB) and
# below the Azure single-blob-PUT inline limit (50 MB), so Azure's
# block-upload path never engages. Bumped as a const so a future
# requirement (.AI / .PSD source files are large) just edits the
# number in one place rather than chasing it through the form.
_TEMPLATE_MAX_BYTES = 25 * 1024 * 1024


class LabelDesignTemplateCategorySerializer(serializers.ModelSerializer):
    """Read + write payload for category management."""

    class Meta:
        model = LabelDesignTemplateCategory
        fields = (
            "id",
            "name",
            "description",
            "sort_order",
            "created_at",
            "updated_at",
        )
        read_only_fields = ("id", "created_at", "updated_at")


class LabelDesignTemplateSerializer(serializers.ModelSerializer):
    """Read shape for individual templates.

    ``file_url`` carries the storage URL the FE downloads with —
    in production this resolves to an Azure Blob URL; in dev the
    local ``/media/`` proxy serves it via the Next.js rewrite
    + Django's static-file helper.
    """

    file_url = serializers.SerializerMethodField()
    category_name = serializers.CharField(
        source="category.name", read_only=True, default=""
    )

    class Meta:
        model = LabelDesignTemplate
        fields = (
            "id",
            "category",
            "category_name",
            "name",
            "description",
            "file_url",
            "file_original_name",
            "file_size_bytes",
            "content_type",
            "sort_order",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields

    def get_file_url(self, obj: LabelDesignTemplate) -> str:
        return obj.file.url if obj.file else ""


class LabelDesignTemplateUploadSerializer(serializers.Serializer):
    """Multipart create payload for the staff upload endpoint."""

    category_id = serializers.UUIDField()
    name = serializers.CharField(max_length=180)
    description = serializers.CharField(
        allow_blank=True, required=False, default=""
    )
    file = serializers.FileField()
    sort_order = serializers.IntegerField(required=False, default=0, min_value=0)

    def validate_file(self, value):
        size = getattr(value, "size", 0) or 0
        if size > _TEMPLATE_MAX_BYTES:
            mb = size / (1024 * 1024)
            cap = _TEMPLATE_MAX_BYTES / (1024 * 1024)
            raise serializers.ValidationError(
                f"file is {mb:.1f} MB — over the {cap:.0f} MB limit"
            )
        return value
