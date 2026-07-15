"""Tests for the FormulationStage model, default seeding on
formulation create, and the wholesale-replace ``set_formulation_stages``
service. Multi-stage BOM cascade to PSP consumes these — the shape has
to stay stable.
"""

from __future__ import annotations

import pytest

from apps.formulations.models import FormulationLine, FormulationStage
from apps.formulations.services import (
    create_formulation,
    seed_default_stages,
    set_formulation_stages,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


class TestDefaultStageSeeding:
    def test_capsule_seeds_the_full_graph(self) -> None:
        """Capsules land with the canonical four-stage template:
        Blend → Encapsulate → Bottle → Label."""

        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="C1",
            code="CAP-01",
            dosage_form="capsule",
        )

        stages = list(formulation.stages.order_by("sort_order"))
        assert [s.stage_key for s in stages] == [
            "blend",
            "encapsulate",
            "bottle",
            "label",
        ]
        # sort_order is 0-indexed and dense.
        assert [s.sort_order for s in stages] == [0, 1, 2, 3]
        # Workstations start unset — operator picks in the builder.
        assert all(s.workstation_group_uuid is None for s in stages)

    def test_powder_seeds_a_three_stage_graph(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="P1",
            code="POW-01",
            dosage_form="powder",
        )
        keys = list(
            formulation.stages.order_by("sort_order").values_list("stage_key", flat=True)
        )
        assert keys == ["blend", "fill", "label"]

    def test_liquid_seeds_nothing(self) -> None:
        """Liquid + other-solid dosage forms have no default template
        — the scientist builds stages by hand."""

        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="L1",
            code="LIQ-01",
            dosage_form="liquid",
        )
        assert formulation.stages.count() == 0

    def test_seeder_is_idempotent(self) -> None:
        """Calling ``seed_default_stages`` on a formulation that
        already has stages must not overwrite them — the operator's
        edits win. Belt-and-braces so a stale save button on the FE
        can't nuke the graph."""

        formulation = FormulationFactory(dosage_form="capsule")
        first = seed_default_stages(formulation=formulation)
        first_ids = {s.id for s in first}

        # Operator renames a stage; a re-seed must not overwrite.
        blend = formulation.stages.get(stage_key="blend")
        blend.name = "Custom Blend"
        blend.save()

        second = seed_default_stages(formulation=formulation)
        assert {s.id for s in second} == first_ids
        assert formulation.stages.get(stage_key="blend").name == "Custom Blend"


class TestSetFormulationStages:
    def test_wholesale_replace_adds_removes_updates(self) -> None:
        """The service is a wholesale-replace: stages not in the
        payload are deleted, stages with an ``id`` are updated
        in-place, stages without an ``id`` are created."""

        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="F",
            code="X-1",
            dosage_form="capsule",
        )
        original = list(formulation.stages.order_by("sort_order"))
        assert len(original) == 4  # capsule template

        # Keep blend + label with edits; drop encapsulate + bottle;
        # add a fresh Coat stage between blend and label.
        blend_id = str(original[0].id)
        label_id = str(original[3].id)

        result = set_formulation_stages(
            formulation=formulation,
            actor=org.created_by,
            stages=[
                {
                    "id": blend_id,
                    "sort_order": 0,
                    "name": "Custom Blend",
                    "stage_key": "blend",
                    "cycle_time_min": "12",
                },
                {
                    # No id → create
                    "sort_order": 1,
                    "name": "Coat",
                    "stage_key": "coat",
                },
                {
                    "id": label_id,
                    "sort_order": 2,
                    "name": "Label",
                    "stage_key": "label",
                },
            ],
        )

        assert len(result) == 3
        keys = [s.stage_key for s in sorted(result, key=lambda s: s.sort_order)]
        assert keys == ["blend", "coat", "label"]

        blend = formulation.stages.get(id=blend_id)
        assert blend.name == "Custom Blend"
        assert str(blend.cycle_time_min) == "12.00"

        assert not formulation.stages.filter(stage_key="encapsulate").exists()
        assert not formulation.stages.filter(stage_key="bottle").exists()

    def test_deleting_a_stage_nulls_lines_stage_fk(self) -> None:
        """Removing a stage must not cascade-nuke its lines — they
        fall back to ``stage=NULL`` via SET_NULL and surface in a
        'no stage' bucket for the operator to reassign."""

        formulation = FormulationFactory(dosage_form="capsule")
        seed_default_stages(formulation=formulation)
        blend = formulation.stages.get(stage_key="blend")

        # Attach a bare line to the blend stage. The factory needs
        # an item — we stub the minimum via direct create with
        # label_claim_mg set and item left NULL (PSP source, empty
        # snapshot). Compute paths aren't exercised here.
        line = FormulationLine.objects.create(
            formulation=formulation,
            item_source="psp",
            psp_item_uuid="00000000-0000-0000-0000-000000000001",
            psp_item_snapshot={"name": "x", "external_sku": "", "attributes": {}},
            stage=blend,
            label_claim_mg="100.0000",
        )

        # Nuke the blend stage by re-sending everything except it.
        remaining_ids = list(
            formulation.stages.exclude(id=blend.id).values_list("id", flat=True)
        )
        set_formulation_stages(
            formulation=formulation,
            actor=formulation.created_by,
            stages=[
                {
                    "id": str(sid),
                    "sort_order": i,
                    "name": s.name,
                    "stage_key": s.stage_key,
                }
                for i, (sid, s) in enumerate(
                    zip(
                        remaining_ids,
                        formulation.stages.exclude(id=blend.id).order_by("sort_order"),
                    )
                )
            ],
        )

        line.refresh_from_db()
        assert line.stage_id is None
        assert FormulationStage.objects.filter(id=blend.id).count() == 0
