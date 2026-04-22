from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("product_validation", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="productvalidation",
            name="scientist_signature_image",
            field=models.TextField(
                blank=True,
                default="",
                help_text=(
                    "Base64 PNG data URL captured on the signature "
                    "pad at transition time. Required to move "
                    "``draft → in_progress``."
                ),
                verbose_name="scientist signature image",
            ),
        ),
        migrations.AddField(
            model_name="productvalidation",
            name="rd_manager_signature_image",
            field=models.TextField(
                blank=True,
                default="",
                help_text=(
                    "Base64 PNG data URL captured on the signature "
                    "pad at transition time. Required to reach "
                    "``passed`` / ``failed``."
                ),
                verbose_name="R&D manager signature image",
            ),
        ),
    ]
