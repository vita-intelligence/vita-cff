"""Replace the multi-clause description on
``powder_water_dose_mg_per_ml`` with the unified water-volume copy.

The previous description differentiated between Acidity (mg/ml of
water) and Flavouring / Sweetener / Colour (mg/g of powder). The
math now scales every per-item powder band by the same
``water_volume_ml × rate`` formula, so the help text collapses to a
single sentence -- one rate, one unit, one interpretation.
"""

from __future__ import annotations

from django.db import migrations


_NEW_DESCRIPTION = (
    "Milligrams of this ingredient per millilitre of reconstitution "
    "water. Drives every powder flavour-system band -- Acidity, "
    "Flavouring, Sweetener, Colour -- so the same rate produces the "
    "same concentration in the final reconstituted drink. The "
    "formulation engine multiplies this value by the per-serving "
    "water volume to compute the mg per serving."
)


def _seed(apps, schema_editor):
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    AttributeDefinition.objects.filter(
        key="powder_water_dose_mg_per_ml",
        catalogue__slug="raw_materials",
    ).update(description=_NEW_DESCRIPTION)


def _unseed(apps, schema_editor):
    # Best-effort revert -- not deterministic since the previous
    # description was generated from constants.py, so we just clear
    # the field and let the next deploy reseed.
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    AttributeDefinition.objects.filter(
        key="powder_water_dose_mg_per_ml",
        catalogue__slug="raw_materials",
        description=_NEW_DESCRIPTION,
    ).update(description="")


class Migration(migrations.Migration):
    dependencies = [
        ("attributes", "0009_backfill_powder_water_dose_description"),
    ]

    operations = [
        migrations.RunPython(_seed, _unseed),
    ]
