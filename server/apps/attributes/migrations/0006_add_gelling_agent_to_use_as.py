"""Extend the ``use_as`` controlled vocabulary with ``Gelling Agent``.

Mirrors :mod:`apps.attributes.migrations.0005_add_glazing_agent_to_use_as`:

1. Walk every catalogue :class:`Item` and fold any historical pectin
   / gelatin / agar / "gel" tagging onto the canonical ``Gelling
   Agent`` value via :func:`normalize_use_as_value`.
2. Refresh the ``use_as`` :class:`AttributeDefinition`'s ``options``
   list so the single-select dropdown surfaces the new entry.

Safe to re-run.
"""

from __future__ import annotations

from django.db import migrations


_USE_AS_KEY = "use_as"


def _normalise_items(apps, schema_editor):
    from apps.formulations.constants import (
        USE_AS_CANONICAL_VALUES,
        normalize_use_as_value,
    )

    Item = apps.get_model("catalogues", "Item")
    for item in Item.objects.all().iterator():
        attrs = item.attributes or {}
        raw = attrs.get(_USE_AS_KEY)
        if raw is None:
            continue
        normalised = normalize_use_as_value(str(raw))
        if not normalised:
            continue
        if normalised not in USE_AS_CANONICAL_VALUES:
            continue
        if normalised != raw:
            attrs[_USE_AS_KEY] = normalised
            item.attributes = attrs
            item.save(update_fields=["attributes", "updated_at"])


def _refresh_options(apps, schema_editor):
    from apps.formulations.constants import USE_AS_CANONICAL_VALUES

    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    options = [{"value": v, "label": v} for v in USE_AS_CANONICAL_VALUES]
    for definition in AttributeDefinition.objects.filter(key=_USE_AS_KEY):
        definition.options = options
        definition.save(update_fields=["options", "updated_at"])


class Migration(migrations.Migration):

    dependencies = [
        ("attributes", "0005_add_glazing_agent_to_use_as"),
        ("catalogues", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(_normalise_items, migrations.RunPython.noop),
        migrations.RunPython(_refresh_options, migrations.RunPython.noop),
    ]
