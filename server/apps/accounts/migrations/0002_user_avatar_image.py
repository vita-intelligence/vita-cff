from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="user",
            name="avatar_image",
            field=models.TextField(
                blank=True,
                default="",
                help_text=(
                    "Base64 data URL the user uploaded as their "
                    "profile photo. Rendered alongside the name in "
                    "the comments feed, presence roster, and "
                    "mentions. Empty renders as initials. When we "
                    "migrate to blob storage, this column gets "
                    "swapped for a URL — every consumer already "
                    "treats the value as opaque."
                ),
                verbose_name="avatar image",
            ),
        ),
    ]
