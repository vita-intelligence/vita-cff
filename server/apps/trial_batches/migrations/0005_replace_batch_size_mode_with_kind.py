"""Replace ``batch_size_mode`` (pack | unit) with ``kind`` (trial | sample).

The two fields were fighting for the same conceptual space: the old
``batch_size_mode`` chose how to interpret the numeric input, while
the downstream PSP MO carried a separate ``project_type`` (trial vs
sample) that drives the release flow. This migration collapses them
into one field so the scientist picks the *kind of run* once and both
the BOM scaling and the release path fall out of it.

Value mapping:

* ``pack`` → ``sample`` — full-pack production run, PSP MO runs as
  ``project_type=sample`` and follows commercial release.
* ``unit`` → ``trial`` — bench-scale unit count, PSP MO runs as
  ``project_type=trial`` and bypasses Final Release.
"""

from __future__ import annotations

from django.db import migrations, models


def forwards(apps, schema_editor):
    TrialBatch = apps.get_model("trial_batches", "TrialBatch")
    TrialBatch.objects.filter(batch_size_mode="unit").update(kind="trial")
    TrialBatch.objects.filter(batch_size_mode="pack").update(kind="sample")


def backwards(apps, schema_editor):
    TrialBatch = apps.get_model("trial_batches", "TrialBatch")
    TrialBatch.objects.filter(kind="trial").update(batch_size_mode="unit")
    TrialBatch.objects.filter(kind="sample").update(batch_size_mode="pack")


class Migration(migrations.Migration):

    dependencies = [
        ("trial_batches", "0004_trialbatch_psp_all_stages_completed_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="trialbatch",
            name="kind",
            field=models.CharField(
                choices=[("trial", "Trial"), ("sample", "Sample")],
                default="sample",
                help_text=(
                    "``trial`` = bench-scale test, raw unit count, PSP MO "
                    "runs as project_type=trial (bypasses Final Release). "
                    "``sample`` = customer-sample production, entered number "
                    "× servings_per_pack, PSP MO runs as project_type=sample "
                    "(follows the commercial release path)."
                ),
                max_length=8,
                verbose_name="kind",
            ),
        ),
        migrations.RunPython(forwards, backwards),
        migrations.RemoveField(
            model_name="trialbatch",
            name="batch_size_mode",
        ),
        migrations.AlterField(
            model_name="trialbatch",
            name="batch_size_units",
            field=models.PositiveIntegerField(
                help_text=(
                    "Numeric input; interpretation depends on ``kind``. "
                    "For ``sample`` this is the number of finished packs "
                    "(bottles/pouches/tubs) and scales by servings_per_pack; "
                    "for ``trial`` it is the raw count of individual "
                    "capsules/tablets/scoops (no pack multiplier)."
                ),
                verbose_name="batch size",
            ),
        ),
    ]
