"""Split the merged ``flavour_colour_items`` M2M into separate
``flavouring_items`` and ``colour_items`` relations.

Scientist direction (2026-04-24): the two bands sit at different
percentages of target gummy weight (Flavouring 0.4%, Colour 2%) and
must be picked independently. We add the two new relations, copy any
existing picks onto ``flavouring_items`` (the safer default — the
0.4% band understates if a colour leaks through, vs the 2% band
overshooting if the inverse happened), then drop the legacy field.
"""

from django.db import migrations, models


def _copy_flavour_colour_to_flavouring(apps, schema_editor):
    Formulation = apps.get_model("formulations", "Formulation")
    for formulation in Formulation.objects.all():
        legacy_items = list(formulation.flavour_colour_items.all())
        if legacy_items:
            formulation.flavouring_items.set(legacy_items)


class Migration(migrations.Migration):

    dependencies = [
        ("catalogues", "0001_initial"),
        ("formulations", "0018_glazing_items"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="flavouring_items",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Raw-material items used as flavour agents — e.g. "
                    "Natural Strawberry Flavour, Lemon Extract. Each "
                    "pick must carry use_as = 'Flavouring'. The "
                    "flavour total (0.4% of target gummy weight) "
                    "splits equally across picks and groups on the "
                    "spec sheet as 'Flavouring (Natural Strawberry, "
                    "Lemon Extract)'. Ignored for non-gummy forms."
                ),
                related_name="flavouring_formulations",
                to="catalogues.item",
                verbose_name="flavouring items",
            ),
        ),
        migrations.AddField(
            model_name="formulation",
            name="colour_items",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Raw-material items used as colours — e.g. "
                    "Beetroot Extract, Turmeric Oleoresin, Spirulina "
                    "Powder. Each pick must carry use_as = 'Colour'. "
                    "The colour total (2% of target gummy weight) "
                    "splits equally across picks and groups as "
                    "'Colour (Beetroot Extract, Turmeric)'. Ignored "
                    "for non-gummy forms."
                ),
                related_name="colour_formulations",
                to="catalogues.item",
                verbose_name="colour items",
            ),
        ),
        migrations.RunPython(
            _copy_flavour_colour_to_flavouring,
            migrations.RunPython.noop,
        ),
        migrations.RemoveField(
            model_name="formulation",
            name="flavour_colour_items",
        ),
    ]
