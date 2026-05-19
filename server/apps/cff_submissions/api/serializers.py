"""DRF serializers for the CFF submissions API."""

from __future__ import annotations

from rest_framework import serializers

from apps.cff_submissions.models import CFFSubmission


class CFFAuthorSerializer(serializers.Serializer):
    """Minimal author shape used in the ``assigned_by`` field."""

    id = serializers.UUIDField()
    full_name = serializers.CharField()
    email = serializers.EmailField()


class CFFProjectRefSerializer(serializers.Serializer):
    """Compact project reference embedded in a CFF row.

    Full project shape lives in :mod:`apps.formulations.api.serializers`;
    here we only need enough to render the badge / link in the CFF
    list.
    """

    id = serializers.UUIDField()
    code = serializers.CharField(allow_blank=True)
    name = serializers.CharField()


class CFFSubmissionSerializer(serializers.ModelSerializer):
    """List / detail wire shape for a CFF row.

    ``raw_payload`` is shipped through unchanged — the UI renders
    each field on the client side so a Wix-side schema change
    doesn't require a backend update. The companion
    ``field_labels`` lookup (served by a sibling endpoint) maps
    Wix's slugs to human labels.
    """

    project = CFFProjectRefSerializer(read_only=True)
    assigned_by = serializers.SerializerMethodField()

    class Meta:
        model = CFFSubmission
        fields = (
            "id",
            "wix_submission_id",
            "wix_form_id",
            "wix_namespace",
            "wix_status",
            "wix_created_date",
            "wix_updated_date",
            "raw_payload",
            "project",
            "assigned_by",
            "assigned_at",
            "imported_at",
            "last_synced_at",
        )

    def get_assigned_by(self, obj: CFFSubmission) -> dict | None:
        if obj.assigned_by_id is None:
            return None
        user = obj.assigned_by
        return {
            "id": str(user.id),
            "full_name": user.get_full_name() or user.email,
            "email": user.email,
        }


class AssignToProjectRequestSerializer(serializers.Serializer):
    """Body for ``POST /cff-submissions/<id>/assign/``.

    The view re-fetches the project and runs the cross-org guard;
    here we only validate that a UUID was supplied.
    """

    project_id = serializers.UUIDField()


class CreateProjectFromCFFRequestSerializer(serializers.Serializer):
    """Body for ``POST /cff-submissions/<id>/create-project/``.

    Mirrors :func:`apps.formulations.services.create_formulation`'s
    signature so the existing new-project modal can submit through
    this endpoint when invoked from a CFF row — same form, same
    fields, same defaults; the endpoint just additionally attaches
    the CFF and auto-assigns the sales person matched against the
    customer's account-manager email.
    """

    name = serializers.CharField(max_length=200, allow_blank=False)
    code = serializers.CharField(max_length=64, allow_blank=False)
    description = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    dosage_form = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    capsule_size = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    tablet_size = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    serving_size = serializers.IntegerField(
        required=False, min_value=1, default=1,
    )
    servings_per_pack = serializers.IntegerField(
        required=False, min_value=1, default=60,
    )
    directions_of_use = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    suggested_dosage = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    appearance = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    disintegration_spec = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    target_fill_weight_mg = serializers.DecimalField(
        required=False, max_digits=10, decimal_places=2,
        allow_null=True, default=None,
    )
    powder_type = serializers.CharField(
        required=False, allow_blank=True, default="",
    )
    water_volume_ml = serializers.DecimalField(
        required=False, max_digits=10, decimal_places=2,
        allow_null=True, default=None,
    )
