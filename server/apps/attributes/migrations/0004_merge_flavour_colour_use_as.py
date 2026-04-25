"""Collapse ``Flavouring`` + ``Colourant`` onto ``Flavouring and Colour``.

Per scientist direction (2026-04-24) the two functional categories
are treated as a single block on gummy / powder labels. This
migration:

1. Rewrites every ``Item.attributes.use_as`` whose stored value
   resolves to ``Flavouring`` or ``Colourant`` (or any of their
   historical spelling variants) onto the single ``Flavouring and
   Colour`` canonical value.
2. Refreshes the ``use_as`` :class:`AttributeDefinition`'s
   ``options`` list so the single-select dropdown stops offering
   ``Colourant`` / ``Flavouring`` as separate picks.

Idempotent — already-canonical values pass through untouched. Safe
to re-run: the first pass normalises, the second is a no-op.
"""

from __future__ import annotations

from django.db import migrations


_USE_AS_KEY = "use_as"


def _merge_flavour_colour(apps, schema_editor):
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
            # Off-vocab value (e.g. an admin dropped a custom string) —
            # leave alone, the builder's UI will surface it so they
            # can fix manually.
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
        ("attributes", "0003_normalise_use_as"),
        ("catalogues", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(_merge_flavour_colour, migrations.RunPython.noop),
        migrations.RunPython(_refresh_options, migrations.RunPython.noop),
    ]
