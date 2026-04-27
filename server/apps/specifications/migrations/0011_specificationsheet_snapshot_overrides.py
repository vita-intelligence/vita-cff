"""Add ``snapshot_overrides`` JSON for last-mile spec-sheet edits.

Phase G5a — single field, default empty dict, fully backwards
compatible. Existing sheets render exactly as before until a
scientist starts editing.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("specifications", "0010_specificationsheet_document_kind"),
    ]

    operations = [
        migrations.AddField(
            model_name="specificationsheet",
            name="snapshot_overrides",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Per-sheet overrides applied on top of the "
                    "frozen formulation snapshot at render time. "
                    "Lets sales tweak directions, declaration text, "
                    "allergen list, compliance flags and per-active "
                    "claims for a specific client without forking "
                    "the underlying formulation. Empty dict = "
                    "render the snapshot verbatim."
                ),
                verbose_name="snapshot overrides",
            ),
        ),
    ]
