"""Adds ``stage`` FK to ``PackagingCombo`` so RTG projects can route each
customer-selectable packaging bundle to a specific formulation stage.

The Routing tab now lists combos and lets scientists assign each to a
stage in the same way ingredients get routed. On order time, whichever
combo the customer picked drives the packaging BOM into that stage.

Nullable + ``SET_NULL`` so an existing combo without a stage_id keeps
existing; the Builder readiness gate on RTG projects will flag any
still-unassigned combo.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0069_formulationphoto_purpose"),
    ]

    operations = [
        migrations.AddField(
            model_name="packagingcombo",
            name="stage",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Stage that assembles this combo's packaging when a "
                    "customer picks it at checkout. Nullable during "
                    "authoring; the Builder gate requires every combo on "
                    "an RTG project to be assigned before Spec sheets "
                    "unlock."
                ),
                null=True,
                on_delete=models.deletion.SET_NULL,
                related_name="packaging_combos",
                to="formulations.formulationstage",
            ),
        ),
    ]
