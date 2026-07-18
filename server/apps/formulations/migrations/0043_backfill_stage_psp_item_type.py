"""Backfill ``psp_item_type`` on existing stages.

Every formulation's terminal stage (highest ``sort_order``) becomes
``finished_product``; every other stage keeps the schema default
``semi_finished``. Mirrors the position-based semantics the push
cascade used before ``psp_item_type`` became explicit, so no
existing formulation flips its PSP identity from the migration.

Idempotent — the WHERE clause skips rows that already match. Rolling
back is a no-op (data-only migration; the columns get dropped by
the schema migration one down the chain).
"""

from django.db import migrations
from django.db.models import Max


def backfill_terminal_finished(apps, schema_editor):
    FormulationStage = apps.get_model("formulations", "FormulationStage")
    # For each formulation, find the max sort_order and flip that
    # stage's psp_item_type to finished_product.
    formulations = (
        FormulationStage.objects.values("formulation_id")
        .annotate(max_sort=Max("sort_order"))
    )
    for row in formulations:
        FormulationStage.objects.filter(
            formulation_id=row["formulation_id"],
            sort_order=row["max_sort"],
        ).exclude(psp_item_type="finished_product").update(
            psp_item_type="finished_product"
        )


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        (
            "formulations",
            "0042_formulationstage_psp_item_description_and_more",
        ),
    ]

    operations = [
        migrations.RunPython(backfill_terminal_finished, noop),
    ]
