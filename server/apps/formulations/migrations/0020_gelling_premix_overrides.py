"""Add gelling agent + premix sweetener M2Ms and the per-band
``excipient_overrides`` JSON field.

Phase G1. Backwards-compatible additions only: existing formulations
default to empty pick lists (no gelling band emitted, current
behaviour preserved) and an empty overrides dict (every band uses
the constant default). No data backfill needed.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("catalogues", "0001_initial"),
        ("formulations", "0019_split_flavouring_colour"),
    ]

    operations = [
        migrations.AddField(
            model_name="formulation",
            name="gelling_items",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Raw-material items used as the gel matrix on a "
                    "gummy — pectin, gelatin, agar, carrageenan, "
                    "etc. Each pick must carry use_as = 'Gelling "
                    "Agent'. The gelling total (3% of target gummy "
                    "weight, default) splits equally across picks; "
                    "the declaration groups them as 'Gelling Agent "
                    "(Pectin)'. An empty pick list means a non-"
                    "gelling gummy and skips the gelling + premix-"
                    "sweetener bands entirely. Ignored for non-"
                    "gummy forms."
                ),
                related_name="gelling_formulations",
                to="catalogues.item",
                verbose_name="gelling agent items",
            ),
        ),
        migrations.AddField(
            model_name="formulation",
            name="premix_sweetener_items",
            field=models.ManyToManyField(
                blank=True,
                help_text=(
                    "Raw-material items combined with the gelling "
                    "agent to form the in-house 'Pectin Premix' "
                    "line on the MRPeasy BOM — typically maltitol, "
                    "xylitol, sucrose. Picks pull from the same "
                    "catalogue pool as the gummy base (use_as ∈ "
                    "Sweeteners, Bulking Agent). The premix-"
                    "sweetener total (6% of target, default) is "
                    "carved out of the gummy base remainder so the "
                    "visible base shrinks accordingly. Only emitted "
                    "when gelling items are also picked."
                ),
                related_name="premix_sweetener_formulations",
                to="catalogues.item",
                verbose_name="premix sweetener items",
            ),
        ),
        migrations.AddField(
            model_name="formulation",
            name="excipient_overrides",
            field=models.JSONField(
                blank=True,
                default=dict,
                help_text=(
                    "Per-band percentage overrides for the gummy "
                    "excipient system. Keys: water, acidity, "
                    "flavouring, colour, glazing, gelling, "
                    "premix_sweetener. Values are decimal fractions "
                    "(0.02 = 2%). Missing keys fall back to the "
                    "constant defaults. Empty dict = no overrides. "
                    "Used so scientists can fine-tune ratios at the "
                    "trial-batch / spec-sheet stage without forking "
                    "the global defaults."
                ),
                verbose_name="excipient overrides",
            ),
        ),
    ]
