"""Adds ``purpose`` to ``FormulationPhoto`` so the internal Setup > Photos
gallery and the customer-facing RTG catalog gallery can share the model
without stepping on each other's ``is_primary`` / ``sort_order``.

Existing rows all default to ``internal`` — matches how they've been
used to date (Setup > Photos reference shots for the scientist).
Catalog rows come in via the RTG panel gallery from now on.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0068_formulation_rtg_page_content_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulationphoto",
            name="purpose",
            field=models.CharField(
                choices=[
                    ("internal", "Internal spec / label reference"),
                    ("catalog", "Ready-to-Go catalog storefront"),
                ],
                default="internal",
                help_text=(
                    "Which surface this photo belongs to. Internal photos "
                    "live on the Setup tab for the scientist; catalog "
                    "photos drive the customer-facing RTG storefront."
                ),
                max_length=16,
                verbose_name="purpose",
            ),
        ),
        migrations.AlterModelOptions(
            name="formulationphoto",
            options={
                "ordering": ("-is_primary", "sort_order", "uploaded_at"),
                "verbose_name": "formulation photo",
                "verbose_name_plural": "formulation photos",
            },
        ),
        migrations.RemoveIndex(
            model_name="formulationphoto",
            name="formulation_formula_ce1f85_idx",
        ),
        migrations.AddIndex(
            model_name="formulationphoto",
            index=models.Index(
                fields=("formulation", "purpose", "-is_primary", "sort_order"),
                name="formphoto_scope_idx",
            ),
        ),
    ]
