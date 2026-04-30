"""Add ``sweetener_items`` M2M so the powder sweetener row can be
backed by real catalogue items (Sucralose, Stevia, Steviol, etc.)
instead of a generic placeholder. Mirrors the gummy picker pattern
(:class:`acidity_items`, :class:`flavouring_items`, …) but pulls
exclusively from items tagged ``use_as = "Sweeteners"`` — bulking
agents are deliberately excluded because the powder sweetener row
is a flavour-facing pick, not the structural bulk a gummy base
provides. Empty list keeps the existing placeholder behaviour —
fully backwards-compatible.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalogues", "0001_initial"),
        ("formulations", "0022_formulation_acidity_items"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="sweetener_items",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Raw-material items used as sweeteners on a powder "
                    "— Sucralose, Stevia, Steviol, etc. Each pick must "
                    "carry use_as = 'Sweeteners'. The sweetener total "
                    "(concentration × water volume, 0.06 mg/ml × ml) "
                    "splits **equally** across picks; the declaration "
                    "groups them as 'Sweetener (Sucralose, Stevia)'. "
                    "Empty list leaves a generic placeholder row. "
                    "Ignored for non-powder forms."
                ),
                related_name="sweetener_formulations",
                to="catalogues.item",
                verbose_name="sweetener items",
            ),
        ),
    ]
