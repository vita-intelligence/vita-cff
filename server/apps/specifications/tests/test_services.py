"""Service-layer tests for the specifications app."""

from __future__ import annotations

import pytest

from apps.formulations.services import (
    replace_lines,
    save_version,
    update_formulation,
)
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
    resolve_limits,
    set_section_visibility,
    show_watermark_for,
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


class TestSetPackaging:
    """Slot-by-slot packaging assignment. Partial calls (one slot at a
    time) must leave the rest of the sheet untouched — the spec sheet
    builder regularly opens the modal to swap a single slot, and a
    full-payload re-validation would fail the whole request whenever
    any previously-stored item drifts (item archived, ``packaging_type``
    edited)."""

    def _packaging_item(self, org, packaging_type: str):
        from apps.catalogues.tests.factories import (
            ItemFactory,
            packaging_catalogue,
        )

        return ItemFactory(
            catalogue=packaging_catalogue(org),
            name=f"Test {packaging_type}",
            attributes={"packaging_type": packaging_type},
        )

    def test_assigns_single_slot_without_touching_others(self) -> None:
        from apps.specifications.services import set_packaging

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        lid = self._packaging_item(org, "closure")
        # Caller sends only the slot it wants to set — siblings stay
        # untouched and don't need to round-trip through the picker.
        updated = set_packaging(
            sheet=sheet,
            actor=org.created_by,
            selections={"packaging_lid": str(lid.id)},
        )
        assert updated.packaging_lid_id == lid.id
        assert updated.packaging_container_id is None
        assert updated.packaging_label_id is None
        assert updated.packaging_antitemper_id is None

    def test_clearing_one_slot_keeps_others(self) -> None:
        from apps.specifications.services import set_packaging

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        lid = self._packaging_item(org, "closure")
        container = self._packaging_item(org, "material")
        # Two slots set up front.
        set_packaging(
            sheet=sheet,
            actor=org.created_by,
            selections={
                "packaging_lid": str(lid.id),
                "packaging_container": str(container.id),
            },
        )
        # Now clear just the lid; container must survive.
        updated = set_packaging(
            sheet=sheet,
            actor=org.created_by,
            selections={"packaging_lid": None},
        )
        assert updated.packaging_lid_id is None
        assert updated.packaging_container_id == container.id

    def test_rejects_slot_type_mismatch(self) -> None:
        from apps.specifications.services import (
            PackagingItemNotAllowed,
            set_packaging,
        )

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        # A material item handed to the lid slot must fail with the
        # codified error — the API layer maps it to a 400.
        material = self._packaging_item(org, "material")
        with pytest.raises(PackagingItemNotAllowed):
            set_packaging(
                sheet=sheet,
                actor=org.created_by,
                selections={"packaging_lid": str(material.id)},
            )


_SIG_FIXTURE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="


class TestStatusTransitions:
    def test_draft_to_in_review(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        updated = transition_status(
            sheet=sheet,
            actor=org.created_by,
            next_status="in_review",
            signature_image=_SIG_FIXTURE,
        )
        assert updated.status == "in_review"
        assert updated.prepared_by_user_id == org.created_by.id
        assert updated.prepared_by_signature_image == _SIG_FIXTURE

    def test_draft_to_in_review_without_signature_raises(self) -> None:
        from apps.specifications.services import SignatureRequired

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        with pytest.raises(SignatureRequired):
            transition_status(
                sheet=sheet,
                actor=org.created_by,
                next_status="in_review",
            )

    def test_cannot_jump_draft_to_approved(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="draft")
        with pytest.raises(InvalidStatusTransition):
            transition_status(
                sheet=sheet,
                actor=org.created_by,
                next_status="approved",
                signature_image=_SIG_FIXTURE,
            )

    def test_terminal_accepted_cannot_transition(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="accepted")
        with pytest.raises(InvalidStatusTransition):
            transition_status(
                sheet=sheet, actor=org.created_by, next_status="draft"
            )

    def test_internal_cannot_move_sent_to_accepted(self) -> None:
        """The ``sent → accepted`` transition is reserved for the
        kiosk endpoint that binds a customer signature + identity.
        An internal actor cannot reach ``accepted`` through this
        path, even with a valid signature image."""

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org, status="sent")
        with pytest.raises(InvalidStatusTransition):
            transition_status(
                sheet=sheet,
                actor=org.created_by,
                next_status="accepted",
                signature_image=_SIG_FIXTURE,
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
            "signatures",
            "formulation",
            "totals",
            "actives",
            "compliance",
            "declaration",
            "allergens",
            "nutrition",
            "amino_acids",
            "history",
            "packaging",
            "limits",
            "weight_uniformity",
            "visibility",
            "section_order",
            "watermark",
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

    def test_actives_sorted_by_mg_per_serving_descending(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        # Insertion order is deliberately small → large → mid so the
        # snapshot's natural order doesn't accidentally match the sort.
        small = ItemFactory(
            catalogue=catalogue,
            name="Trace Mineral",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Trace Mineral",
            },
        )
        large = ItemFactory(
            catalogue=catalogue,
            name="Bulk Active",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Bulk Active",
            },
        )
        mid = ItemFactory(
            catalogue=catalogue,
            name="Mid Active",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Mid Active",
            },
        )
        formulation = FormulationFactory(
            organization=org, dosage_form="capsule", capsule_size="double_00"
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[
                {"item_id": str(small.id), "label_claim_mg": "1"},
                {"item_id": str(large.id), "label_claim_mg": "500"},
                {"item_id": str(mid.id), "label_claim_mg": "50"},
            ],
        )
        version = save_version(formulation=formulation, actor=org.created_by)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        labels = [active["ingredient_list_name"] for active in ctx["actives"]]
        assert labels == ["Bulk Active", "Mid Active", "Trace Mineral"]

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

    def test_limits_include_all_eight_rows(self) -> None:
        # Eight rows now: the "Others" line for Non-GMO / Non-Irradiated
        # / BSE/TSE joined the block when we matched the reference PDF.
        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        ctx = render_context(sheet)
        assert len(ctx["limits"]) == 8
        assert ctx["limits"][0]["name"] == "Total Aerobic Microbial Count"
        assert ctx["limits"][-1]["name"] == "Others"

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


class TestSnapshotOverrides:
    """Phase G5a — last-mile spec sheet edits. The override map sits
    on the sheet and is merged over the frozen snapshot at render
    time."""

    def test_formulation_metadata_overrides_apply(self) -> None:
        from apps.specifications.services import update_sheet

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={
                "formulation": {
                    "directions_of_use": "Take with breakfast.",
                    "appearance": "Yellow capsule",
                }
            },
        )
        sheet.refresh_from_db()
        ctx = render_context(sheet)
        assert ctx["formulation"]["directions_of_use"] == "Take with breakfast."
        assert ctx["formulation"]["directions_of_use_overridden"] is True
        assert ctx["formulation"]["appearance"] == "Yellow capsule"
        # Untouched keys still flow from the snapshot.
        assert ctx["formulation"]["suggested_dosage_overridden"] is False

    def test_declaration_text_override_replaces_string(self) -> None:
        from apps.specifications.services import update_sheet

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={
                "declaration": {"text": "Custom declaration"}
            },
        )
        sheet.refresh_from_db()
        ctx = render_context(sheet)
        assert ctx["declaration"]["text"] == "Custom declaration"
        assert ctx["declaration"]["text_overridden"] is True

    def test_compliance_override_swaps_status(self) -> None:
        from apps.specifications.services import update_sheet

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={
                "compliance": {"vegan": "no", "halal": "unknown"}
            },
        )
        sheet.refresh_from_db()
        ctx = render_context(sheet)
        flags = {f["key"]: f for f in ctx["compliance"]["flags"]}
        assert flags["vegan"]["status"] is False
        assert flags["vegan"]["override_applied"] is True
        assert flags["halal"]["status"] is None
        assert flags["halal"]["override_applied"] is True
        # An untouched flag still comes through unchanged.
        assert "override_applied" not in flags["organic"]

    def test_allergens_override_replaces_list(self) -> None:
        from apps.specifications.services import update_sheet

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={"allergens": {"sources": ["Milk", "Soy"]}},
        )
        sheet.refresh_from_db()
        ctx = render_context(sheet)
        assert ctx["allergens"]["sources"] == ["Milk", "Soy"]
        assert ctx["allergens"]["allergen_count"] == 2
        assert ctx["allergens"]["sources_overridden"] is True

    def test_per_active_overrides_apply(self) -> None:
        from apps.specifications.services import update_sheet

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        # Pull the snapshot's first line id to target the override.
        line_id = version.snapshot_lines[0]["item_id"]
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={
                "actives": {
                    line_id: {"label_claim_mg": "200", "nrv_pct": "120"}
                }
            },
        )
        sheet.refresh_from_db()
        ctx = render_context(sheet)
        active = ctx["actives"][0]
        assert active["label_claim_mg"] == "200"
        assert active["label_claim_overridden"] is True
        assert active["nrv_percent"] == "120"
        assert active["nrv_overridden"] is True

    def test_invalid_section_rejected(self) -> None:
        from apps.specifications.services import (
            InvalidSnapshotOverrides,
            update_sheet,
        )

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        with pytest.raises(InvalidSnapshotOverrides):
            update_sheet(
                sheet=sheet,
                actor=org.created_by,
                snapshot_overrides={"unknown_section": {"x": "y"}},
            )

    def test_invalid_compliance_value_rejected(self) -> None:
        from apps.specifications.services import (
            InvalidSnapshotOverrides,
            update_sheet,
        )

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        with pytest.raises(InvalidSnapshotOverrides):
            update_sheet(
                sheet=sheet,
                actor=org.created_by,
                snapshot_overrides={"compliance": {"vegan": "maybe"}},
            )

    def test_empty_overrides_clears_all(self) -> None:
        from apps.specifications.services import update_sheet

        org = OrganizationFactory()
        version = _seeded_version(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={
                "formulation": {"appearance": "Edited appearance"}
            },
        )
        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={},
        )
        sheet.refresh_from_db()
        assert sheet.snapshot_overrides == {}
        ctx = render_context(sheet)
        assert ctx["formulation"]["appearance_overridden"] is False


class TestExcipientMgOverridesDropEntries:
    """Setting an ``excipients_mg`` override to ``"0"`` must drop the
    matching row from BOTH the rendered excipient table (which the
    frontend reads off ``rendered.declaration.entries``) AND the
    joined ingredient declaration string. Anything else means the
    override modal silently lies — the user clicks Save, sees the row
    still listed, and stops trusting the override surface."""

    def _seed_capsule_with_carrier(self, org):
        catalogue = raw_materials_catalogue(org)
        active = ItemFactory(
            catalogue=catalogue,
            name="Active Raw",
            attributes={
                "type": "Others",
                "purity": "1",
                "ingredient_list_name": "Active Compound",
            },
        )
        carrier = ItemFactory(
            catalogue=catalogue,
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
        return save_version(formulation=formulation, actor=org.created_by)

    def test_mcc_zero_override_drops_carrier_row(self) -> None:
        org = OrganizationFactory()
        version = self._seed_capsule_with_carrier(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )

        # Sanity: the snapshot has a non-zero MCC carrier entry.
        ctx_before = render_context(sheet)
        excipient_labels_before = {
            e["label"]
            for e in ctx_before["declaration"]["entries"]
            if e["category"] != "active"
        }
        assert "Microcrystalline Cellulose" in excipient_labels_before

        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={"excipients_mg": {"mcc_mg": "0"}},
        )
        sheet.refresh_from_db()
        ctx_after = render_context(sheet)

        excipient_labels_after = {
            e["label"]
            for e in ctx_after["declaration"]["entries"]
            if e["category"] != "active"
        }
        # MCC row gone from the per-row entries the spec sheet
        # excipient table renders from.
        assert "Microcrystalline Cellulose" not in excipient_labels_after
        # And gone from the joined declaration string the ingredient
        # paragraph prints.
        assert "Microcrystalline Cellulose" not in ctx_after["declaration"]["text"]
        assert "Carrier" not in ctx_after["declaration"]["text"]

    def test_mcc_positive_override_rewrites_mg(self) -> None:
        org = OrganizationFactory()
        version = self._seed_capsule_with_carrier(org)
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )

        update_sheet(
            sheet=sheet,
            actor=org.created_by,
            snapshot_overrides={"excipients_mg": {"mcc_mg": "42"}},
        )
        sheet.refresh_from_db()
        ctx = render_context(sheet)

        carrier_entries = [
            e
            for e in ctx["declaration"]["entries"]
            if e["label"] == "Microcrystalline Cellulose"
        ]
        assert len(carrier_entries) == 1
        assert carrier_entries[0]["mg"] == "42"
        assert carrier_entries[0].get("mg_overridden") is True


class TestActivesLabelPerServing:
    """Regression for the multi-capsule labelling bug: the snapshot's
    ``mg_per_serving`` is actually per-*unit* (per-capsule), so the
    templated nutrition name used to embed a per-capsule raw weight
    and read wrong against the per-serving Claim column. The spec
    renderer now multiplies by ``serving_size`` before instantiating
    the label so "From Xmg of N:1 Extract" is always the per-serving
    weight, matching scientist expectations."""

    def test_multi_unit_serving_labels_per_serving_raw_weight(self) -> None:
        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        # Botanical with a templated label + 10:1 extract. The template
        # uses "??mg" which instantiate_active_label replaces with the
        # raw extract weight.
        item = ItemFactory(
            catalogue=catalogue,
            name="Maca Extract (10:1)",
            attributes={
                "type": "Botanical",
                "extract_ratio": "10",
                "ingredient_list_name": "Maca Extract",
                "nutrition_information_name":
                    "Maca Extract (From ??mg of 10:1 Extract)",
            },
        )
        # 2 capsules per serving, label claim 200 mg *per serving*.
        # Per-unit claim → 100 mg/cap; per-unit raw → 10 mg/cap
        # (100 / 10 extract_ratio); per-serving raw → 20 mg.
        formulation = FormulationFactory(
            organization=org,
            dosage_form="capsule",
            capsule_size="double_00",
            serving_size=2,
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "200"}],
        )
        version = save_version(
            formulation=formulation, actor=org.created_by
        )
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )

        ctx = render_context(sheet)
        maca = next(a for a in ctx["actives"] if a["item_name"].startswith("Maca"))

        # "From 20mg" = per-serving raw weight (10 mg/cap × 2 caps).
        # The bug rendered "From 10mg" (per-cap), which is what
        # scientists reported as "the numbers look wrong by half" —
        # on a 2-cap product the label claim reads 2× the embedded mg.
        assert "From 20mg" in maca["ingredient_list_name"]
        # The per-serving mg field on the active row itself should
        # also reflect per-serving — downstream UIs consume this.
        assert maca["mg_per_serving"].startswith("20")
        # And the per-serving label claim column is the scientist's
        # input verbatim (200 mg), not divided down. The snapshot
        # stores Decimals at 4-decimal precision so the string carries
        # trailing zeros — compare against the numeric value rather
        # than the exact textual form.
        from decimal import Decimal as _D
        assert _D(maca["label_claim_mg"]) == _D("200")

    def test_single_unit_serving_labels_unchanged(self) -> None:
        """Single-capsule servings (serving_size=1) were correct
        before the fix and must stay correct — the multiplier just
        becomes a no-op."""

        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        item = ItemFactory(
            catalogue=catalogue,
            name="Maca Extract (10:1)",
            attributes={
                "type": "Botanical",
                "extract_ratio": "10",
                "ingredient_list_name": "Maca Extract",
                "nutrition_information_name":
                    "Maca Extract (From ??mg of 10:1 Extract)",
            },
        )
        formulation = FormulationFactory(
            organization=org,
            dosage_form="capsule",
            capsule_size="double_00",
            serving_size=1,
        )
        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "200"}],
        )
        version = save_version(
            formulation=formulation, actor=org.created_by
        )
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )

        ctx = render_context(sheet)
        maca = next(a for a in ctx["actives"] if a["item_name"].startswith("Maca"))
        # 200 / 10 extract_ratio = 20 mg raw per cap; 1 cap per
        # serving → 20 mg per serving (same number either way).
        assert "From 20mg" in maca["ingredient_list_name"]


class TestActivesLabelFieldPriority:
    """Cover the actives-table label resolution.

    Per R&D's workbook convention, ``nutrition_information_name`` is
    the canonical clean spec-sheet label — the ``Raw Material`` and
    ``Ingredient list Name`` columns frequently carry full technical
    names (purity, mesh, encapsulation grade) that are noise in the
    customer-facing sheet. The renderer prefers ``nutrition_
    information_name`` for that reason, with the legacy
    ``ingredient_list_name`` and raw item name kept as fallbacks.
    """

    def _build_sheet(self, org, attributes):
        catalogue = raw_materials_catalogue(org)
        item = ItemFactory(
            catalogue=catalogue,
            name="L-Leucine (95%)(DC grade)(5% HPMC)",
            attributes={
                "type": "Others",
                "purity": "1",
                **attributes,
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
            lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
        )
        version = save_version(
            formulation=formulation, actor=org.created_by
        )
        return create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )

    def test_nutrition_name_plain_string_wins_over_ingredient_list(
        self,
    ) -> None:
        """When R&D fills both fields, the clean ``nutrition_
        information_name`` (``L-Leucine``) is what appears on the
        spec sheet — the messier ``ingredient_list_name`` is
        ignored. This is the bug fix that triggered the rule."""

        org = OrganizationFactory()
        sheet = self._build_sheet(
            org,
            {
                "ingredient_list_name":
                    "L-Leucine (95%)(DC grade)(5% HPMC)",
                "nutrition_information_name": "L-Leucine",
            },
        )
        active = render_context(sheet)["actives"][0]
        assert active["ingredient_list_name"] == "L-Leucine"

    def test_falls_back_to_ingredient_list_when_nutrition_name_blank(
        self,
    ) -> None:
        """Older catalogue rows that only filled
        ``ingredient_list_name`` must still render the clean label."""

        org = OrganizationFactory()
        sheet = self._build_sheet(
            org,
            {
                "ingredient_list_name": "Branched-Chain Amino Acid",
                # nutrition_information_name deliberately empty
            },
        )
        active = render_context(sheet)["actives"][0]
        assert active["ingredient_list_name"] == "Branched-Chain Amino Acid"

    def test_falls_back_to_item_name_when_both_blank(self) -> None:
        """A catalogue row missing both label fields gracefully
        degrades to the raw item name rather than rendering an
        empty cell."""

        org = OrganizationFactory()
        sheet = self._build_sheet(org, attributes={})
        active = render_context(sheet)["actives"][0]
        assert active["ingredient_list_name"] == (
            "L-Leucine (95%)(DC grade)(5% HPMC)"
        )

    def test_botanical_template_path_unaffected(self) -> None:
        """The ``??mg`` extract template still wins over the plain-
        nutrition-name path, so botanicals keep rendering with their
        per-serving raw weight inlined."""

        org = OrganizationFactory()
        catalogue = raw_materials_catalogue(org)
        item = ItemFactory(
            catalogue=catalogue,
            name="Acerola Extract (4:1)",
            attributes={
                "type": "Botanical",
                "extract_ratio": "4",
                "ingredient_list_name": "Acerola Extract",
                "nutrition_information_name":
                    "Acerola Extract (From ??mg of 4:1 Extract)",
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
            lines=[{"item_id": str(item.id), "label_claim_mg": "200"}],
        )
        version = save_version(
            formulation=formulation, actor=org.created_by
        )
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
        )
        active = render_context(sheet)["actives"][0]
        # 200 mg claim ÷ 4 extract ratio = 50 mg raw per serving.
        assert active["ingredient_list_name"] == (
            "Acerola Extract (From 50mg of 4:1 Extract)"
        )


class TestGetSheetIsolation:
    def test_other_orgs_sheet_is_404(self) -> None:
        a = OrganizationFactory()
        b = OrganizationFactory()
        foreign = SpecificationSheetFactory(organization=b)
        with pytest.raises(SpecificationNotFound):
            get_sheet(organization=a, sheet_id=foreign.id)


class TestResolveLimits:
    def test_sheet_override_beats_org_default(self) -> None:
        org = OrganizationFactory(
            default_spec_limits={"total_aerobic": "≤1,000"}
        )
        sheet = SpecificationSheetFactory(
            organization=org, limits_override={"total_aerobic": "≤100"}
        )
        rows = resolve_limits(sheet)
        # Override wins; every other row falls back to canonical defaults.
        total_aerobic = next(r for r in rows if r["slug"] == "total_aerobic")
        assert total_aerobic["value"] == "≤100"

    def test_org_default_beats_canonical_when_override_blank(self) -> None:
        org = OrganizationFactory(
            default_spec_limits={"total_aerobic": "≤1,000"}
        )
        sheet = SpecificationSheetFactory(organization=org)
        rows = resolve_limits(sheet)
        total_aerobic = next(r for r in rows if r["slug"] == "total_aerobic")
        assert total_aerobic["value"] == "≤1,000"

    def test_canonical_fallback_for_empty_org(self) -> None:
        org = OrganizationFactory(default_spec_limits={})
        sheet = SpecificationSheetFactory(organization=org)
        rows = resolve_limits(sheet)
        # PAH is sourced from canonical defaults when both overrides
        # and org-level map are empty.
        pah = next(r for r in rows if r["slug"] == "pah")
        assert pah["value"] == "≤50μg/kg"


class TestSectionVisibility:
    def test_default_visibility_is_all_true(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        ctx = render_context(sheet)
        assert ctx["visibility"]["actives"] is True
        assert ctx["visibility"]["packaging_specification"] is True

    def test_toggle_writes_and_survives_round_trip(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        set_section_visibility(
            sheet=sheet,
            actor=org.created_by,
            visibility={"amino_acids": False, "ingredients": False},
        )
        sheet.refresh_from_db()
        assert sheet.section_visibility == {
            "amino_acids": False,
            "ingredients": False,
        }
        ctx = render_context(sheet)
        assert ctx["visibility"]["amino_acids"] is False
        # Untouched sections still render as visible.
        assert ctx["visibility"]["nutrition"] is True

    def test_partial_toggle_does_not_reset_other_sections(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org,
            section_visibility={"amino_acids": False},
        )
        set_section_visibility(
            sheet=sheet,
            actor=org.created_by,
            visibility={"ingredients": False},
        )
        sheet.refresh_from_db()
        assert sheet.section_visibility == {
            "amino_acids": False,
            "ingredients": False,
        }

    def test_unknown_slug_silently_dropped(self) -> None:
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)
        set_section_visibility(
            sheet=sheet,
            actor=org.created_by,
            visibility={"bogus_section": False},
        )
        sheet.refresh_from_db()
        assert sheet.section_visibility == {}


class TestWatermarkDecision:
    """The watermark is driven by the explicit ``document_kind`` now,
    not by lifecycle ``status``. ``draft`` prints watermarked,
    ``final`` prints clean — regardless of where the sheet is in the
    approval machine."""

    def test_draft_kind_watermarks(self) -> None:
        assert show_watermark_for("draft") is True

    def test_final_kind_prints_clean(self) -> None:
        assert show_watermark_for("final") is False

    def test_unknown_value_defaults_to_watermark(self) -> None:
        # Safety net — unknown kinds treated as "not explicitly final"
        # so we never accidentally ship a clean PDF on a corrupted row.
        assert show_watermark_for("bogus") is True
