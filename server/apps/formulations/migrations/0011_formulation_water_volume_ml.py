from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0010_formulation_powder_type"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="water_volume_ml",
            field=models.DecimalField(
                blank=True,
                decimal_places=2,
                help_text=(
                    "Volume of water the powder is designed to "
                    "dissolve in (per serving). Drives the "
                    "flavour-system mg concentrations — the preset "
                    "values assume a 500ml reference serving, so "
                    "lowering to 250ml halves every flavour row and "
                    "raising to 1000ml doubles them. Ignored for "
                    "non-powder forms."
                ),
                max_digits=8,
                null=True,
                verbose_name="water volume (ml)",
            ),
        ),
    ]
