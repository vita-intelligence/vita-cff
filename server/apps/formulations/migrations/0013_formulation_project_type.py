from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0012_formulation_approved_version_number"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="project_type",
            field=models.CharField(
                choices=[
                    ("custom", "Custom"),
                    ("ready_to_go", "Ready to Go"),
                ],
                db_index=True,
                default="custom",
                help_text=(
                    "Custom (bespoke development + deposit) vs Ready "
                    "to Go (existing recipe, faster turnaround). "
                    "Drives the proposal template rendered for the "
                    "client."
                ),
                max_length=16,
                verbose_name="project type",
            ),
        ),
    ]
