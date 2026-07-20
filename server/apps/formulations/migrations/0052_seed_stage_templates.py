"""Seed a default set of stage templates for every existing org.

Templates cover the common dosage-form graphs so scientists can pick
one on project create and get a sensible starting point instead of a
blank Stages tab. Admins are free to edit / delete / add via the
settings CRUD; the seed just gives every org a running start.

Each template's ``stages_json`` matches the FE ``UpsertStageInput``
shape so apply is a straight pass-through to ``set_formulation_stages``.
Workstation UUIDs are intentionally blank — those are per-org PSP
catalog values and the scientist picks them per-project.
"""

from __future__ import annotations

import uuid

from django.db import migrations


DEFAULTS: list[dict] = [
    {
        "name": "Capsule — 3-stage",
        "description": (
            "Blend → Encapsulate → Bottle. Standard capsule route "
            "with a single encapsulation step; Bottle is the "
            "finished-product stage."
        ),
        "dosage_form": "capsule",
        "stages_json": [
            {
                "sort_order": 0,
                "name": "Blend",
                "stage_key": "blend",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 1,
                "name": "Encapsulate",
                "stage_key": "encapsulate",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 2,
                "name": "Bottle",
                "stage_key": "bottle",
                "psp_item_type": "finished_product",
            },
        ],
    },
    {
        "name": "Gummy — 4-stage",
        "description": (
            "Cook → Deposit → Cure → Bottle. Standard confection "
            "route; Bottle is the finished-product stage."
        ),
        "dosage_form": "gummy",
        "stages_json": [
            {
                "sort_order": 0,
                "name": "Cook",
                "stage_key": "cook",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 1,
                "name": "Deposit",
                "stage_key": "deposit",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 2,
                "name": "Cure",
                "stage_key": "cure",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 3,
                "name": "Bottle",
                "stage_key": "bottle",
                "psp_item_type": "finished_product",
            },
        ],
    },
    {
        "name": "Tablet — 3-stage",
        "description": (
            "Blend → Coat → Bottle. Add an extra Compress step "
            "manually when the tablet is uncoated."
        ),
        "dosage_form": "tablet",
        "stages_json": [
            {
                "sort_order": 0,
                "name": "Blend",
                "stage_key": "blend",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 1,
                "name": "Coat",
                "stage_key": "coat",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 2,
                "name": "Bottle",
                "stage_key": "bottle",
                "psp_item_type": "finished_product",
            },
        ],
    },
    {
        "name": "Powder — 2-stage",
        "description": (
            "Blend → Fill. Bulk powder into pouches / jars; Fill is "
            "the finished-product stage."
        ),
        "dosage_form": "powder",
        "stages_json": [
            {
                "sort_order": 0,
                "name": "Blend",
                "stage_key": "blend",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 1,
                "name": "Fill",
                "stage_key": "fill",
                "psp_item_type": "finished_product",
            },
        ],
    },
    {
        "name": "Liquid — 2-stage",
        "description": (
            "Compound → Bottle. Two-step liquid formulation route."
        ),
        "dosage_form": "liquid",
        "stages_json": [
            {
                "sort_order": 0,
                "name": "Compound",
                "stage_key": "custom",
                "psp_item_type": "semi_finished",
            },
            {
                "sort_order": 1,
                "name": "Bottle",
                "stage_key": "bottle",
                "psp_item_type": "finished_product",
            },
        ],
    },
]


def seed(apps, schema_editor):
    Organization = apps.get_model("organizations", "Organization")
    FormulationStageTemplate = apps.get_model(
        "formulations", "FormulationStageTemplate"
    )

    for org in Organization.objects.all():
        existing_names = set(
            FormulationStageTemplate.objects.filter(
                organization=org
            ).values_list("name", flat=True)
        )
        for row in DEFAULTS:
            if row["name"] in existing_names:
                continue
            FormulationStageTemplate.objects.create(
                id=uuid.uuid4(),
                organization=org,
                name=row["name"],
                description=row["description"],
                dosage_form=row["dosage_form"],
                stages_json=row["stages_json"],
                is_seeded=True,
            )


def unseed(apps, schema_editor):
    # Only remove rows the seed added — user-created templates stay.
    FormulationStageTemplate = apps.get_model(
        "formulations", "FormulationStageTemplate"
    )
    FormulationStageTemplate.objects.filter(is_seeded=True).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("formulations", "0051_stage_template"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
