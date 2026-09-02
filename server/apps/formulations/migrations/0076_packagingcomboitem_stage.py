"""Adds a per-item ``stage`` override to ``PackagingComboItem``.

Lets scientists split a combo across stages — bottle+lid land at
bottling, label lands at labelling — without exploding one combo into
several sub-combos on the customer picker. When null, the item inherits
its parent combo's stage (unchanged behaviour).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0075_rtg_catalog_composite_idx"),
    ]

    operations = [
        migrations.AddField(
            model_name="packagingcomboitem",
            name="stage",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Override the combo's default stage for this specific "
                    "item. Leave blank to inherit the combo's stage."
                ),
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="packaging_combo_items",
                to="formulations.formulationstage",
            ),
        ),
    ]
