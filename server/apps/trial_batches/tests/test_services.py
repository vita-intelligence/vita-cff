"""Service-layer tests for the trial-batches app.

Covers CRUD validation, cross-org isolation, and the pure
:func:`compute_batch_scaleup` math for every supported dosage form
(capsule with excipients + shell, tablet without shell, powder
with no excipient math at all).
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.models import ProjectStatus
from apps.formulations.services import (
    replace_lines,
    save_version,
    update_formulation,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.trial_batches.services import (
    FormulationVersionNotInOrg,
    InvalidBatchSize,
    TrialBatchNotFound,
    compute_batch_scaleup,
    create_batch,
    get_batch,
    list_batches_for_formulation,
    update_batch,
)


pytestmark = pytest.mark.django_db


def _seeded_capsule_version(
    org,
    *,
    capsule_size: str = "double_00",
    servings_per_pack: int = 60,
    attribute_overrides: dict | None = None,
    label_claim_mg: str = "100",
):
    """Build a one-line capsule formulation saved as version 1.

    The default raw material is purity=1 / type=Others so the math
    has no overage or extract-ratio complications — tests that care
    about the scale-up multiplication can reason about mg_per_unit
    directly. An MCC carrier is picked by default so the auto-fill
    excipient block kicks in (empty pickers now ship pure actives).
    """

    catalogue = raw_materials_catalogue(org)
    base_attrs = {
        "type": "Others",
        "purity": "1",
        "ingredient_list_name": "Test Ingredient",
    }
    base_attrs.update(attribute_overrides or {})
    item = ItemFactory(catalogue=catalogue, name="Test Raw", attributes=base_attrs)
    mcc = ItemFactory(
        catalogue=catalogue,
        name="MCC PH-101",
        attributes={
            "use_as": "Bulking Agent",
            "ingredient_list_name": "Microcrystalline Cellulose (Carrier)",
        },
    )
    formulation = FormulationFactory(
        organization=org,
        dosage_form="capsule",
        capsule_size=capsule_size,
        servings_per_pack=servings_per_pack,
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": label_claim_mg}],
    )
    update_formulation(
        formulation=formulation,
        actor=org.created_by,
        mcc_carrier_item_ids=[str(mcc.id)],
    )
    return save_version(formulation=formulation, actor=org.created_by)


def _seeded_tablet_version(org, *, tablet_size: str = "round_13mm"):
    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        name="Tablet Active",
        attributes={
            "type": "Others",
            "purity": "1",
            "ingredient_list_name": "Tablet Active",
        },
    )
    mcc = ItemFactory(
        catalogue=catalogue,
        name="MCC PH-101",
        attributes={
            "use_as": "Bulking Agent",
            "ingredient_list_name": "Microcrystalline Cellulose (Carrier)",
        },
    )
    dcp = ItemFactory(
        catalogue=catalogue,
        name="DCP Anhydrous",
        attributes={
            "use_as": "Bulking Agent",
            "ingredient_list_name": "Dicalcium Phosphate",
        },
    )
    formulation = FormulationFactory(
        organization=org,
        dosage_form="tablet",
        tablet_size=tablet_size,
        capsule_size="",
        servings_per_pack=60,
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
    )
    update_formulation(
        formulation=formulation,
        actor=org.created_by,
        mcc_carrier_item_ids=[str(mcc.id)],
        dcp_carrier_item_ids=[str(dcp.id)],
    )
    return save_version(formulation=formulation, actor=org.created_by)


def _seeded_powder_version(org):
    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        name="Powder Active",
        attributes={
            "type": "Others",
            "purity": "1",
            "ingredient_list_name": "Powder Active",
        },
    )
    formulation = FormulationFactory(
        organization=org,
        dosage_form="powder",
        capsule_size="",
        tablet_size="",
        servings_per_pack=30,
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "5000"}],
    )
    return save_version(formulation=formulation, actor=org.created_by)


class TestCreateBatch:
    def test_creates_batch_locked_to_version(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
            label="Pilot run",
        )
        assert batch.formulation_version_id == version.id
        assert batch.batch_size_units == 500
        assert batch.label == "Pilot run"
        assert batch.organization_id == org.id

    def test_rejects_version_from_other_org(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        foreign = _seeded_capsule_version(other_org)
        with pytest.raises(FormulationVersionNotInOrg):
            create_batch(
                organization=my_org,
                actor=my_org.created_by,
                formulation_version_id=foreign.id,
                batch_size_units=500,
            )

    def test_first_batch_advances_project_to_pilot(self) -> None:
        """First trial batch flips the parent formulation's roadmap
        chip to ``pilot``. Skip-ahead is fine: this fixture's project
        sits at ``in_development`` after lines were added, so we
        cover both single-step and forward-only behaviour."""

        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        # Lines + save_version already pushed the chip off ``concept``.
        version.formulation.refresh_from_db()
        assert (
            version.formulation.project_status
            == ProjectStatus.IN_DEVELOPMENT.value
        )

        create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )

        version.formulation.refresh_from_db()
        assert (
            version.formulation.project_status == ProjectStatus.PILOT.value
        )

    def test_batch_on_approved_project_does_not_demote(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        formulation = version.formulation
        formulation.project_status = ProjectStatus.APPROVED.value
        formulation.save(update_fields=["project_status"])

        create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )

        formulation.refresh_from_db()
        # Forward-only: a later trial batch must not regress an
        # already-approved project.
        assert formulation.project_status == ProjectStatus.APPROVED.value

    def test_rejects_zero_batch_size(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        with pytest.raises(InvalidBatchSize):
            create_batch(
                organization=org,
                actor=org.created_by,
                formulation_version_id=version.id,
                batch_size_units=0,
            )

    def test_rejects_negative_batch_size(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        with pytest.raises(InvalidBatchSize):
            create_batch(
                organization=org,
                actor=org.created_by,
                formulation_version_id=version.id,
                batch_size_units=-5,
            )


class TestUpdateBatch:
    def test_patches_allowed_fields(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        updated = update_batch(
            batch=batch,
            actor=org.created_by,
            label="Final pilot",
            batch_size_units=1000,
            notes="Re-scaled after QA feedback",
        )
        assert updated.label == "Final pilot"
        assert updated.batch_size_units == 1000
        assert updated.notes == "Re-scaled after QA feedback"

    def test_rejects_invalid_batch_size_on_update(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        with pytest.raises(InvalidBatchSize):
            update_batch(
                batch=batch, actor=org.created_by, batch_size_units=0
            )


class TestGetBatch:
    def test_fetches_batch_in_org(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        fetched = get_batch(organization=org, batch_id=batch.id)
        assert fetched.id == batch.id

    def test_raises_not_found_cross_org(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        version = _seeded_capsule_version(other_org)
        batch = create_batch(
            organization=other_org,
            actor=other_org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        with pytest.raises(TrialBatchNotFound):
            get_batch(organization=my_org, batch_id=batch.id)


class TestListBatchesForFormulation:
    def test_returns_only_batches_for_this_formulation(self) -> None:
        org = OrganizationFactory()
        version_a = _seeded_capsule_version(org)
        version_b = _seeded_capsule_version(org)
        batch_a = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version_a.id,
            batch_size_units=500,
        )
        create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version_b.id,
            batch_size_units=100,
        )
        listed = list(
            list_batches_for_formulation(
                organization=org,
                formulation_id=version_a.formulation_id,
            )
        )
        assert [b.id for b in listed] == [batch_a.id]


class TestComputeBatchScaleupCapsule:
    def test_capsule_scales_actives_excipients_and_shell(self) -> None:
        org = OrganizationFactory()
        # 1 active × 100 mg/unit purity=1, no overage.
        # 500 packs × 60 per pack = 30,000 units.
        version = _seeded_capsule_version(
            org, servings_per_pack=60, label_claim_mg="100"
        )
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=500,
        )
        result = compute_batch_scaleup(batch)

        assert result.batch_size_units == 500
        assert result.units_per_pack == 60
        assert result.total_units_in_batch == 30_000
        assert result.dosage_form == "capsule"
        assert result.size_label == "Double 00"

        categories = [entry.category for entry in result.entries]
        assert categories.count("active") == 1
        # MCC is always present when the capsule math runs; Mg
        # Stearate + Silica are separate SKUs for procurement.
        excipient_labels = {
            entry.label for entry in result.entries if entry.category == "excipient"
        }
        assert "Microcrystalline Cellulose (Carrier)" in excipient_labels
        assert "Magnesium Stearate" in excipient_labels
        assert "Silicon Dioxide" in excipient_labels
        # Capsule shell reported as a count-UOM line.
        shell_entry = next(
            entry for entry in result.entries if entry.category == "shell"
        )
        assert shell_entry.uom == "count"
        assert shell_entry.count_per_batch == 30_000
        assert shell_entry.kg_per_batch == Decimal(
            "3.540000"
        )  # 118 mg × 30K → 3.54 kg

    def test_active_mg_scales_linearly_with_total_units(self) -> None:
        org = OrganizationFactory()
        version = _seeded_capsule_version(
            org, servings_per_pack=60, label_claim_mg="200"
        )
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=100,
        )
        result = compute_batch_scaleup(batch)
        active_entry = next(
            entry for entry in result.entries if entry.category == "active"
        )
        # 200 mg/unit × 100 packs × 60 per pack = 1.2 M mg = 1.2 kg.
        assert active_entry.mg_per_unit == Decimal("200.0000")
        assert active_entry.mg_per_batch == Decimal("1200000.0000")
        assert active_entry.kg_per_batch == Decimal("1.200000")

    def test_uom_split_on_totals(self) -> None:
        """Weight lines sum into the fill totals; the shell count is
        reported separately so procurement does not accidentally
        read kg where it should read a piece count."""

        org = OrganizationFactory()
        version = _seeded_capsule_version(org, label_claim_mg="100")
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=1000,
        )
        result = compute_batch_scaleup(batch)
        # Total shells == total units (one shell per capsule).
        assert result.total_count_per_batch == result.total_units_in_batch
        # Weight totals exclude the shell — they represent the fill
        # weight only.
        weight_sum = sum(
            (entry.kg_per_batch for entry in result.entries if entry.uom == "weight"),
            Decimal("0"),
        )
        assert result.total_kg_per_batch == weight_sum.quantize(
            Decimal("0.000001")
        )

    def test_actives_sorted_smallest_to_largest(self) -> None:
        """MRPeasy BOM convention: active rows ascend by mg/unit so
        the operator pours the trace ingredients first and they
        don't get smothered by the bulk powders. The builder's
        display_order is ignored for this list — purely amount-
        driven, with display_order only kicking in as a tiebreaker
        between two actives at the exact same weight."""

        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        # Three actives: 5 mg, 50 mg, 200 mg. Inserted in REVERSE
        # weight order so the builder's display_order would emit
        # them descending — confirms the sort overrides it.
        big = ItemFactory(
            catalogue=catalogue,
            name="Big Active",
            internal_code="SKU-BIG",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Big Active",
            },
        )
        mid = ItemFactory(
            catalogue=catalogue,
            name="Mid Active",
            internal_code="SKU-MID",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Mid Active",
            },
        )
        tiny = ItemFactory(
            catalogue=catalogue,
            name="Tiny Active",
            internal_code="SKU-TINY",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Tiny Active",
            },
        )
        formulation = FormulationFactory(
            organization=org,
            dosage_form="capsule",
            capsule_size="double_00",
            servings_per_pack=60,
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[
                {"item_id": str(big.id), "label_claim_mg": "200"},
                {"item_id": str(mid.id), "label_claim_mg": "50"},
                {"item_id": str(tiny.id), "label_claim_mg": "5"},
            ],
        )
        version = save_version(
            formulation=formulation, actor=org.created_by
        )
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=10,
        )

        result = compute_batch_scaleup(batch)
        active_labels = [
            entry.label
            for entry in result.entries
            if entry.category == "active"
        ]
        assert active_labels == [
            "Tiny Active",
            "Mid Active",
            "Big Active",
        ]


class TestComputeBatchScaleupTablet:
    def test_tablet_has_no_shell_but_has_dcp(self) -> None:
        org = OrganizationFactory()
        version = _seeded_tablet_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=200,
        )
        result = compute_batch_scaleup(batch)
        categories = [entry.category for entry in result.entries]
        assert "shell" not in categories
        excipient_labels = {
            entry.label for entry in result.entries if entry.category == "excipient"
        }
        # Tablet excipients include DCP; capsule excipients don't.
        assert "Dicalcium Phosphate" in excipient_labels
        # No count-UOM lines on a tablet — no shell.
        assert all(entry.uom == "weight" for entry in result.entries)
        assert result.total_count_per_batch == 0


class TestComputeBatchScaleupPowder:
    def test_powder_has_flavour_system_and_no_shell(self) -> None:
        org = OrganizationFactory()
        version = _seeded_powder_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=50,
        )
        result = compute_batch_scaleup(batch)
        categories = {entry.category for entry in result.entries}
        # Actives + the preset flavour system (Trisodium Citrate,
        # Citric Acid, Flavouring, Sweetener, Colourant) that every
        # powder workbook hand-types on its BOM sheet. Still no
        # capsule shell.
        assert categories == {"active", "excipient"}
        flavour_labels = {
            entry.label
            for entry in result.entries
            if entry.category == "excipient"
        }
        assert flavour_labels == {
            "Trisodium Citrate",
            "Citric Acid",
            "Flavouring",
            "Sweetener",
            "Colourant",
        }

    def test_units_per_pack_defaults_to_servings_per_pack(self) -> None:
        """The formulation's ``servings_per_pack`` flows into the BOM
        regardless of dosage form. A 30-sachet powder batch should
        treat ``batch_size_units`` as boxes of 30, not as individual
        sachets, so the mg-per-batch math multiplies by 30×
        batch_size_units."""

        org = OrganizationFactory()
        version = _seeded_powder_version(org)
        batch = create_batch(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            batch_size_units=10,
        )
        result = compute_batch_scaleup(batch)
        assert result.units_per_pack == 30
        assert result.total_units_in_batch == 300
