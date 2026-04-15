"""Unit tests for the formulation math.

The golden reference is the `Valley Low Fat Burner` workbook. The
final test in this module reproduces the full 7-ingredient capsule
formulation end-to-end and asserts that every computed value matches
the workbook to two decimal places.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.catalogues.models import Item
from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.constants import (
    auto_pick_capsule_size,
    capsule_size_by_key,
    tablet_size_by_key,
)
from apps.formulations.services import (
    compute_line,
    compute_totals,
)
from apps.organizations.tests.factories import OrganizationFactory

pytestmark = pytest.mark.django_db


def _item(org, *, name: str, purity=None, extract_ratio=None, overage=None, type_name=None) -> Item:
    attributes: dict = {}
    if purity is not None:
        attributes["purity"] = purity
    if extract_ratio is not None:
        attributes["extract_ratio"] = extract_ratio
    if overage is not None:
        attributes["overage"] = overage
    if type_name is not None:
        attributes["type"] = type_name
    return ItemFactory(
        catalogue=raw_materials_catalogue(org),
        name=name,
        attributes=attributes,
    )


# ---------------------------------------------------------------------------
# compute_line — per-ingredient math
# ---------------------------------------------------------------------------


class TestComputeLinePurity:
    def test_non_botanical_divides_by_purity(self) -> None:
        org = OrganizationFactory()
        item = _item(
            org,
            name="Caffeine",
            purity="0.89",
            type_name="Vitamin",
        )
        result = compute_line(item=item, label_claim_mg=Decimal("200"))
        # 200 / 0.89 = 224.7191...
        assert result is not None
        assert abs(float(result) - 224.7191) < 0.01

    def test_purity_stored_as_text_still_works(self) -> None:
        # The catalogue import wrote purity as a text field because
        # some rows are 'N/A'. The service layer must still coerce.
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity="0.5")
        result = compute_line(item=item, label_claim_mg=Decimal("100"))
        assert result == Decimal("200.0000")

    def test_missing_purity_returns_none(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing")
        assert compute_line(item=item, label_claim_mg=Decimal("100")) is None

    def test_unparseable_purity_returns_none(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity="N/A")
        assert compute_line(item=item, label_claim_mg=Decimal("100")) is None


class TestComputeLineBotanical:
    def test_botanical_divides_by_extract_ratio(self) -> None:
        org = OrganizationFactory()
        item = _item(
            org,
            name="Green Tea 10:1",
            extract_ratio=10,
            type_name="Botanical",
        )
        result = compute_line(item=item, label_claim_mg=Decimal("100"))
        assert result == Decimal("10.0000")

    def test_botanical_ignores_purity(self) -> None:
        org = OrganizationFactory()
        item = _item(
            org,
            name="Guarana 4:1",
            extract_ratio=4,
            purity="0.5",  # should be ignored because type is botanical
            type_name="Botanical",
        )
        result = compute_line(item=item, label_claim_mg=Decimal("10"))
        assert result == Decimal("2.5000")

    def test_botanical_without_extract_ratio_returns_none(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Unknown", type_name="Botanical")
        assert compute_line(item=item, label_claim_mg=Decimal("100")) is None


class TestComputeLineOverage:
    def test_overage_adds_percentage(self) -> None:
        # 100 mg label claim, 100% pure, 5% overage → 105 mg raw.
        org = OrganizationFactory()
        item = _item(org, name="Vitamin X", purity=1.0, overage=0.05)
        result = compute_line(item=item, label_claim_mg=Decimal("100"))
        assert result == Decimal("105.0000")

    def test_zero_overage_is_noop(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0, overage=0)
        result = compute_line(item=item, label_claim_mg=Decimal("50"))
        assert result == Decimal("50.0000")


class TestComputeLineEdgeCases:
    def test_zero_claim_returns_none(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        assert compute_line(item=item, label_claim_mg=Decimal("0")) is None

    def test_negative_claim_returns_none(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        assert compute_line(item=item, label_claim_mg=Decimal("-5")) is None

    def test_serving_size_divides_claim(self) -> None:
        # 200 mg label / 2 servings = 100 mg/serving, / 0.5 purity = 200 mg raw
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=0.5)
        result = compute_line(
            item=item, label_claim_mg=Decimal("200"), serving_size=2
        )
        assert result == Decimal("200.0000")


# ---------------------------------------------------------------------------
# compute_totals — capsule math
# ---------------------------------------------------------------------------


class TestCapsuleTotals:
    def test_small_formulation_picks_size_1(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        totals = compute_totals(
            lines=[("a", item, Decimal("250"), None)],
            dosage_form="capsule",
        )
        assert totals.size_key == "size_1"
        assert totals.size_label == "Size 1"
        assert totals.max_weight_mg == Decimal("380.0000")

    def test_capsule_excipient_breakdown(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        totals = compute_totals(
            lines=[("a", item, Decimal("500"), None)],
            dosage_form="capsule",
            capsule_size_key="double_00",
        )
        assert totals.total_active_mg == Decimal("500.0000")
        assert totals.excipients is not None
        # 500 * 1% = 5, 500 * 0.4% = 2, 730 - 500 - 5 - 2 = 223
        assert totals.excipients.mg_stearate_mg == Decimal("5.0000")
        assert totals.excipients.silica_mg == Decimal("2.0000")
        assert totals.excipients.mcc_mg == Decimal("223.0000")

    def test_capsule_can_make_flag(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        totals = compute_totals(
            lines=[("a", item, Decimal("500"), None)],
            dosage_form="capsule",
            capsule_size_key="double_00",
        )
        assert totals.viability.fits is True
        assert "can_make" in totals.viability.codes
        assert "less_challenging" in totals.viability.codes
        assert "proceed_to_quote" in totals.viability.codes

    def test_capsule_too_large_cannot_make(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Big", purity=1.0)
        totals = compute_totals(
            lines=[("a", item, Decimal("1200"), None)],
            dosage_form="capsule",
        )
        assert totals.viability.fits is False
        assert "cannot_make" in totals.viability.codes

    def test_capsule_auto_pick_cascade(self) -> None:
        assert auto_pick_capsule_size(200).key == "size_1"
        assert auto_pick_capsule_size(400).key == "single_0"
        assert auto_pick_capsule_size(500).key == "double_00"
        assert auto_pick_capsule_size(720) is None


# ---------------------------------------------------------------------------
# compute_totals — tablet math
# ---------------------------------------------------------------------------


class TestTabletTotals:
    def test_tablet_excipient_breakdown(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        totals = compute_totals(
            lines=[("a", item, Decimal("100"), None)],
            dosage_form="tablet",
            tablet_size_key="round_13mm",
        )
        # 100 * 1% = 1, 100 * 0.4% = 0.4, 100 * 10% = 10, 100 * 20% = 20
        # total = 100 + 1 + 0.4 + 10 + 20 = 131.4
        assert totals.excipients is not None
        assert totals.excipients.mg_stearate_mg == Decimal("1.0000")
        assert totals.excipients.silica_mg == Decimal("0.4000")
        assert totals.excipients.dcp_mg == Decimal("10.0000")
        assert totals.excipients.mcc_mg == Decimal("20.0000")
        assert totals.total_weight_mg == Decimal("131.4000")

    def test_tablet_comfort_threshold_is_75_percent(self) -> None:
        # round_6mm has max 150. 75% = 112.5.
        # Pick active that produces total just under 112.5 → comfortable
        # Pick active that produces total just over 112.5 → uncomfortable
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)

        # total = active * 1.314. active = 80 → total = 105.12 (≤ 112.5 = comfort)
        totals_easy = compute_totals(
            lines=[("a", item, Decimal("80"), None)],
            dosage_form="tablet",
            tablet_size_key="round_6mm",
        )
        assert totals_easy.viability.comfort_ok is True

        # active = 100 → total = 131.4 (> 112.5 → not comfortable, still fits < 150)
        totals_tight = compute_totals(
            lines=[("a", item, Decimal("100"), None)],
            dosage_form="tablet",
            tablet_size_key="round_6mm",
        )
        assert totals_tight.viability.fits is True
        assert totals_tight.viability.comfort_ok is False
        assert "more_challenging_to_make" in totals_tight.viability.codes

    def test_tablet_requires_size_to_check_viability(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing", purity=1.0)
        totals = compute_totals(
            lines=[("a", item, Decimal("100"), None)],
            dosage_form="tablet",
        )
        assert "tablet_size_required" in totals.viability.codes

    def test_tablet_size_lookup(self) -> None:
        assert tablet_size_by_key("round_6mm").max_weight_mg == 150.0
        assert tablet_size_by_key("oval_22_5x10mm").max_weight_mg == 1750.0
        assert tablet_size_by_key("nope") is None


# ---------------------------------------------------------------------------
# Empty + edge cases
# ---------------------------------------------------------------------------


class TestEmptyFormulation:
    def test_empty_returns_more_info_required(self) -> None:
        totals = compute_totals(lines=[], dosage_form="capsule")
        assert totals.total_active_mg == Decimal("0.0000")
        assert "more_info_required" in totals.viability.codes

    def test_lines_with_no_computable_value_treated_as_empty(self) -> None:
        org = OrganizationFactory()
        item = _item(org, name="Thing")  # no purity
        totals = compute_totals(
            lines=[("a", item, Decimal("100"), None)],
            dosage_form="capsule",
        )
        assert totals.total_active_mg == Decimal("0.0000")
        assert "a" not in totals.line_values

    def test_capsule_size_lookup(self) -> None:
        assert capsule_size_by_key("double_00").max_weight_mg == 730.0
        assert capsule_size_by_key("unknown") is None


# ---------------------------------------------------------------------------
# Golden fixture — Valley Low Fat Burner
# ---------------------------------------------------------------------------


class TestValleyLowFatBurner:
    """Reproduce the full 7-ingredient Valley formulation.

    Every computed value is asserted against the workbook's displayed
    numbers to two decimal places. This is the single test that
    proves the entire math pipeline is production-accurate.
    """

    def _build_org_with_ingredients(self):
        org = OrganizationFactory()
        # Each tuple: (name, attributes, label_claim_mg, expected_mg_per_serving)
        ingredients = [
            (
                "Caffeine Anhydrous Powder",
                # Real workbook values: 98% purity with 10% overage.
                # 200 / 0.98 * 1.10 = 224.4898
                {"purity": "0.98", "overage": 0.1, "type": "Others"},
                Decimal("200"),
                Decimal("224.4898"),
            ),
            (
                "Citrus Bioflavonoid 35%, 5:1",
                {"extract_ratio": 5, "type": "Botanical"},
                Decimal("175"),
                Decimal("35.0000"),  # 175 / 5
            ),
            (
                "Nicotinic Acid (IR)",
                {"purity": "1", "type": "Vitamin"},
                Decimal("16"),
                Decimal("16.0000"),
            ),
            (
                "Green Tea 10:1 95% Polyphenols",
                {"extract_ratio": 10, "type": "Botanical"},
                Decimal("100"),
                Decimal("10.0000"),  # 100 / 10
            ),
            (
                "Guarana Extract (4:1 Extract)",
                {"extract_ratio": 4, "type": "Botanical"},
                Decimal("10"),
                Decimal("2.5000"),  # 10 / 4
            ),
            (
                "Acetyl-L-Carnitine 66.2%",
                {"purity": "0.662", "type": "Amino Acids"},
                Decimal("2"),
                Decimal("3.0211"),  # 2 / 0.662
            ),
            (
                "Dicalcium Phosphate Dihydrate",
                {"purity": "0.225", "type": "Mineral"},
                Decimal("50"),
                Decimal("222.2222"),  # 50 / 0.225
            ),
        ]

        items_with_claims = []
        for name, attrs, claim, _ in ingredients:
            item = ItemFactory(
                catalogue=raw_materials_catalogue(org),
                name=name,
                attributes=attrs,
            )
            items_with_claims.append((item, claim))
        return org, items_with_claims, ingredients

    def test_per_line_values_match_sheet(self) -> None:
        org, items_with_claims, ingredients = self._build_org_with_ingredients()
        for (item, claim), (_, _, _, expected) in zip(items_with_claims, ingredients):
            result = compute_line(item=item, label_claim_mg=claim)
            assert result is not None
            assert abs(float(result) - float(expected)) < 0.01, (
                f"{item.name}: {result} vs expected {expected}"
            )

    def test_total_active_matches_sheet(self) -> None:
        org, items_with_claims, _ = self._build_org_with_ingredients()
        totals = compute_totals(
            lines=[
                (str(i), item, claim, None)
                for i, (item, claim) in enumerate(items_with_claims)
            ],
            dosage_form="capsule",
            capsule_size_key="double_00",
        )
        # Workbook shows 513.2331661768433 for D31 (Total Active)
        assert abs(float(totals.total_active_mg) - 513.2331) < 0.01

    def test_capsule_excipient_block_matches_sheet(self) -> None:
        org, items_with_claims, _ = self._build_org_with_ingredients()
        totals = compute_totals(
            lines=[
                (str(i), item, claim, None)
                for i, (item, claim) in enumerate(items_with_claims)
            ],
            dosage_form="capsule",
            capsule_size_key="double_00",
        )
        assert totals.excipients is not None
        # Workbook D32=5.132331661768433, D33=2.052932664707373, D34=209.58156949668103
        assert abs(float(totals.excipients.mg_stearate_mg) - 5.1323) < 0.01
        assert abs(float(totals.excipients.silica_mg) - 2.0529) < 0.01
        assert abs(float(totals.excipients.mcc_mg) - 209.5816) < 0.01

    def test_viability_matches_sheet(self) -> None:
        org, items_with_claims, _ = self._build_org_with_ingredients()
        totals = compute_totals(
            lines=[
                (str(i), item, claim, None)
                for i, (item, claim) in enumerate(items_with_claims)
            ],
            dosage_form="capsule",
            capsule_size_key="double_00",
        )
        # Workbook shows: CAN MAKE, LESS CHALLENGING, PROCEED TO QUOTE
        assert totals.viability.fits is True
        assert totals.viability.comfort_ok is True
        assert set(totals.viability.codes) == {
            "can_make",
            "less_challenging",
            "proceed_to_quote",
        }

    def test_capsule_size_resolves_to_double_00(self) -> None:
        org, items_with_claims, _ = self._build_org_with_ingredients()
        # Don't pass capsule_size_key — auto-pick should land on Double 00
        # because total active (~513) is under 719.78 but over 446.658.
        totals = compute_totals(
            lines=[
                (str(i), item, claim, None)
                for i, (item, claim) in enumerate(items_with_claims)
            ],
            dosage_form="capsule",
        )
        assert totals.size_key == "double_00"
        assert totals.max_weight_mg == Decimal("730.0000")
