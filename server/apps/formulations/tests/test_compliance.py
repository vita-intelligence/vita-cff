"""Unit tests for F2a: compliance aggregation + ingredient declaration."""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.services import (
    build_ingredient_declaration,
    compute_compliance,
    compute_formulation_totals,
    compute_totals,
    replace_lines,
)
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _item(org, *, name: str, **extra_attributes):
    return ItemFactory(
        catalogue=raw_materials_catalogue(org),
        name=name,
        attributes=extra_attributes,
    )


# ---------------------------------------------------------------------------
# compute_compliance
# ---------------------------------------------------------------------------


class TestCompliance:
    def test_all_flags_pass_when_every_ingredient_is_compliant(self) -> None:
        org = OrganizationFactory()
        a = _item(
            org,
            name="A",
            vegan="Vegan",
            organic="Organic",
            halal="Halal",
            kosher="Kosher",
        )
        b = _item(
            org,
            name="B",
            vegan="Vegan",
            organic="Organic",
            halal="Halal",
            kosher="Kosher",
        )
        result = compute_compliance(items=[a, b])
        by_key = {f.key: f for f in result.flags}
        assert by_key["vegan"].status is True
        assert by_key["vegan"].compliant_count == 2
        assert by_key["vegan"].non_compliant_count == 0
        assert by_key["organic"].status is True
        assert by_key["halal"].status is True
        assert by_key["kosher"].status is True

    def test_one_non_compliant_taints_the_whole_product(self) -> None:
        org = OrganizationFactory()
        clean = _item(org, name="Clean", vegan="Vegan")
        dirty = _item(org, name="Dirty", vegan="Non-Vegan")
        result = compute_compliance(items=[clean, dirty])
        vegan_flag = next(f for f in result.flags if f.key == "vegan")
        assert vegan_flag.status is False
        assert vegan_flag.compliant_count == 1
        assert vegan_flag.non_compliant_count == 1

    def test_only_unknowns_returns_status_none(self) -> None:
        org = OrganizationFactory()
        a = _item(org, name="Mystery 1")
        b = _item(org, name="Mystery 2")
        result = compute_compliance(items=[a, b])
        for flag in result.flags:
            assert flag.status is None
            assert flag.unknown_count == 2
            assert flag.compliant_count == 0
            assert flag.non_compliant_count == 0

    def test_unknowns_do_not_taint_compliant_answers(self) -> None:
        org = OrganizationFactory()
        compliant = _item(org, name="Compliant", vegan="Vegan")
        unknown = _item(org, name="Unknown")  # no vegan attr set
        result = compute_compliance(items=[compliant, unknown])
        flag = next(f for f in result.flags if f.key == "vegan")
        assert flag.status is True
        assert flag.compliant_count == 1
        assert flag.unknown_count == 1


# ---------------------------------------------------------------------------
# build_ingredient_declaration
# ---------------------------------------------------------------------------


class TestIngredientDeclaration:
    def test_sorts_actives_by_weight_descending(self) -> None:
        org = OrganizationFactory()
        small = _item(
            org,
            name="Small",
            purity=1.0,
            type="Others",
            ingredient_list_name="Small Item",
        )
        big = _item(
            org,
            name="Big",
            purity=1.0,
            type="Others",
            ingredient_list_name="Big Item",
        )

        # Use ``other_solid`` here so the test stays focused on the
        # active sort order. Powder + gummy now ship a preset flavour
        # system (Trisodium Citrate, Citric Acid, Flavouring, …) that
        # would interleave with the two fake actives and defeat the
        # sort-order check this test is actually about.
        totals = compute_totals(
            lines=[
                ("small_key", small, Decimal("10"), None),
                ("big_key", big, Decimal("100"), None),
            ],
            dosage_form="other_solid",
        )
        items_map = {"small_key": small, "big_key": big}
        declaration, entries = build_ingredient_declaration(
            items_by_external_id=items_map,
            totals=totals,
        )

        # Actives only (no excipients on ``other_solid``) — biggest first.
        assert declaration == "Big Item, Small Item"
        assert [e.category for e in entries] == ["active", "active"]

    def test_capsule_merges_excipients_and_shell_into_sort(self) -> None:
        org = OrganizationFactory()
        active = _item(
            org,
            name="Active Raw",
            purity=1.0,
            type="Others",
            ingredient_list_name="Active Compound",
        )

        # Total active 500 mg in Double 00 capsule:
        # MCC fills to 730 − 500 − 5 − 2 = 223 mg.
        # Mg Stearate = 5.0, Silica = 2.0 → Anticaking = 7.0.
        # Capsule shell = 118.0.
        totals = compute_totals(
            lines=[("a", active, Decimal("500"), None)],
            dosage_form="capsule",
            capsule_size_key="double_00",
        )
        declaration, entries = build_ingredient_declaration(
            items_by_external_id={"a": active},
            totals=totals,
        )

        labels = [e.label for e in entries]
        # Order: Active (500) > MCC (223) > Capsule Shell (118)
        # > Anticaking Agents (7). Stearate + Silica collapse into a
        # single combined entry to match the workbook's label copy.
        assert labels == [
            "Active Compound",
            "Microcrystalline Cellulose (Carrier)",
            "Capsule Shell (Hypromellose)",
            "Anticaking Agents (Magnesium Stearate, Silicon Dioxide)",
        ]
        assert "Capsule Shell (Hypromellose)" in declaration
        assert (
            "Anticaking Agents (Magnesium Stearate, Silicon Dioxide)"
            in declaration
        )

    def test_tablet_includes_dcp_and_mcc(self) -> None:
        org = OrganizationFactory()
        active = _item(
            org,
            name="Active",
            purity=1.0,
            type="Others",
            ingredient_list_name="Active Compound",
        )
        totals = compute_totals(
            lines=[("a", active, Decimal("100"), None)],
            dosage_form="tablet",
            tablet_size_key="round_13mm",
        )
        declaration, entries = build_ingredient_declaration(
            items_by_external_id={"a": active},
            totals=totals,
        )
        labels = [e.label for e in entries]
        # active 100, MCC 20, DCP 10, Anticaking 1.4 (Stearate 1 + Silica 0.4).
        # No capsule shell on a tablet.
        assert labels == [
            "Active Compound",
            "Microcrystalline Cellulose (Carrier)",
            "Dicalcium Phosphate",
            "Anticaking Agents (Magnesium Stearate, Silicon Dioxide)",
        ]

    def test_falls_back_to_raw_name_when_list_name_missing(self) -> None:
        org = OrganizationFactory()
        # No ``ingredient_list_name`` set.
        item = _item(org, name="Obscure Raw Material", purity=1.0, type="Others")
        # ``other_solid`` keeps the declaration free of the flavour
        # system preset powder + gummy ship.
        totals = compute_totals(
            lines=[("a", item, Decimal("100"), None)],
            dosage_form="other_solid",
        )
        declaration, _ = build_ingredient_declaration(
            items_by_external_id={"a": item},
            totals=totals,
        )
        assert declaration == "Obscure Raw Material"


# ---------------------------------------------------------------------------
# Integration with save_version — snapshots must preserve F2a output
# ---------------------------------------------------------------------------


class TestVersionSnapshotIncludesF2a:
    def test_snapshot_totals_includes_compliance_and_declaration(self) -> None:
        from apps.formulations.services import save_version

        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule", capsule_size="double_00"
        )
        a = _item(
            org,
            name="A",
            purity=1.0,
            type="Others",
            vegan="Vegan",
            organic="Non-Organic",
            halal="Halal",
            kosher="Kosher",
            ingredient_list_name="A Ingredient",
        )
        b = _item(
            org,
            name="B",
            purity=1.0,
            type="Others",
            vegan="Vegan",
            organic="Organic",
            halal="Halal",
            kosher="Kosher",
            ingredient_list_name="B Ingredient",
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[
                {"item_id": str(a.id), "label_claim_mg": "100"},
                {"item_id": str(b.id), "label_claim_mg": "50"},
            ],
        )
        version = save_version(formulation=formulation, actor=org.created_by)
        totals_snapshot = version.snapshot_totals
        assert "compliance" in totals_snapshot
        assert "declaration" in totals_snapshot

        flags = {
            f["key"]: f for f in totals_snapshot["compliance"]["flags"]
        }
        # One ingredient is non-organic → product is not organic.
        assert flags["organic"]["status"] is False
        # Vegan / halal / kosher are all fine.
        assert flags["vegan"]["status"] is True
        assert flags["halal"]["status"] is True
        assert flags["kosher"]["status"] is True

        # Declaration sorts A (100) before B (50), merges MCC + shell + excipients.
        text = totals_snapshot["declaration"]["text"]
        first_active_pos = text.index("A Ingredient")
        second_active_pos = text.index("B Ingredient")
        assert first_active_pos < second_active_pos
        assert "Capsule Shell (Hypromellose)" in text
