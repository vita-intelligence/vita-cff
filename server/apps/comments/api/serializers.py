"""Serializers for the comments API.

The read shape is the single source of truth for what the frontend
renders — once a field appears here, the client-side
``CommentDto`` inherits it and the UI surfaces it. Keep the shape
flat (no nested comment trees) — the client assembles the thread
tree from ``parent`` pointers.
"""

from __future__ import annotations

from rest_framework import serializers

from apps.comments.models import Comment


class CommentAuthorSerializer(serializers.Serializer):
    """Flat projection of either an authenticated author or a guest.

    The shape mirrors what the spec-sheet sales-person menu uses so
    the frontend already has a component for it.
    """

    id = serializers.CharField(required=False, allow_null=True)
    kind = serializers.CharField()  # "member" or "guest"
    name = serializers.CharField()
    email = serializers.CharField(required=False, allow_blank=True)
    org_label = serializers.CharField(required=False, allow_blank=True)


class CommentMentionRefSerializer(serializers.Serializer):
    """Reference to a user mentioned inside a comment body."""

    id = serializers.CharField()
    name = serializers.CharField()
    email = serializers.CharField()


class CommentReadSerializer(serializers.ModelSerializer):
    """Read shape exposed by the list / detail endpoints.

    ``parent_id`` is emitted as a string so the UI does not need to
    reason about Python UUID instances; ``target`` fields are
    resolved on the backend so the client never has to look at
    ``content_type`` / ``object_id``.
    """

    id = serializers.CharField(read_only=True)
    parent_id = serializers.SerializerMethodField()
    target_type = serializers.SerializerMethodField()
    target_id = serializers.SerializerMethodField()
    author = serializers.SerializerMethodField()
    mentions = serializers.SerializerMethodField()
    created_at = serializers.DateTimeField(read_only=True)
    updated_at = serializers.DateTimeField(read_only=True)
    resolved_at = serializers.DateTimeField(read_only=True)
    edited_at = serializers.DateTimeField(read_only=True)
    deleted_at = serializers.DateTimeField(read_only=True)

    class Meta:
        model = Comment
        fields = (
            "id",
            "parent_id",
            "target_type",
            "target_id",
            "author",
            "body",
            "mentions",
            "needs_resolution",
            "is_resolved",
            "is_edited",
            "is_deleted",
            "created_at",
            "updated_at",
            "edited_at",
            "resolved_at",
            "deleted_at",
        )

    def get_parent_id(self, obj: Comment) -> str | None:
        return str(obj.parent_id) if obj.parent_id else None

    def get_target_type(self, obj: Comment) -> str:
        if obj.formulation_id is not None:
            return "formulation"
        if obj.specification_sheet_id is not None:
            return "specification"
        return "unknown"

    def get_target_id(self, obj: Comment) -> str | None:
        if obj.formulation_id is not None:
            return str(obj.formulation_id)
        if obj.specification_sheet_id is not None:
            return str(obj.specification_sheet_id)
        return None

    def get_author(self, obj: Comment) -> dict:
        if obj.is_deleted:
            return {
                "id": None,
                "kind": "system",
                "name": "",
                "email": "",
                "org_label": "",
            }
        if obj.author_id and obj.author is not None:
            user = obj.author
            return {
                "id": str(user.id),
                "kind": "member",
                "name": (user.get_full_name() or user.email).strip(),
                "email": user.email,
                "org_label": "",
            }
        return {
            "id": None,
            "kind": "guest",
            "name": obj.guest_name,
            "email": obj.guest_email,
            "org_label": obj.guest_org_label,
        }

    def get_mentions(self, obj: Comment) -> list[dict]:
        if obj.is_deleted:
            return []
        rows = obj.mentions.select_related("mentioned_user").all()
        return [
            {
                "id": str(row.mentioned_user_id),
                "name": (
                    row.mentioned_user.get_full_name()
                    or row.mentioned_user.email
                ).strip(),
                "email": row.mentioned_user.email,
            }
            for row in rows
        ]


def _validate_body(value: str) -> str:
    """Reject bodies that collapse to whitespace. Emitting the code
    through ``ValidationError(..., code=...)`` keeps the codified
    handler on the happy path — the default ``blank`` / ``required``
    codes leak DRF internals to the frontend otherwise.
    """

    if not (value or "").strip():
        raise serializers.ValidationError(
            "comment_body_blank", code="comment_body_blank"
        )
    return value


class CommentCreateSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=10_000, allow_blank=True)
    parent_id = serializers.UUIDField(required=False, allow_null=True)

    def validate_body(self, value: str) -> str:
        return _validate_body(value)


class CommentEditSerializer(serializers.Serializer):
    body = serializers.CharField(max_length=10_000, allow_blank=True)

    def validate_body(self, value: str) -> str:
        return _validate_body(value)


class MentionableMemberSerializer(serializers.Serializer):
    id = serializers.CharField()
    name = serializers.CharField()
    email = serializers.CharField()
