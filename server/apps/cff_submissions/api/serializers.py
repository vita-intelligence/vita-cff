"""DRF serializers for the CFF submissions API."""

from __future__ import annotations

from rest_framework import serializers

from apps.cff_submissions.models import CFFProjectAssignment, CFFSubmission


class CFFAuthorSerializer(serializers.Serializer):
    """Minimal author shape used inside an assignment row."""

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


class CFFAssignmentSerializer(serializers.Serializer):
    """One link from the CFF↔project M2M, with its own audit fields.

    A CFF can hold zero, one, or many of these in its ``assignments``
    list. The empty list is the "still in triage" state — the inbox
    filter chips key on it. The frontend uses the list shape to
    render multiple project chips per row and offers a per-link
    detach action.
    """

    project = CFFProjectRefSerializer()
    assigned_by = serializers.SerializerMethodField()
    assigned_at = serializers.DateTimeField()

    def get_assigned_by(self, obj: CFFProjectAssignment) -> dict | None:
        if obj.assigned_by_id is None:
            return None
        user = obj.assigned_by
        return {
            "id": str(user.id),
            "full_name": user.get_full_name() or user.email,
            "email": user.email,
        }


class CFFSubmissionSerializer(serializers.ModelSerializer):
    """List / detail wire shape for a CFF row.

    ``raw_payload`` is shipped through unchanged — the UI renders
    each field on the client side so a Wix-side schema change
    doesn't require a backend update. The companion
    ``field_labels`` lookup (served by a sibling endpoint) maps
    Wix's slugs to human labels.

    ``assignments`` is the full per-link audit collection. The
    derived ``is_assigned`` boolean is surfaced separately so the
    inbox can branch on it without iterating the list (relevant on
    very wide pages where every row has the field).
    """

    assignments = serializers.SerializerMethodField()
    is_assigned = serializers.SerializerMethodField()
    is_rejected = serializers.SerializerMethodField()
    rejected_by = serializers.SerializerMethodField()

    drafted_proposal_id = serializers.SerializerMethodField()

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
            "assignments",
            "is_assigned",
            "is_rejected",
            "rejected_at",
            "rejected_by",
            "rejection_reason",
            # RTG discriminator + auto-drafted proposal FK. Both
            # nullable / defaulted so Custom rows serialize
            # identically to before the RTG rollout.
            "submission_kind",
            "drafted_proposal_id",
            "imported_at",
            "last_synced_at",
        )

    def get_drafted_proposal_id(self, obj: CFFSubmission) -> str | None:
        """Expose the drafted-proposal FK as a plain UUID string so
        the triage inbox can deep-link to the pre-drafted quote
        without a follow-up round-trip.

        NULL on Custom rows (no proposal yet exists — triage picks
        that path via ``create_project_from_cff``). Populated on
        RTG rows the moment :func:`create_portal_rtg_submission`
        finishes.
        """

        proposal_id = getattr(obj, "drafted_proposal_id", None)
        return str(proposal_id) if proposal_id else None

    def get_assignments(self, obj: CFFSubmission) -> list[dict]:
        """Materialise the prefetched assignment set.

        Callers are expected to ``prefetch_related`` the chain
        ``assignments__project`` / ``assignments__assigned_by``
        upstream so this method is a pure walk over an already-loaded
        collection. Falls back to a fresh query if a caller forgot —
        correctness over performance, the inbox path always
        prefetches.
        """

        rows = list(obj.assignments.all())
        return [
            {
                "project": {
                    "id": str(row.project_id),
                    "code": row.project.code or "",
                    "name": row.project.name,
                },
                "assigned_by": (
                    {
                        "id": str(row.assigned_by.id),
                        "full_name": (
                            row.assigned_by.get_full_name()
                            or row.assigned_by.email
                        ),
                        "email": row.assigned_by.email,
                    }
                    if row.assigned_by_id is not None
                    else None
                ),
                "assigned_at": row.assigned_at,
            }
            for row in rows
        ]

    def get_is_assigned(self, obj: CFFSubmission) -> bool:
        """``True`` when the CFF has at least one project link.

        Reads the prefetched ``assignments`` cache when present —
        otherwise the cached list is empty after a fresh insert and
        we fall back to the ``exists()`` query the model property
        provides.
        """

        cache = getattr(obj, "_prefetched_objects_cache", None) or {}
        if "assignments" in cache:
            return bool(cache["assignments"])
        return obj.is_assigned

    def get_is_rejected(self, obj: CFFSubmission) -> bool:
        return obj.is_rejected

    def get_rejected_by(self, obj: CFFSubmission) -> dict | None:
        """Actor block matching the ``assignments[].assigned_by`` shape
        so the FE can render either audit uniformly. Nulled on
        unreject via the service so a stale user reference never
        outlives the state."""

        user = obj.rejected_by
        if user is None:
            return None
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


class RejectRequestSerializer(serializers.Serializer):
    """Body for ``POST /cff-submissions/<id>/reject/``.

    ``reason`` is required and non-blank — the point of storing the
    rejection is that the audit trail can answer "why did we say no".
    """

    reason = serializers.CharField(min_length=1, max_length=2000, trim_whitespace=True)


class UnassignFromProjectRequestSerializer(serializers.Serializer):
    """Body for ``POST /cff-submissions/<id>/unassign/``.

    ``project_id`` is optional:

    * Omitted (or ``null``) → detach **every** link the CFF holds.
      Same behaviour as the legacy single-FK unassign call.
    * Supplied → detach only that one link.
    """

    project_id = serializers.UUIDField(required=False, allow_null=True)


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
