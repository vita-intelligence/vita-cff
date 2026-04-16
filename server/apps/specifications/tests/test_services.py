"""Service-layer tests for the specifications app."""

from __future__ import annotations

import pytest

from apps.formulations.services import replace_lines, save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.organizations.tests.factories import OrganizationFactory
from apps.specifications.services import (
    FormulationVersionNotInOrg,
    InvalidStatusTransition,
    SpecificationCodeConflict,
    SpecificationNotFound,
    create_sheet,
    get_sheet,
    list_sheets,
    render_context,
    transition_status,
    update_sheet,
)
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _seeded_version(org):
    """Build a formulation with one line and save version 1."""

    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        name="Test Raw",
        attributes={
            "type": "Others",
            "purity": "1",
            "ingredient_list_name": "Test Ingredient",
            "vegan": "Vegan",
            "organic": "Organic",
            "halal": "Halal",
            "kosher": "Kosher",
            "nrv_mg": "10",
        },
    )
    formulation = FormulationFactory(
        organization=org, dosage_form="capsule", capsule_size="double_00"
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "5"}],
    )
    return save_version(formulation=formulation, actor=org.created_by)


class TestCreateSheet:
    def test_creates_sheet_locked_to_version(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            code="SPEC-1",
            client_name="ACME",
        )
        assert sheet.formulation_version_id == version.id
        assert sheet.status == "draft"
        assert sheet.client_name == "ACME"

    def test_rejects_version_from_other_org(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        foreign_version = _seeded_version(other_org)
        with pytest.raises(FormulationVersionNotInOrg):
            create_sheet(
                organization=my_org,
                actor=my_org.created_by,
                formulation_version_id=foreign_version.id,
            )

    def test_rejects_duplicate_code(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            code="LOCKED",
        )
        with pytest.raises(SpecificationCodeConflict):
            create_sheet(
                organization=org,
                actor=org.created_by,
                formulation_version_id=version.id,
                code="LOCKED",
            )


class TestListSheets:
    def test_scoped_to_organization(self) -> None:
        a = OrganizationFactory()
        b = OrganizationFactory()
        SpecificationSheetFactory(organization=a)
        SpecificationSheetFactory(organization=a)
        SpecificationSheetFactory(organization=b)
        assert list_sheets(organization=a).count() == 2


class TestUpdateSheet:
    def test_partial_update(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        update_sheet(
            sheet=sheet, actor=org.created_by, client_name="New Client"
        )
        sheet.refresh_from_db()
        assert sheet.client_name == "New Client"

    def test_duplicate_code_rejected(self) -> None:
        org = OrganizationFactory()
        SpecificationSheetFactory(organization=org, code="LOCKED")
        other = SpecificationSheetFactory(organization=org, code="OPEN")
        with pytest.raises(SpecificationCodeConflict):
            update_sheet(sheet=other, actor=org.created_by, code="LOCKED")


class TestStatusTransitions:
    def test_draft_to_in_review(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        updated = transition_status(
            sheet=sheet, actor=org.created_by, next_status="in_review"
        )
        assert updated.status == "in_review"

    def test_cannot_jump_draft_to_approved(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        with pytest.raises(InvalidStatusTransition):
            transition_status(
                sheet=sheet, actor=org.created_by, next_status="approved"
            )

    def test_terminal_accepted_cannot_transition(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="accepted")
        with pytest.raises(InvalidStatusTransition):
            transition_status(
                sheet=sheet, actor=org.created_by, next_status="draft"
            )

    def test_same_status_is_noop(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        transition_status(
            sheet=sheet, actor=org.created_by, next_status="draft"
        )


class TestRenderContext:
    def test_returns_expected_top_level_keys(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            code="SPEC-1",
            client_name="ACME",
        )
        ctx = render_context(sheet)
        assert set(ctx.keys()) == {
            "sheet",
            "formulation",
            "totals",
            "actives",
            "compliance",
            "declaration",
            "nutrition",
            "amino_acids",
            "packaging",
            "limits",
            "weight_uniformity",
        }

    def test_actives_include_ingredient_list_name_and_nrv(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        assert len(ctx["actives"]) == 1
        active = ctx["actives"][0]
        assert active["ingredient_list_name"] == "Test Ingredient"
        # 5mg claim against NRV of 10mg → 50.0
        assert active["nrv_percent"] == "50.0"

    def test_nrv_absent_when_catalogue_lacks_value(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        item = ItemFactory(
            catalogue=catalogue,
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "No NRV Thing",
                # nrv_mg deliberately missing
            },
        )
        formulation = FormulationFactory(organization=org, dosage_form="capsule")
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "5"}],
        )
        version = save_version(formulation=formulation, actor=org.created_by)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        assert ctx["actives"][0]["nrv_percent"] is None

    def test_compliance_and_declaration_carried_through(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        assert ctx["compliance"]["flags"]
        assert ctx["declaration"]["text"]

    def test_limits_include_all_seven_rows(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        assert len(ctx["limits"]) == 7
        assert ctx["limits"][0]["name"] == "Total Aerobic Microbial Count"

    def test_packaging_placeholders_until_f3b(self) -> None:
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        assert ctx["packaging"]["lid_description"] == "TBD"
        assert ctx["packaging"]["bottle_pouch_tub"] == "TBD"


class TestGetSheetIsolation:
    def test_other_orgs_sheet_is_404(self) -> None:
        a = OrganizationFactory()
        b = OrganizationFactory()
        foreign = SpecificationSheetFactory(organization=b)
        with pytest.raises(SpecificationNotFound):
            get_sheet(organization=a, sheet_id=foreign.id)
