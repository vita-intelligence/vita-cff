from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("specifications", "0007_specificationsheet_section_order"),
    ]

    operations = [
        migrations.AddField(
            model_name="specificationsheet",
            name="weight_uniformity",
            field=models.CharField(
                blank=True,
                default="",
                help_text=(
                    "Per-sheet override for the Weight Uniformity row. "
                    "Blank falls back to the organization default (10% "
                    "for capsule/tablet, ``Not applicable`` for "
                    "powder/liquid)."
                ),
                max_length=64,
                verbose_name="weight uniformity",
            ),
        ),
    ]
