"""Normalise ``use_as`` onto a controlled single-select vocabulary.

Two changes in one migration, run atomically so the validator and the
stored values are never inconsistent:

1. Walk every :class:`Item` whose ``attributes`` carries a ``use_as``
   value and canonicalise it (``"Sweetners" → "Sweeteners"``,
   ``"active" → "Active"``, casing drift, etc.) using the
   :data:`apps.formulations.constants.USE_AS_NORMALISATION` map.
2. Flip every ``use_as`` :class:`AttributeDefinition` from ``text`` to
   ``single_select`` with the canonical vocab as its ``options``.
   After the flip, the attribute validator rejects off-vocab writes so
   the data can't re-drift.

Downgrade reverses step 2 (back to ``text``, wipe options); it cannot
restore the original typo'd values since we deliberately destroy that
history — they were bugs, not data.
"""

from __future__ import annotations

from django.db import migrations


_USE_AS_KEY = "use_as"


def _normalise(raw):
    # Local import — ``apps.formulations.constants`` is imported lazily
    # so the migration doesn't pull Django signals at module import on
    # a fresh migrate.
    from apps.formulations.constants import (
        USE_AS_CANONICAL_VALUES,
        normalize_use_as_value,
    )

    if raw is None:
        return None
    normalised = normalize_use_as_value(raw)
    if normalised == "":
        return None
    # If normalisation produced something outside the canonical list
    # (a value we didn't anticipate) preserve the trimmed original so a
    # scientist can fix it manually via the UI rather than losing it.
    if normalised not in USE_AS_CANONICAL_VALUES:
        return raw
    return normalised


def _normalise_items(apps, schema_editor):
    Item = apps.get_model("catalogues", "Item")
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")

    # Item lives on a catalogue; ``use_as`` is only meaningful on the
    # raw-materials catalogue but we don't restrict here — if an admin
    # added ``use_as`` elsewhere we still normalise rather than leave
    # their data half-canonical.
    for item in Item.objects.all().iterator():
        attrs = item.attributes or {}
        if _USE_AS_KEY not in attrs:
            continue
        raw = attrs.get(_USE_AS_KEY)
        fixed = _normalise(raw)
        if fixed == raw:
            continue
        if fixed is None:
            attrs.pop(_USE_AS_KEY, None)
        else:
            attrs[_USE_AS_KEY] = fixed
        item.attributes = attrs
        item.save(update_fields=["attributes", "updated_at"])


def _convert_definitions(apps, schema_editor):
    from apps.formulations.constants import USE_AS_CANONICAL_VALUES

    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    options = [
        {"value": v, "label": v} for v in USE_AS_CANONICAL_VALUES
    ]
    for definition in AttributeDefinition.objects.filter(key=_USE_AS_KEY):
        definition.data_type = "single_select"
        definition.options = options
        definition.save(update_fields=["data_type", "options", "updated_at"])


def _revert_definitions(apps, schema_editor):
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    for definition in AttributeDefinition.objects.filter(key=_USE_AS_KEY):
        definition.data_type = "text"
        definition.options = []
        definition.save(update_fields=["data_type", "options", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("attributes", "0002_initial"),
        ("catalogues", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(_normalise_items, migrations.RunPython.noop),
        migrations.RunPython(_convert_definitions, _revert_definitions),
    ]
