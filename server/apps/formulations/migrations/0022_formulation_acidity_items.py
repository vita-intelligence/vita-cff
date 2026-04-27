"""Add ``acidity_items`` M2M so the gummy acidity regulator band
can be backed by real catalogue items (Citric Acid, Trisodium
Citrate, etc.) instead of a generic placeholder. Empty list keeps
the existing placeholder behaviour — fully backwards-compatible.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalogues", "0001_initial"),
        ("formulations", "0021_alter_formulation_gelling_items_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="acidity_items",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Raw-material items used as the acidity regulator "
                    "on a gummy — Citric Acid, Trisodium Citrate, "
                    "Sodium Citrate, etc. Each pick must carry "
                    "use_as = 'Acidity Regulator'. The acidity total "
                    "(2% of target gummy weight) splits **equally** "
                    "across picks; the declaration groups them as "
                    "'Acidity Regulator (Citric Acid, …)'. Empty "
                    "list leaves a placeholder row — scientists "
                    "must pick items before the MRPeasy BOM is "
                    "procurement-ready."
                ),
                related_name="acidity_formulations",
                to="catalogues.item",
                verbose_name="acidity regulator items",
            ),
        ),
    ]
