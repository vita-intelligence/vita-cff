from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0011_formulation_water_volume_ml"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="approved_version_number",
            field=models.PositiveIntegerField(
                blank=True,
                help_text=(
                    "Points at the FormulationVersion snapshot the "
                    "scientist marked as the current approved recipe. "
                    "Every version picker in the app (trial batch, "
                    "spec sheet, QC) badges this number so a teammate "
                    "never plans a procurement run off a stale draft."
                ),
                null=True,
                verbose_name="approved version number",
            ),
        ),
    ]
