"""Client-portal pipeline shape for Ready-to-Go projects.

RTG projects skip the trial batch + final specification phases —
the draft spec IS the contract. The stepper on the per-product page
should therefore emit 6 stages instead of 8, and the next-action
resolver should never surface a "sign final specification" prompt
for a RTG project.
"""

from __future__ import annotations

import pytest

from apps.client_portal.api.product_detail_views import (
    _build_next_action,
    _build_pipeline,
)
from apps.formulations.models import ProjectType
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


def _stage_keys(stages):
    return [s["key"] for s in stages]


class TestReadyToGoPipelineShape:
    def test_custom_project_emits_all_eight_stages(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, project_type=ProjectType.CUSTOM.value
        )
        stages = _build_pipeline(
            formulation=formulation,
            proposals=[],
            sheets=[],
            validations=[],
            label_design=None,
            payment=None,
            cff=None,
        )
        assert _stage_keys(stages) == [
            "request",
            "proposal",
            "draft_spec",
            "trial",
            "final_spec",
            "payment",
            "label",
            "production",
        ]

    def test_ready_to_go_project_skips_trial_and_final_spec(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, project_type=ProjectType.READY_TO_GO.value
        )
        stages = _build_pipeline(
            formulation=formulation,
            proposals=[],
            sheets=[],
            validations=[],
            label_design=None,
            payment=None,
            cff=None,
        )
        assert _stage_keys(stages) == [
            "request",
            "proposal",
            "draft_spec",
            "payment",
            "label",
            "production",
        ]
        # Guard against a future contributor "helpfully" adding the
        # missing stages back with `state="skipped"` — the user asked
        # for them hidden entirely, not greyed out.
        assert "trial" not in _stage_keys(stages)
        assert "final_spec" not in _stage_keys(stages)


class TestReadyToGoNextAction:
    def test_draft_prompt_subtitle_reflects_rtg_path(self) -> None:
        """Custom draft-spec prompt talks about producing a trial
        batch. Ready-to-go should instead tell the customer that
        signing unlocks payment — no trial batch is coming.
        """
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )

        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, project_type=ProjectType.READY_TO_GO.value
        )
        # SpecificationSheetFactory owns the version + parent
        # formulation. Point its version at ours so the sheet is
        # attributable to this test's formulation.
        sheet = SpecificationSheetFactory(
            organization=org,
            document_kind="draft",
            status="sent",
        )
        sheet.formulation_version.formulation = formulation
        sheet.formulation_version.save(update_fields=["formulation"])

        action = _build_next_action(
            formulation=formulation,
            proposals=[],
            sheets=[sheet],
            label_design=None,
        )
        assert action is not None
        assert action["label"] == "Sign the draft specification"
        assert "payment" in action["subtitle"].lower()
        assert "trial" not in action["subtitle"].lower()

    def test_final_spec_prompt_suppressed_for_ready_to_go(self) -> None:
        """Even if a stale FINAL sheet somehow exists on a RTG
        project (data migration edge case), the next-action resolver
        must not surface it as a customer-facing prompt.
        """
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )

        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, project_type=ProjectType.READY_TO_GO.value
        )
        stale_final = SpecificationSheetFactory(
            organization=org,
            document_kind="final",
            status="sent",
        )
        stale_final.formulation_version.formulation = formulation
        stale_final.formulation_version.save(update_fields=["formulation"])

        action = _build_next_action(
            formulation=formulation,
            proposals=[],
            sheets=[stale_final],
            label_design=None,
        )
        # No pending draft, no label design, no proposal — the
        # returned action should be None (nothing to do), NOT a
        # "sign final specification" prompt.
        assert action is None or "final" not in action["label"].lower()
