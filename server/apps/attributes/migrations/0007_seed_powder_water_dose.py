"""Seed the ``powder_water_dose_mg_per_ml`` attribute on every existing
organisation's ``raw_materials`` catalogue.

The catalogues signal handler seeds this attribute for all newly created
organisations going forward. This migration covers the back-population
so tenants created before the signal was extended also expose the
column on their items table without a manual click-through. Idempotent:
re-running the migration never duplicates the row or overwrites a
label that a scientist may have already customised.
"""

from __future__ import annotations

from django.db import migrations


_KEY = "powder_water_dose_mg_per_ml"
_LABEL = "Powder Water Dose (mg/ml)"
_DATA_TYPE = "number"


def _seed(apps, schema_editor):
    Catalogue = apps.get_model("catalogues", "Catalogue")
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")

    raw_material_catalogues = Catalogue.objects.filter(slug="raw_materials")
    for catalogue in raw_material_catalogues.iterator():
        actor = catalogue.organization.created_by
        AttributeDefinition.objects.get_or_create(
            catalogue=catalogue,
            key=_KEY,
            defaults={
                "label": _LABEL,
                "data_type": _DATA_TYPE,
                "required": False,
                "options": [],
                "display_order": 0,
                "created_by": actor,
                "updated_by": actor,
            },
        )


def _unseed(apps, schema_editor):
    AttributeDefinition = apps.get_model("attributes", "AttributeDefinition")
    AttributeDefinition.objects.filter(
        key=_KEY, catalogue__slug="raw_materials"
    ).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("attributes", "0006_add_gelling_agent_to_use_as"),
        ("catalogues", "0001_initial"),
    ]

    operations = [
        migrations.RunPython(_seed, _unseed),
    ]
