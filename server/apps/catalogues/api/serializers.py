"""Serializers for the catalogues API."""

from __future__ import annotations

from typing import Any

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.attributes.services import validate_values
from apps.catalogues.models import Catalogue, Item


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


# ---------------------------------------------------------------------------
# System-reserved attribute keys
# ---------------------------------------------------------------------------
#
# ``attributes`` on an item is normally a dict validated against the
# catalogue's :class:`AttributeDefinition` rows — anything without a
# matching definition is silently dropped by ``validate_values``. That
# is the correct behaviour for user-defined columns (a stale form
# submit shouldn't fail writes), but there is a small set of SYSTEM
# concepts we want to store on the same JSON blob so ops can flip them
# from the item edit form without a schema migration.
#
# Reserved keys:
# * ``default_for_bands`` — list[str], e.g. ``["gummy_water"]``. Flags
#   an item as the org's default for one or more auto-inject bands
#   (see :func:`apps.formulations.services.resolve_default_item_for_band`).
#
# Any key listed here is:
#   1. Passed through ``validate_values`` unchanged (not dropped).
#   2. Coerced to the expected type below (list-of-str) with a
#      ``default_for_bands: invalid`` error surfaced when malformed.
#
SYSTEM_ATTRIBUTE_KEYS: frozenset[str] = frozenset({"default_for_bands"})


def _coerce_system_attribute(key: str, value: Any) -> tuple[Any, str | None]:
    """Type-coerce a system-reserved attribute value. Returns
    ``(coerced, error_code)`` — ``error_code`` is ``None`` on success."""

    if key == "default_for_bands":
        if value is None or value == "":
            return [], None
        if not isinstance(value, list):
            return None, "invalid"
        coerced: list[str] = []
        for entry in value:
            if not isinstance(entry, str):
                return None, "invalid"
            trimmed = entry.strip()
            if trimmed:
                coerced.append(trimmed)
        # De-dup while preserving order so a UI double-submit doesn't
        # bloat the list.
        seen: set[str] = set()
        deduped: list[str] = []
        for entry in coerced:
            if entry in seen:
                continue
            seen.add(entry)
            deduped.append(entry)
        return deduped, None

    # Unknown key in the reserved set — defensive default. Adding a
    # new key to ``SYSTEM_ATTRIBUTE_KEYS`` requires a matching branch
    # here; otherwise the value is dropped.
    return None, "invalid"


# ---------------------------------------------------------------------------
# Catalogue metadata
# ---------------------------------------------------------------------------


class CatalogueReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = Catalogue
        fields = (
            "id",
            "slug",
            "name",
            "description",
            "is_system",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class CatalogueCreateSerializer(serializers.Serializer):
    slug = serializers.CharField(max_length=64)
    name = serializers.CharField(max_length=150)
    description = serializers.CharField(
        max_length=2000, required=False, allow_blank=True, default=""
    )

    def validate_slug(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


class CatalogueUpdateSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=150, required=False)
    description = serializers.CharField(
        max_length=2000, required=False, allow_blank=True
    )

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        return trimmed


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------


class ItemReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = Item
        fields = (
            "id",
            "name",
            "internal_code",
            "unit",
            "base_price",
            "is_archived",
            "attributes",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class ItemWriteSerializer(serializers.ModelSerializer):
    """Input shape for both item create and update.

    ``catalogue`` is never accepted from the body — it comes from the
    URL. ``created_by`` / ``updated_by`` are set by the view based on
    the authenticated caller, never trusted from input.
    """

    attributes = serializers.DictField(
        child=serializers.JSONField(allow_null=True),
        required=False,
    )

    class Meta:
        model = Item
        fields = (
            "name",
            "internal_code",
            "unit",
            "base_price",
            "is_archived",
            "attributes",
        )
        extra_kwargs = {
            "name": {"required": True, "allow_blank": False},
            "internal_code": {"required": False, "allow_blank": True},
            "unit": {"required": False, "allow_blank": True},
            "base_price": {"required": False, "allow_null": True},
            "is_archived": {"required": False},
        }

    def validate_name(self, value: str) -> str:
        trimmed = value.strip()
        if not trimmed:
            raise serializers.ValidationError(_code("blank"))
        if len(trimmed) > 200:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed

    def validate_internal_code(self, value: str) -> str:
        trimmed = (value or "").strip()
        if len(trimmed) > 64:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed

    def validate_unit(self, value: str) -> str:
        trimmed = (value or "").strip()
        if len(trimmed) > 32:
            raise serializers.ValidationError(_code("max_length"))
        return trimmed

    def validate(self, attrs: dict[str, Any]) -> dict[str, Any]:
        if "attributes" not in attrs:
            return attrs

        catalogue = self.context.get("catalogue")
        if catalogue is None:
            raise serializers.ValidationError(
                {"attributes": [_code("invalid")]}
            )

        incoming = dict(attrs["attributes"] or {})
        instance = getattr(self, "instance", None)
        if self.partial and instance is not None:
            merged = dict(instance.attributes or {})
            merged.update(incoming)
            incoming = merged

        # Carve out system-reserved keys BEFORE ``validate_values``
        # runs — that helper only knows about ``AttributeDefinition``
        # rows and drops everything else silently. Reserved keys ride
        # the same JSON blob for convenience (ops can flip them from
        # the item edit form) but their coercion is hardcoded in
        # :func:`_coerce_system_attribute`. Errors surface under the
        # attribute key so the FE renders them next to the right input.
        system_values: dict[str, Any] = {}
        system_errors: dict[str, list[str]] = {}
        for key in list(incoming.keys()):
            if key in SYSTEM_ATTRIBUTE_KEYS:
                coerced_value, sys_error = _coerce_system_attribute(
                    key, incoming.pop(key)
                )
                if sys_error is not None:
                    system_errors[key] = [sys_error]
                    continue
                system_values[key] = coerced_value

        coerced, errors = validate_values(
            catalogue=catalogue,
            incoming=incoming,
        )
        # Merge system-key errors on top of definition errors so the FE
        # receives both in a single 400 payload.
        for key, codes in system_errors.items():
            errors.setdefault(key, []).extend(codes)
        if errors:
            codified = {
                key: [_code(c) for c in codes]
                for key, codes in errors.items()
            }
            raise serializers.ValidationError({"attributes": codified})

        # Fold system values back onto the coerced dict so the
        # ``update_item`` service persists them alongside the
        # definition-backed attributes.
        coerced.update(system_values)
        attrs["attributes"] = coerced
        return attrs
