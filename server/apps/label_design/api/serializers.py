"""Serializers for the label-design API.

Three audiences:

* Staff serializers below take the full LabelDesign + Revision +
  Review shape; that's what the labelling team sees.
* Portal-facing serializers live in
  :mod:`apps.client_portal.api.label_design_views` — they share
  the read-side fields with the staff serializers via composition
  so the wire format stays consistent.
"""

from __future__ import annotations

import json

from rest_framework import serializers

from apps.label_design.constants import (
    COMPLIANCE_CHECKLIST,
    COMPLIANCE_CHECKLIST_KEYS,
    DesignStyle,
    LabelDesignPath,
    LabelDesignStatus,
    MaterialType,
    ReviewKind,
    ReviewOutcome,
    RevisionSource,
)
from apps.label_design.models import (
    LabelDesign,
    LabelDesignPreferences,
    LabelDesignReview,
    LabelDesignRevision,
)


class LabelDesignRevisionReadSerializer(serializers.ModelSerializer):
    submitted_by_user_email = serializers.CharField(
        source="submitted_by_user.email", read_only=True, default=""
    )
    submitted_by_client_email = serializers.CharField(
        source="submitted_by_client.email", read_only=True, default=""
    )
    artwork_pdf_url = serializers.SerializerMethodField()
    artwork_preview_png_url = serializers.SerializerMethodField()

    class Meta:
        model = LabelDesignRevision
        fields = (
            "id",
            "label_design",
            "revision_number",
            "source",
            "submitted_by_user",
            "submitted_by_user_email",
            "submitted_by_client",
            "submitted_by_client_email",
            "submitted_at",
            "artwork_pdf_url",
            "artwork_preview_png_url",
            "compliance_block_snapshot",
            "customer_approved_own_design",
            "notes",
        )
        read_only_fields = fields

    def get_artwork_pdf_url(self, obj: LabelDesignRevision) -> str:
        return obj.artwork_pdf.url if obj.artwork_pdf else ""

    def get_artwork_preview_png_url(self, obj: LabelDesignRevision) -> str:
        return obj.artwork_preview_png.url if obj.artwork_preview_png else ""


class LabelDesignReviewReadSerializer(serializers.ModelSerializer):
    reviewer_email = serializers.CharField(
        source="reviewer.email", read_only=True, default=""
    )

    class Meta:
        model = LabelDesignReview
        fields = (
            "id",
            "revision",
            "kind",
            "reviewer",
            "reviewer_email",
            "outcome",
            "checklist_responses",
            "final_comments",
            "signature_image",
            "created_at",
        )
        read_only_fields = fields


class LabelDesignPreferencesReadSerializer(serializers.ModelSerializer):
    submitted_by_client_email = serializers.CharField(
        source="submitted_by_client.email", read_only=True, default=""
    )
    inspiration_file_urls = serializers.SerializerMethodField()

    class Meta:
        model = LabelDesignPreferences
        fields = (
            "id",
            "submitted_by_client",
            "submitted_by_client_email",
            "submitted_at",
            "company_name",
            "brand_name",
            "product_names",
            "product_codes",
            "brand_colours",
            "inspiration_urls",
            "inspiration_file_urls",
            "elements_to_include",
            "design_style",
            "material_type",
            "additional_comments",
            "declaration_signed_at",
            "declaration_signature_image",
            "declaration_name",
            "declaration_position",
            "raw_payload",
        )
        read_only_fields = fields

    def get_inspiration_file_urls(self, obj: LabelDesignPreferences) -> list[dict]:
        return [
            {
                "id": str(f.id),
                "url": f.file.url if f.file else "",
                "original_name": f.original_name,
                "size_bytes": f.size_bytes,
            }
            for f in obj.inspiration_files.all()
        ]


class LabelDesignReadSerializer(serializers.ModelSerializer):
    formulation_code = serializers.CharField(
        source="formulation.code", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation.name", read_only=True
    )
    organization_name = serializers.CharField(
        source="organization.name", read_only=True
    )
    current_revision_detail = LabelDesignRevisionReadSerializer(
        source="current_revision", read_only=True
    )
    preferences_detail = LabelDesignPreferencesReadSerializer(
        source="preferences", read_only=True
    )
    revisions = LabelDesignRevisionReadSerializer(many=True, read_only=True)
    assigned_designer_email = serializers.CharField(
        source="assigned_designer.email", read_only=True, default=""
    )

    class Meta:
        model = LabelDesign
        fields = (
            "id",
            "organization",
            "organization_name",
            "formulation",
            "formulation_code",
            "formulation_name",
            "specification_sheet",
            "status",
            "design_path",
            "assigned_designer",
            "assigned_designer_email",
            "current_revision",
            "current_revision_detail",
            "preferences_detail",
            "revisions",
            "rejection_count",
            "customer_approved_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class LabelDesignListItemSerializer(serializers.ModelSerializer):
    """Slim row used by the staff queue.

    Drops nested ``revisions``, ``preferences_detail`` and
    ``current_revision_detail`` — the queue table only needs columns
    that fit on one line. The detail page keeps using
    :class:`LabelDesignReadSerializer` for the full shape.
    """

    formulation_code = serializers.CharField(
        source="formulation.code", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation.name", read_only=True
    )
    assigned_designer_email = serializers.CharField(
        source="assigned_designer.email", read_only=True, default=""
    )

    class Meta:
        model = LabelDesign
        fields = (
            "id",
            "formulation",
            "formulation_code",
            "formulation_name",
            "status",
            "design_path",
            "assigned_designer",
            "assigned_designer_email",
            "rejection_count",
            "customer_approved_at",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


# ---------------------------------------------------------------------------
# Write serializers
# ---------------------------------------------------------------------------


class AssignDesignerSerializer(serializers.Serializer):
    designer_id = serializers.UUIDField(required=False, allow_null=True)


#: Hard upper bound on a single artwork upload — 50 MB. Large
#: enough that 300-DPI press-ready PDFs comfortably fit; small
#: enough that an attacker spamming the endpoint can't OOM the
#: container. WSGI / Daphne workers also have their own
#: ``DATA_UPLOAD_MAX_MEMORY_SIZE`` cap as a second layer.
ARTWORK_MAX_BYTES: int = 50 * 1024 * 1024

#: Whitelisted content types for label artwork. PDF (vector) is
#: the preferred format because designers paste it cleanly into
#: any tool; PNG and JPEG are accepted for raster snapshots. We
#: cross-check the file extension against the same shortlist so
#: an attacker can't bypass MIME sniffing by lying about
#: content_type — both signals have to agree.
ARTWORK_ALLOWED_CONTENT_TYPES: tuple[str, ...] = (
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
)
ARTWORK_ALLOWED_EXTENSIONS: tuple[str, ...] = (".pdf", ".png", ".jpg", ".jpeg")


def _validate_artwork_file(value):
    """Belt-and-braces security check for an uploaded artwork file.

    Three layers — size, declared content_type, file extension —
    so a single bypassed signal isn't enough. Runs on every
    upload path (staff + customer-portal) via the two artwork
    serializers below.
    """

    if value is None:
        raise serializers.ValidationError("Artwork file is required.")
    size = getattr(value, "size", 0) or 0
    if size <= 0:
        raise serializers.ValidationError("Uploaded artwork file is empty.")
    if size > ARTWORK_MAX_BYTES:
        raise serializers.ValidationError(
            f"Artwork file too large — {size // (1024 * 1024)} MB exceeds the "
            f"{ARTWORK_MAX_BYTES // (1024 * 1024)} MB cap. Compress the file or "
            "export at a lower DPI."
        )
    content_type = (getattr(value, "content_type", "") or "").lower()
    if content_type not in ARTWORK_ALLOWED_CONTENT_TYPES:
        raise serializers.ValidationError(
            f"Unsupported artwork type ({content_type or 'unknown'}). "
            "Accepted formats: PDF, PNG, JPEG."
        )
    name = (getattr(value, "name", "") or "").lower()
    if not any(name.endswith(ext) for ext in ARTWORK_ALLOWED_EXTENSIONS):
        raise serializers.ValidationError(
            "Artwork file extension must be one of "
            f"{', '.join(ARTWORK_ALLOWED_EXTENSIONS)}."
        )
    return value


class UploadArtworkSerializer(serializers.Serializer):
    artwork = serializers.FileField()
    notes = serializers.CharField(allow_blank=True, default="")

    def validate_artwork(self, value):
        return _validate_artwork_file(value)


class _ChecklistResponseSerializer(serializers.Serializer):
    item_key = serializers.CharField()
    pass_check = serializers.BooleanField()
    comment = serializers.CharField(allow_blank=True, default="")

    def validate_item_key(self, value: str) -> str:
        if value not in COMPLIANCE_CHECKLIST_KEYS:
            raise serializers.ValidationError(
                f"unknown checklist item: {value}"
            )
        return value


class ReviewSubmitSerializer(serializers.Serializer):
    """Shared serializer for scientist + director reviews.

    The view sets ``kind`` from the endpoint URL — this serializer
    only validates the body shape and the checklist completeness.
    """

    outcome = serializers.ChoiceField(choices=ReviewOutcome.choices)
    checklist = _ChecklistResponseSerializer(many=True)
    final_comments = serializers.CharField(min_length=1)
    signature_image = serializers.CharField(allow_blank=True, default="")

    def validate_checklist(self, value: list[dict]) -> list[dict]:
        keys_in_payload = {item["item_key"] for item in value}
        missing = COMPLIANCE_CHECKLIST_KEYS - keys_in_payload
        extras = keys_in_payload - COMPLIANCE_CHECKLIST_KEYS
        if missing:
            raise serializers.ValidationError(
                f"checklist missing items: {sorted(missing)}"
            )
        if extras:
            raise serializers.ValidationError(
                f"checklist has unknown items: {sorted(extras)}"
            )
        return value


class HoldResumeSerializer(serializers.Serializer):
    notes = serializers.CharField(allow_blank=True, default="")


# ---------------------------------------------------------------------------
# Customer-portal write serializers — declared here so the staff side
# also gets read access to the schema for previews.
# ---------------------------------------------------------------------------


class ChoosePathSerializer(serializers.Serializer):
    path = serializers.ChoiceField(choices=LabelDesignPath.choices)


class SubmitPreferencesSerializer(serializers.Serializer):
    """Body of the customer's MA-ST-B-009 submission.

    Field names match the form sections so the FE form state can
    serialise to this shape directly. The FE sends this via
    ``multipart/form-data`` (so it can attach inspiration files in the
    same request), which means list / dict values arrive as JSON
    strings — we transparently parse them in ``to_internal_value``.
    """

    company_name = serializers.CharField(max_length=200, allow_blank=True, default="")
    brand_name = serializers.CharField(max_length=200, allow_blank=True, default="")
    product_names = serializers.CharField(allow_blank=True, default="")
    product_codes = serializers.CharField(allow_blank=True, default="")
    brand_colours = serializers.ListField(
        child=serializers.DictField(child=serializers.CharField()),
        default=list,
    )
    inspiration_urls = serializers.ListField(
        child=serializers.URLField(), default=list
    )
    elements_to_include = serializers.CharField(allow_blank=True, default="")
    design_style = serializers.ChoiceField(
        choices=DesignStyle.choices, allow_blank=True, default=""
    )
    material_type = serializers.ChoiceField(
        choices=MaterialType.choices, allow_blank=True, default=""
    )
    additional_comments = serializers.CharField(allow_blank=True, default="")
    declaration_name = serializers.CharField(max_length=200, allow_blank=True, default="")
    declaration_position = serializers.CharField(
        max_length=120, allow_blank=True, default=""
    )
    declaration_signature_image = serializers.CharField(allow_blank=True, default="")

    _JSON_LIST_FIELDS = ("brand_colours", "inspiration_urls")

    def to_internal_value(self, data):
        # Multipart bodies can't carry nested structures, so the FE
        # JSON-encodes list-valued fields before append()-ing them.
        # Decode them back into native Python before delegating to the
        # standard field validation — otherwise DRF sees a raw string
        # and reports ``not_a_list``.
        if hasattr(data, "copy"):
            data = data.copy()
        else:
            data = dict(data)
        for key in self._JSON_LIST_FIELDS:
            raw = data.get(key)
            if isinstance(raw, str):
                stripped = raw.strip()
                if stripped == "":
                    data[key] = []
                    continue
                try:
                    data[key] = json.loads(stripped)
                except json.JSONDecodeError:
                    raise serializers.ValidationError(
                        {key: ["invalid_json"]}
                    )
        return super().to_internal_value(data)


class CustomerUploadArtworkSerializer(serializers.Serializer):
    artwork = serializers.FileField()
    signature_image = serializers.CharField()
    notes = serializers.CharField(allow_blank=True, default="")

    def validate_artwork(self, value):
        return _validate_artwork_file(value)


class CustomerApproveSerializer(serializers.Serializer):
    signature_image = serializers.CharField()


class CustomerRejectSerializer(serializers.Serializer):
    reason = serializers.CharField(allow_blank=True, default="")
