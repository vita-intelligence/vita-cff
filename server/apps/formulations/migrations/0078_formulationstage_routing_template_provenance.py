"""Record which PSP routing template a FormulationStage was hydrated from.

Two UUIDs land on each stage: the template header and the specific
step within it. The builder sets them when the scientist picks a
template from PSP's new routing-template surface, and the sync
cascade forwards them to PSP so each per-stage snapshot can stamp
``source_template_id`` / ``source_routing_step_id`` back to the
template rows the stages came from.

Both are nullable — pre-template-flow stages and any ad-hoc stages
the scientist might still be allowed to draft keep provenance null,
and the UI reads them as "freely editable, no template lock".
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0077_formulation_is_reorder_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulationstage",
            name="source_routing_template_uuid",
            field=models.UUIDField(
                blank=True,
                db_index=True,
                null=True,
                verbose_name="PSP routing-template UUID",
            ),
        ),
        migrations.AddField(
            model_name="formulationstage",
            name="source_routing_step_uuid",
            field=models.UUIDField(
                blank=True,
                db_index=True,
                null=True,
                verbose_name="PSP routing-template step UUID",
            ),
        ),
    ]
