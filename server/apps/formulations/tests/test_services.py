"""Service-layer tests covering CRUD, versioning, and rollback."""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.models import FormulationLine
from apps.formulations.services import (
    FormulationCodeConflict,
    FormulationCodeRequired,
    FormulationNotFound,
    FormulationVersionNotFound,
    InvalidCapsuleSize,
    InvalidDcpCarrierItem,
    InvalidDosageForm,
    InvalidMccCarrierItem,
    RawMaterialNotInOrg,
    compute_formulation_totals,
    create_formulation,
    get_formulation,
    list_formulations,
    list_versions,
    replace_lines,
    rollback_to_version,
    save_version,
    update_formulation,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


class TestCreateFormulation:
    def test_creates_with_defaults(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Test Capsule",
            code="TC-001",
        )
        assert formulation.name == "Test Capsule"
        assert formulation.code == "TC-001"
        assert formulation.project_status == "concept"
        assert formulation.dosage_form == "capsule"

    def test_explicit_code_is_persisted_verbatim(self) -> None:
        """Scientists type their own reference (``MA210367``, ``FB-001``)
        — the service trusts the caller and writes it through without
        reformatting. The surrounding whitespace is trimmed because
        the create modal's free-text input otherwise lets a trailing
        space silently diverge from the ERP's copy."""

        org = OrganizationFactory()
        result = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Imported",
            code="  IMPORT-2024-01  ",
        )
        assert result.code == "IMPORT-2024-01"

    def test_blank_code_raises(self) -> None:
        """The code field is mandatory — a blank / whitespace-only
        submission is rejected so the scientist has to pick a real
        reference before the project exists."""

        org = OrganizationFactory()
        with pytest.raises(FormulationCodeRequired):
            create_formulation(
                organization=org,
                actor=org.created_by,
                name="A",
                code="   ",
            )

    def test_duplicate_code_raises(self) -> None:
        """Two projects in the same org cannot share a code. The API
        layer maps ``FormulationCodeConflict`` to a 400 with a
        machine-readable error so the create modal can surface the
        clash on the ``code`` field."""

        org = OrganizationFactory()
        create_formulation(
            organization=org, actor=org.created_by, name="A", code="FORM-1"
        )
        with pytest.raises(FormulationCodeConflict):
            create_formulation(
                organization=org,
                actor=org.created_by,
                name="B",
                code="FORM-1",
            )

    def test_invalid_dosage_form_raises(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(InvalidDosageForm):
            create_formulation(
                organization=org,
                actor=org.created_by,
                name="Bogus",
                code="BOGUS-1",
                dosage_form="nonsense",
            )

    def test_invalid_capsule_size_raises(self) -> None:
        org = OrganizationFactory()
        with pytest.raises(InvalidCapsuleSize):
            create_formulation(
                organization=org,
                actor=org.created_by,
                name="Bad",
                code="BAD-1",
                capsule_size="absolutely_made_up",
            )


class TestListFormulations:
    def test_scoped_to_organization(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        FormulationFactory(organization=org_a, name="A one")
        FormulationFactory(organization=org_a, name="A two")
        FormulationFactory(organization=org_b, name="B one")

        results = list(list_formulations(organization=org_a))
        names = {f.name for f in results}
        assert names == {"A one", "A two"}


class TestGetFormulation:
    def test_raises_when_in_other_org(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        f = FormulationFactory(organization=org_b)
        with pytest.raises(FormulationNotFound):
            get_formulation(organization=org_a, formulation_id=f.id)


class TestUpdateFormulation:
    def test_partial_update(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org, name="Old")
        update_formulation(
            formulation=formulation,
            actor=org.created_by,
            name="New",
        )
        formulation.refresh_from_db()
        assert formulation.name == "New"

    def test_rejects_duplicate_code(self) -> None:
        org = OrganizationFactory()
        FormulationFactory(organization=org, code="LOCKED")
        other = FormulationFactory(organization=org, code="OPEN")
        with pytest.raises(FormulationCodeConflict):
            update_formulation(
                formulation=other,
                actor=org.created_by,
                code="LOCKED",
            )


class TestReplaceLines:
    def test_happy_path(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": "0.5", "type": "Vitamin"},
        )

        lines = replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[
                {
                    "item_id": str(item.id),
                    "label_claim_mg": "100",
                    "display_order": 0,
                }
            ],
        )
        assert len(lines) == 1
        assert lines[0].mg_per_serving_cached == Decimal("200.0000")

    def test_atomically_replaces_existing(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        catalogue = raw_materials_catalogue(org)
        item_a = ItemFactory(catalogue=catalogue, attributes={"purity": 1.0})
        item_b = ItemFactory(catalogue=catalogue, attributes={"purity": 1.0})

        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item_a.id), "label_claim_mg": "50"}],
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item_b.id), "label_claim_mg": "75"}],
        )
        rows = list(FormulationLine.objects.filter(formulation=formulation))
        assert len(rows) == 1
        assert rows[0].item_id == item_b.id
        assert rows[0].label_claim_mg == Decimal("75.0000")

    def test_rejects_item_from_other_org(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        formulation = FormulationFactory(organization=org_a)
        foreign_item = ItemFactory(catalogue=raw_materials_catalogue(org_b))

        with pytest.raises(RawMaterialNotInOrg):
            replace_lines(
                formulation=formulation,
                actor=org_a.created_by,
                lines=[
                    {
                        "item_id": str(foreign_item.id),
                        "label_claim_mg": "100",
                    }
                ],
            )

    def test_rejects_packaging_item(self) -> None:
        from apps.catalogues.tests.factories import packaging_catalogue

        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        pack_item = ItemFactory(catalogue=packaging_catalogue(org))

        with pytest.raises(RawMaterialNotInOrg):
            replace_lines(
                formulation=formulation,
                actor=org.created_by,
                lines=[
                    {"item_id": str(pack_item.id), "label_claim_mg": "100"}
                ],
            )


class TestComputeFormulationTotals:
    def test_reads_current_state(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule", capsule_size="double_00"
        )
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "500"}],
        )
        totals = compute_formulation_totals(formulation=formulation)
        assert totals.total_active_mg == Decimal("500.0000")
        assert totals.viability.fits is True


class TestVersioning:
    def test_save_creates_sequential_versions(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)

        v1 = save_version(formulation=formulation, actor=org.created_by)
        v2 = save_version(
            formulation=formulation, actor=org.created_by, label="second pass"
        )
        assert v1.version_number == 1
        assert v2.version_number == 2
        assert v2.label == "second pass"

    def test_snapshot_preserves_lines(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule", capsule_size="double_00"
        )
        item = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "200"}],
        )
        version = save_version(formulation=formulation, actor=org.created_by)
        assert len(version.snapshot_lines) == 1
        assert version.snapshot_lines[0]["label_claim_mg"] == "200.0000"
        assert version.snapshot_totals["total_active_mg"] == "200.0000"


class TestRollback:
    def test_rollback_restores_lines_and_appends_version(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule"
        )
        catalogue = raw_materials_catalogue(org)
        item_a = ItemFactory(catalogue=catalogue, attributes={"purity": 1.0})
        item_b = ItemFactory(catalogue=catalogue, attributes={"purity": 1.0})

        # Version 1: just item_a
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item_a.id), "label_claim_mg": "100"}],
        )
        save_version(formulation=formulation, actor=org.created_by)

        # Edit: swap to item_b
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item_b.id), "label_claim_mg": "250"}],
        )
        save_version(formulation=formulation, actor=org.created_by)

        # Roll back to v1
        rollback_to_version(
            formulation=formulation, actor=org.created_by, version_number=1
        )

        current_lines = list(
            FormulationLine.objects.filter(formulation=formulation)
        )
        assert len(current_lines) == 1
        assert current_lines[0].item_id == item_a.id
        assert current_lines[0].label_claim_mg == Decimal("100.0000")

        # Rollback itself is snapshotted as v3
        versions = list(list_versions(formulation=formulation))
        assert len(versions) == 3
        assert versions[0].version_number == 3
        assert "rollback" in versions[0].label.lower()

    def test_rollback_to_unknown_version_raises(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        with pytest.raises(FormulationVersionNotFound):
            rollback_to_version(
                formulation=formulation,
                actor=org.created_by,
                version_number=42,
            )


class TestCapsuleCarrierPicker:
    """Cover the capsule MCC carrier picker.

    Mirrors the gummy-base picker pattern: scientists pick one or more
    catalogue items tagged ``use_as = "Bulking Agent"`` and the MCC
    remainder splits equally across them. With no picks the spec
    sheet falls back to the generic placeholder and a soft warning
    surfaces.
    """

    def _capsule(self, org, mcc_picks=()):
        active = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )
        formulation = FormulationFactory(
            organization=org,
            dosage_form="capsule",
            capsule_size="double_00",
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(active.id), "label_claim_mg": "500"}],
        )
        if mcc_picks:
            update_formulation(
                formulation=formulation,
                actor=org.created_by,
                mcc_carrier_item_ids=[str(p.id) for p in mcc_picks],
            )
        return formulation

    def test_no_picks_emits_zero_excipients(
        self,
    ) -> None:
        """A capsule with no carrier picks ships as pure actives — no
        MCC remainder, no anticaking. Empty picker = the scientist
        explicitly opted out of any auto-filled excipient."""

        org = OrganizationFactory()
        formulation = self._capsule(org)

        totals = compute_formulation_totals(formulation=formulation)

        assert totals.excipients is not None
        assert totals.excipients.mcc_mg == Decimal("0")
        assert totals.excipients.mg_stearate_mg == Decimal("0")
        assert totals.excipients.silica_mg == Decimal("0")
        assert totals.excipients.mcc_carrier_rows == ()

    def test_picks_split_mcc_equally_and_drop_warning(self) -> None:
        """Two MCC picks split the carrier mg in half; the unpicked
        warning goes away once a pick exists."""

        org = OrganizationFactory()
        carrier_a = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            name="MCC Brand A",
            attributes={
                "use_as": "Bulking Agent",
                "ingredient_list_name": "Microcrystalline Cellulose A",
            },
        )
        carrier_b = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            name="MCC Brand B",
            attributes={
                "use_as": "Bulking Agent",
                "ingredient_list_name": "Microcrystalline Cellulose B",
            },
        )
        formulation = self._capsule(org, mcc_picks=(carrier_a, carrier_b))

        totals = compute_formulation_totals(formulation=formulation)

        rows = totals.excipients.mcc_carrier_rows
        assert len(rows) == 2
        assert sum(r.mg for r in rows) == totals.excipients.mcc_mg
        assert {r.label for r in rows} == {
            "Microcrystalline Cellulose A",
            "Microcrystalline Cellulose B",
        }
        assert "mcc_carrier_unpicked" not in totals.warnings

    def test_pick_must_carry_bulking_agent_use_as(self) -> None:
        """A non-Bulking-Agent item is rejected at save time so the
        carrier slot never receives an Active or Sweetener leak."""

        org = OrganizationFactory()
        bad_pick = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"use_as": "Active"},
        )
        formulation = self._capsule(org)

        with pytest.raises(InvalidMccCarrierItem):
            update_formulation(
                formulation=formulation,
                actor=org.created_by,
                mcc_carrier_item_ids=[str(bad_pick.id)],
            )


class TestTabletCarrierPicker:
    """Tablets carry both an MCC and a DCP carrier picker. Each
    splits its respective total across picks and emits its own
    ``unpicked`` warning when left empty."""

    def _tablet(self, org, *, mcc_picks=(), dcp_picks=()):
        active = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )
        formulation = FormulationFactory(
            organization=org,
            dosage_form="tablet",
            tablet_size="round_11mm",
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(active.id), "label_claim_mg": "300"}],
        )
        kwargs: dict = {}
        if mcc_picks:
            kwargs["mcc_carrier_item_ids"] = [str(p.id) for p in mcc_picks]
        if dcp_picks:
            kwargs["dcp_carrier_item_ids"] = [str(p.id) for p in dcp_picks]
        if kwargs:
            update_formulation(
                formulation=formulation, actor=org.created_by, **kwargs
            )
        return formulation

    def test_both_pickers_split_their_totals(self) -> None:
        org = OrganizationFactory()
        mcc = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            name="MCC",
            attributes={
                "use_as": "Bulking Agent",
                "ingredient_list_name": "Microcrystalline Cellulose",
            },
        )
        dcp = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            name="DCP",
            attributes={
                "use_as": "Bulking Agent",
                "ingredient_list_name": "Dicalcium Phosphate Dihydrate",
            },
        )
        formulation = self._tablet(org, mcc_picks=(mcc,), dcp_picks=(dcp,))

        totals = compute_formulation_totals(formulation=formulation)

        assert len(totals.excipients.mcc_carrier_rows) == 1
        assert (
            totals.excipients.mcc_carrier_rows[0].label
            == "Microcrystalline Cellulose"
        )
        assert len(totals.excipients.dcp_carrier_rows) == 1
        assert (
            totals.excipients.dcp_carrier_rows[0].label
            == "Dicalcium Phosphate Dihydrate"
        )
        assert "mcc_carrier_unpicked" not in totals.warnings
        assert "dcp_carrier_unpicked" not in totals.warnings

    def test_no_picks_emits_zero_excipients(self) -> None:
        """Empty MCC and DCP pickers ship the tablet as pure actives —
        no auto-fill carrier, no anticaking. Either picker on its own
        re-enables anticaking and fills only the picked carrier."""

        org = OrganizationFactory()
        formulation = self._tablet(org)

        totals = compute_formulation_totals(formulation=formulation)

        assert totals.excipients.mcc_carrier_rows == ()
        assert totals.excipients.dcp_carrier_rows == ()
        assert totals.excipients.mcc_mg == Decimal("0")
        assert totals.excipients.dcp_mg == Decimal("0")
        assert totals.excipients.mg_stearate_mg == Decimal("0")
        assert totals.excipients.silica_mg == Decimal("0")

    def test_dcp_picker_validation_rejects_wrong_use_as(self) -> None:
        org = OrganizationFactory()
        formulation = self._tablet(org)
        bad = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"use_as": "Sweeteners"},
        )

        with pytest.raises(InvalidDcpCarrierItem):
            update_formulation(
                formulation=formulation,
                actor=org.created_by,
                dcp_carrier_item_ids=[str(bad.id)],
            )


class TestCarrierSnapshot:
    """Carrier picks must round-trip through the version snapshot so
    a spec sheet rendered weeks later still references the picked
    items, even after catalogue edits."""

    def test_snapshot_captures_carrier_rows(self) -> None:
        org = OrganizationFactory()
        active = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )
        carrier = ItemFactory(
            catalogue=raw_materials_catalogue(org),
            name="MCC PH-101",
            attributes={
                "use_as": "Bulking Agent",
                "ingredient_list_name": "Microcrystalline Cellulose",
            },
        )
        formulation = FormulationFactory(
            organization=org,
            dosage_form="capsule",
            capsule_size="double_00",
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(active.id), "label_claim_mg": "500"}],
        )
        update_formulation(
            formulation=formulation,
            actor=org.created_by,
            mcc_carrier_item_ids=[str(carrier.id)],
        )

        version = save_version(formulation=formulation, actor=org.created_by)

        excipients = version.snapshot_totals["excipients"]
        rows = excipients["mcc_carrier_rows"]
        assert len(rows) == 1
        assert rows[0]["item_id"] == str(carrier.id)
        assert rows[0]["label"] == "Microcrystalline Cellulose"
