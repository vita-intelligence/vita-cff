"""Wire format for the audit log API."""

from __future__ import annotations

from rest_framework import serializers

from apps.audit.models import AuditLog


class AuditActorSerializer(serializers.Serializer):
    id = serializers.CharField()
    full_name = serializers.CharField(allow_blank=True)
    email = serializers.EmailField()


class AuditLogReadSerializer(serializers.ModelSerializer):
    """Flat audit row — captures the action, target identity,
    payload diffs, and a denormalised actor block so the UI can
    render "who" without a second query per row."""

    actor = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = (
            "id",
            "action",
            "target_type",
            "target_id",
            "actor",
            "before",
            "after",
            "created_at",
        )
        read_only_fields = fields

    def get_actor(self, obj: AuditLog):  # type: ignore[override]
        user = obj.actor
        if user is None:
            return None
        full_name = (user.get_full_name() or "").strip()
        return {
            "id": str(user.pk),
            "full_name": full_name,
            "email": user.email,
        }
