from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0008_formulation_sales_person"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="target_fill_weight_mg",
            field=models.DecimalField(
                blank=True,
                decimal_places=4,
                help_text=(
                    "Target fill weight per serving unit — sachet mass "
                    "for powders, single-gummy weight for gummies. "
                    "Drives the excipient remainder calculation (carrier "
                    "for powders, gummy base for gummies). Leave blank "
                    "for capsule/tablet where the math uses the "
                    "selected size instead."
                ),
                max_digits=12,
                null=True,
                verbose_name="target fill weight (mg)",
            ),
        ),
    ]
