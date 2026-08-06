"""Add ``packaging_combo`` FK to :class:`TrialBatch`.

Nullable + ``SET_NULL`` on delete. Nullable because:

* ``trial``-kind batches never have packaging (bench-scale tests
  bypass the pack stage entirely) so the column is legitimately
  empty on those rows.
* ``sample``-kind batches default to "no combo picked" — the
  scientist can plan a sample without any packaging (loose bulk
  output). Empty is meaningful, not missing.
* A formulation whose PackagingCombo is deleted after a batch was
  planned against it should not blow up the batch history — we
  keep the batch row and null the FK so audit still resolves.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("trial_batches", "0005_replace_batch_size_mode_with_kind"),
        ("formulations", "0070_packagingcombo_stage"),
    ]

    operations = [
        migrations.AddField(
            model_name="trialbatch",
            name="packaging_combo",
            field=models.ForeignKey(
                null=True,
                blank=True,
                on_delete=models.SET_NULL,
                related_name="trial_batches",
                to="formulations.packagingcombo",
                help_text=(
                    "Optional packaging overlay for sample batches. "
                    "``NULL`` = no combo picked (loose-bulk output or "
                    "trial-kind bench run); populated = the PSP MO's "
                    "packaging BOM lines are replaced by the combo's "
                    "items at MO-create time."
                ),
            ),
        ),
    ]
