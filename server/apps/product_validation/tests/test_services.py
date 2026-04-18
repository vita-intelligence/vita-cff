"""Service-layer tests for the product-validation app.

Covers the stats computations per test section (weight / hardness /
thickness / disintegration / organoleptic / checklist), the overall
pass/fail tri-state roll-up, and the status transition state machine
including signature stamping.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.services import replace_lines, save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.product_validation.models import (
    ProductValidation,
    ValidationStatus,
)
from apps.product_validation.services import (
    InvalidValidationTransition,
    TrialBatchNotInOrg,
    ValidationAlreadyExists,
    ValidationNotFound,
    compute_stats,
    create_validation,
    get_validation,
    get_validation_for_batch,
    transition_status,
    update_validation,
)
from apps.trial_batches.services import create_batch


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _batch_in_org(org):
    """Seed a trial batch the validation can hang off."""

    catalogue = raw_materials_catalogue(org)
    item = ItemFactory(
        catalogue=catalogue,
        name="Test Raw",
        attributes={"type": "Others", "purity": "1"},
    )
    formulation = FormulationFactory(
        organization=org, dosage_form="capsule", capsule_size="double_00"
    )
    replace_lines(
        formulation=formulation,
        actor=org.created_by,
        lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
    )
    version = save_version(formulation=formulation, actor=org.created_by)
    return create_batch(
        organization=org,
        actor=org.created_by,
        formulation_version_id=version.id,
        batch_size_units=100,
    )


def _validation_with_data(org, **overrides) -> ProductValidation:
    """Create a validation pre-populated with the samples an actual
    scientist would enter. Keyword overrides drop-replace the JSON
    payload for a single test.
    """

    batch = _batch_in_org(org)
    validation = create_validation(
        organization=org,
        actor=org.created_by,
        trial_batch_id=batch.id,
    )
    payload: dict = {
        "weight_test": {
            "target_mg": 1270,
            "tolerance_pct": 5,
            "samples": [1255, 1268, 1272, 1280, 1262, 1275, 1269, 1271, 1274, 1267],
            "notes": "",
        },
        "disintegration_test": {
            "limit_minutes": 60,
            "temperature_c": 37,
            "samples": [45, 52, 48, 55, 49, 51],
            "notes": "",
        },
        "organoleptic_test": {
            "target": {"colour": "White", "taste": "Neutral", "odour": "Faint"},
            "actual": {"colour": "White", "taste": "Neutral", "odour": "Faint"},
            "passed": True,
            "notes": "",
        },
        "mrpeasy_checklist": {
            "raw_materials_created": True,
            "finished_product_created": True,
            "boms_verified": True,
        },
    }
    payload.update(overrides)
    return update_validation(
        validation=validation, actor=org.created_by, **payload
    )


# ---------------------------------------------------------------------------
# Create / update / lookup
# ---------------------------------------------------------------------------


class TestCreateValidation:
    def test_populates_blank_shapes(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        # Every JSON field arrives with a known shape, not empty.
        assert v.weight_test["tolerance_pct"] == 10
        assert v.weight_test["samples"] == []
        assert v.disintegration_test["limit_minutes"] == 60
        assert v.mrpeasy_checklist == {
            "raw_materials_created": False,
            "finished_product_created": False,
            "boms_verified": False,
        }
        assert v.status == ValidationStatus.DRAFT

    def test_rejects_cross_org_batch(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        other_batch = _batch_in_org(other_org)
        with pytest.raises(TrialBatchNotInOrg):
            create_validation(
                organization=my_org,
                actor=my_org.created_by,
                trial_batch_id=other_batch.id,
            )

    def test_rejects_duplicate_for_same_batch(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        with pytest.raises(ValidationAlreadyExists):
            create_validation(
                organization=org, actor=org.created_by, trial_batch_id=batch.id
            )


class TestGetValidationForBatch:
    def test_returns_none_when_no_validation(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        assert get_validation_for_batch(organization=org, batch_id=batch.id) is None

    def test_returns_existing(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        found = get_validation_for_batch(organization=org, batch_id=batch.id)
        assert found is not None
        assert found.id == v.id


class TestGetValidation:
    def test_cross_org_raises_not_found(self) -> None:
        my_org = OrganizationFactory()
        other_org = OrganizationFactory()
        batch = _batch_in_org(other_org)
        v = create_validation(
            organization=other_org,
            actor=other_org.created_by,
            trial_batch_id=batch.id,
        )
        with pytest.raises(ValidationNotFound):
            get_validation(organization=my_org, validation_id=v.id)


# ---------------------------------------------------------------------------
# Stats — per-test computation
# ---------------------------------------------------------------------------


class TestWeightStats:
    def test_pass_when_every_sample_in_band(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        stats = compute_stats(v)
        assert stats.weight.passed is True
        # Mean of the 10 samples is 1269.3 — inside the 5% band.
        assert stats.weight.mean == pytest.approx(1269.3)
        # Every sample sits in the allowed range.
        assert all(stats.weight.per_sample_passed)

    def test_fail_when_any_sample_out_of_band(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            weight_test={
                "target_mg": 1270,
                "tolerance_pct": 1,  # extremely tight band
                "samples": [1255, 1268, 1272, 1280],
                "notes": "",
            },
        )
        stats = compute_stats(v)
        # 1270 × 1% = 12.7 → band is 1257.3..1282.7. 1255 is below.
        assert stats.weight.passed is False
        assert stats.weight.per_sample_passed[0] is False

    def test_none_when_no_samples(self) -> None:
        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        stats = compute_stats(v)
        assert stats.weight.passed is None

    def test_mean_and_stdev_on_populated_samples(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            weight_test={
                "target_mg": 100,
                "tolerance_pct": 10,
                "samples": [95, 100, 105],
                "notes": "",
            },
        )
        stats = compute_stats(v)
        assert stats.weight.mean == pytest.approx(100.0)
        # Population stdev of [95, 100, 105] is sqrt(50/3) ≈ 4.082.
        assert stats.weight.stdev == pytest.approx(4.082482904638629)


class TestHardnessStats:
    def test_pass_when_every_sample_in_band(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            hardness_test={
                "target_min_n": 40,
                "target_max_n": 60,
                "samples": [45, 52, 58],
                "notes": "",
            },
        )
        stats = compute_stats(v)
        assert stats.hardness.passed is True

    def test_fail_when_any_sample_out_of_band(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            hardness_test={
                "target_min_n": 40,
                "target_max_n": 60,
                "samples": [45, 62],  # 62 is over
                "notes": "",
            },
        )
        stats = compute_stats(v)
        assert stats.hardness.passed is False


class TestDisintegrationStats:
    def test_pass_when_worst_under_limit(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        stats = compute_stats(v)
        # Worst sample in the fixture is 55 min, limit is 60.
        assert stats.disintegration.worst_minutes == 55
        assert stats.disintegration.passed is True

    def test_fail_when_worst_exceeds_limit(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            disintegration_test={
                "limit_minutes": 30,
                "temperature_c": 37,
                "samples": [25, 28, 35],
                "notes": "",
            },
        )
        stats = compute_stats(v)
        assert stats.disintegration.worst_minutes == 35
        assert stats.disintegration.passed is False


class TestOrganolepticStats:
    def test_passes_through_explicit_flag(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            organoleptic_test={
                "target": {"colour": "A", "taste": "B", "odour": "C"},
                "actual": {"colour": "A", "taste": "B", "odour": "C"},
                "passed": False,
                "notes": "",
            },
        )
        stats = compute_stats(v)
        assert stats.organoleptic.passed is False


class TestChecklistStats:
    def test_pass_only_when_every_box_ticked(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        stats = compute_stats(v)
        assert stats.checklist.passed is True

    def test_fail_when_any_box_missing(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            mrpeasy_checklist={
                "raw_materials_created": True,
                "finished_product_created": False,
                "boms_verified": True,
            },
        )
        stats = compute_stats(v)
        assert stats.checklist.passed is False


class TestOverallStats:
    def test_true_only_when_every_section_passes(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        stats = compute_stats(v)
        assert stats.overall_passed is True

    def test_false_if_any_section_fails(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(
            org,
            disintegration_test={
                "limit_minutes": 30,
                "temperature_c": 37,
                "samples": [25, 35],  # 35 > 30 → fail
                "notes": "",
            },
        )
        stats = compute_stats(v)
        assert stats.overall_passed is False

    def test_none_when_nothing_to_judge(self) -> None:
        """Checklist defaults to False when every box is unticked —
        so a freshly-created validation has one "False" outcome from
        the checklist. Overall rolls that up to False, not None —
        a missing ERP wiring IS a failure even before any sample is
        typed. Verify that explicitly."""

        org = OrganizationFactory()
        batch = _batch_in_org(org)
        v = create_validation(
            organization=org, actor=org.created_by, trial_batch_id=batch.id
        )
        stats = compute_stats(v)
        # Checklist starts all-False → contributes a False → overall
        # is False (not None) because at least one section has a
        # concrete outcome.
        assert stats.overall_passed is False


# ---------------------------------------------------------------------------
# Status transitions
# ---------------------------------------------------------------------------


class TestTransitionStatus:
    def test_draft_to_in_progress_stamps_scientist(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        updated = transition_status(
            validation=v,
            actor=org.created_by,
            next_status=ValidationStatus.IN_PROGRESS,
        )
        assert updated.status == ValidationStatus.IN_PROGRESS
        assert updated.scientist_signature_id == org.created_by.id
        assert updated.scientist_signed_at is not None
        assert updated.rd_manager_signature_id is None

    def test_in_progress_to_passed_stamps_rd_manager(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        transition_status(
            validation=v,
            actor=org.created_by,
            next_status=ValidationStatus.IN_PROGRESS,
        )
        updated = transition_status(
            validation=v,
            actor=org.created_by,
            next_status=ValidationStatus.PASSED,
        )
        assert updated.status == ValidationStatus.PASSED
        assert updated.rd_manager_signature_id == org.created_by.id
        assert updated.rd_manager_signed_at is not None

    def test_illegal_transition_raises(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        # Cannot jump straight from draft to passed without going
        # through in_progress.
        with pytest.raises(InvalidValidationTransition):
            transition_status(
                validation=v,
                actor=org.created_by,
                next_status=ValidationStatus.PASSED,
            )

    def test_same_state_is_noop(self) -> None:
        org = OrganizationFactory()
        v = _validation_with_data(org)
        before = v.status
        unchanged = transition_status(
            validation=v,
            actor=org.created_by,
            next_status=before,
        )
        assert unchanged.status == before
        assert unchanged.scientist_signature_id is None

    def test_scientist_signature_not_reassigned_on_rollback(self) -> None:
        """Rolling back passed → in_progress must not reassign the
        scientist signature to whoever clicked the button — the
        original signer's stamp is the audit-of-record."""

        org = OrganizationFactory()
        v = _validation_with_data(org)
        transition_status(
            validation=v,
            actor=org.created_by,
            next_status=ValidationStatus.IN_PROGRESS,
        )
        original_sig = v.scientist_signature_id
        # Advance to passed, then roll back; sig must stay.
        transition_status(
            validation=v,
            actor=org.created_by,
            next_status=ValidationStatus.PASSED,
        )
        transition_status(
            validation=v,
            actor=org.created_by,
            next_status=ValidationStatus.IN_PROGRESS,
        )
        v.refresh_from_db()
        assert v.scientist_signature_id == original_sig
