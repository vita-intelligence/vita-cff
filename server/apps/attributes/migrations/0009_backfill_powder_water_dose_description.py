"""Backfill the help-text description on the
``powder_water_dose_mg_per_ml`` system attribute for every existing
organisation. New orgs already pick it up via the catalogues signal
handler; this migration covers the rows seeded before the
``description`` field existed on :class:`AttributeDefinition`.
"""

from __future__ import annotations

from django.db import migrations


_DESCRIPTION = (
    "One rate per raw material; the formulation engine reads this "
    "value off each pick and interprets the unit by the item's "
    "use_as: mg per ml of reconstitution water for Acidity Regulator "
    "items, mg per gram of finished powder for Flavouring, Sweetener, "
    "and Colour items."
)


def _seed(apps, schema_editor):
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    AttributeDefinition.objects.filter(
        key="powder_water_dose_mg_per_ml",
        catalogue__slug="raw_materials",
        description="",
    ).update(description=_DESCRIPTION)


def _unseed(apps, schema_editor):
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    AttributeDefinition.objects.filter(
        key="powder_water_dose_mg_per_ml",
        catalogue__slug="raw_materials",
        description=_DESCRIPTION,
    ).update(description="")


class Migration(migrations.Migration):
    dependencies = [
        ("attributes", "0008_attributedefinition_description"),
    ]

    operations = [
        migrations.RunPython(_seed, _unseed),
    ]
