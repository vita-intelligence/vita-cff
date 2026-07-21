"""Add ``snapshot_stage_boms`` JSON field to FormulationVersion.

Captures the FE-computed per-stage BOM (actives + every excipient
band split across picked SKUs) at save-version time so history
preserves exactly what each stage's PSP item held. Keyed by stage
uuid; each entry is a list of ``{item_id, mg, sort_order, label,
code}`` rows. Backfill = empty dict — existing snapshots reconstruct
per-stage assignments from ``snapshot_lines[*].stage_id`` on read
(added in a companion refactor).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0052_seed_stage_templates"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulationversion",
            name="snapshot_stage_boms",
            field=models.JSONField(
                blank=True,
                default=dict,
                verbose_name="snapshot stage BOMs",
            ),
        ),
    ]
