"""Per-line purity / overage / extract-ratio overrides.

Scientists tune these per formulation when a specific product (or a
batch / supplier variant) deviates from the catalogue's master spec.
The override wins for that one formulation; the catalogue stays the
source of truth for everything else.

All three fields are nullable — null means "use the catalogue value",
matching the behaviour every existing formulation already has.
Additive migration with no backfill, so it is safe to deploy ahead of
the UI that exposes the inputs.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0024_rename_colourant_to_colour_in_snapshots"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulationline",
            name="purity_override",
            field=models.DecimalField(
                blank=True,
                decimal_places=4,
                help_text=(
                    "Override the raw material's purity for this "
                    "formulation only. Leave blank to use the "
                    "catalogue value."
                ),
                max_digits=8,
                null=True,
                verbose_name="purity override",
            ),
        ),
        migrations.AddField(
            model_name="formulationline",
            name="overage_override",
            field=models.DecimalField(
                blank=True,
                decimal_places=4,
                help_text=(
                    "Override the raw material's overage for this "
                    "formulation only. Leave blank to use the "
                    "catalogue value."
                ),
                max_digits=8,
                null=True,
                verbose_name="overage override",
            ),
        ),
        migrations.AddField(
            model_name="formulationline",
            name="extract_ratio_override",
            field=models.DecimalField(
                blank=True,
                decimal_places=4,
                help_text=(
                    "Override the raw material's extract ratio "
                    "(botanical items only). Leave blank to use the "
                    "catalogue value."
                ),
                max_digits=10,
                null=True,
                verbose_name="extract ratio override",
            ),
        ),
    ]
