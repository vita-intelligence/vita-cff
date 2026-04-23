from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0009_formulation_target_fill_weight_mg"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="powder_type",
            field=models.CharField(
                choices=[
                    ("standard", "Standard"),
                    ("protein", "Protein"),
                ],
                default="standard",
                help_text=(
                    "Sub-variant of the Powder dosage form. Protein "
                    "powders omit Trisodium Citrate + Citric Acid "
                    "from the flavour system because the protein "
                    "matrix already buffers itself. Ignored for "
                    "non-powder forms."
                ),
                max_length=16,
                verbose_name="powder type",
            ),
        ),
    ]
