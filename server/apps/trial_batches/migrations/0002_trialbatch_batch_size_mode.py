from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("trial_batches", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="trialbatch",
            name="batch_size_mode",
            field=models.CharField(
                choices=[
                    ("pack", "Pack"),
                    ("unit", "Individual units"),
                ],
                default="pack",
                help_text=(
                    "``pack`` multiplies by servings_per_pack; "
                    "``unit`` uses the entered number directly. "
                    "Bench-scale QC tests usually want ``unit`` so "
                    "a 10-capsule test does not get scaled up to "
                    "10 × 360 = 3 600."
                ),
                max_length=8,
                verbose_name="batch size mode",
            ),
        ),
        migrations.AlterField(
            model_name="trialbatch",
            name="batch_size_units",
            field=models.PositiveIntegerField(
                help_text=(
                    "Numeric input; interpretation depends on "
                    "``batch_size_mode``. In ``pack`` mode this is "
                    "the number of finished packs "
                    "(bottles/pouches/tubs); in ``unit`` mode it is "
                    "the raw count of individual "
                    "capsules/tablets/scoops."
                ),
                verbose_name="batch size",
            ),
        ),
    ]
