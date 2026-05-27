"""Auto-create FINAL spec on trial-batch validation pass, plus the
``one FINAL per project`` invariant and the customer-signed deletion
lock.

See plan + service docs in ``apps/specifications/services.py``.
"""

from __future__ import annotations

from datetime import datetime, timezone as dt_timezone

import pytest

from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)
from apps.specifications.services import (
    FinalSpecAlreadyExists,
    FinalSpecDeletionLocked,
    auto_create_final_spec_for_version,
    create_sheet,
    delete_sheet,
    update_sheet,
)


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_version_and_draft():
    org = OrganizationFactory()
    formulation = FormulationFactory(organization=org)
    version = save_version(formulation=formulation, actor=org.created_by)
    draft = SpecificationSheet.objects.create(
        organization=org,
        formulation_version=version,
        code="SPEC-DRAFT-1",
        document_kind=SpecificationDocumentKind.DRAFT,
        status=SpecificationStatus.DRAFT,
        client_name="Acme Cosmetics",
        client_email="contact@acme.test",
        client_company="Acme Limited",
        storage_conditions="Cool, dry place below 25°C",
        shelf_life="24 months",
        unit_quantity="60 capsules",
        created_by=org.created_by,
        updated_by=org.created_by,
    )
    return org, formulation, version, draft


# ---------------------------------------------------------------------------
# Auto-create on validation pass
# ---------------------------------------------------------------------------


class TestAutoCreateFinalSpec:
    def test_creates_final_when_none_exists(self):
        org, formulation, version, draft = _make_version_and_draft()
        sheet = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        assert sheet is not None
        assert sheet.document_kind == SpecificationDocumentKind.FINAL
        assert sheet.status == SpecificationStatus.DRAFT
        # Pre-populated from the draft.
        assert sheet.client_name == draft.client_name
        assert sheet.client_email == draft.client_email
        assert sheet.client_company == draft.client_company
        assert sheet.storage_conditions == draft.storage_conditions
        assert sheet.shelf_life == draft.shelf_life
        assert sheet.unit_quantity == draft.unit_quantity
        # Code carries a ``-FINAL`` suffix derived from the draft so
        # the spec list reads "MA521352-FINAL" rather than "Untitled".
        assert sheet.code == f"{draft.code}-FINAL"

    def test_idempotent_when_final_already_exists(self):
        org, formulation, version, _ = _make_version_and_draft()
        first = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        assert first is not None
        second = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        assert second is None
        assert (
            SpecificationSheet.objects.filter(
                formulation_version__formulation=formulation,
                document_kind=SpecificationDocumentKind.FINAL,
            ).count()
            == 1
        )

    def test_code_collision_appends_suffix(self):
        """If a sheet at ``<draft>-FINAL`` already exists in the org
        (e.g. left over from an earlier project the same scientist
        worked on), the auto-create walks ``-FINAL-2``, ``-FINAL-3``,
        … until it finds a free slot."""

        org, formulation, version, draft = _make_version_and_draft()
        # Pre-create a colliding row on a sibling formulation in the
        # same org so the per-org uniqueness check fires.
        sibling = FormulationFactory(organization=org)
        sibling_version = save_version(
            formulation=sibling, actor=org.created_by
        )
        SpecificationSheet.objects.create(
            organization=org,
            formulation_version=sibling_version,
            code=f"{draft.code}-FINAL",
            document_kind=SpecificationDocumentKind.DRAFT,
            status=SpecificationStatus.DRAFT,
            created_by=org.created_by,
            updated_by=org.created_by,
        )
        sheet = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        assert sheet is not None
        assert sheet.code == f"{draft.code}-FINAL-2"

    def test_works_without_a_draft_to_copy(self):
        # No draft spec on the project; auto-create still produces a
        # FINAL — just with default/blank fields.
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        version = save_version(formulation=formulation, actor=org.created_by)
        sheet = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        assert sheet is not None
        assert sheet.document_kind == SpecificationDocumentKind.FINAL
        assert sheet.status == SpecificationStatus.DRAFT


# ---------------------------------------------------------------------------
# Create / update guards
# ---------------------------------------------------------------------------


class TestOneFinalPerProject:
    def test_create_sheet_refuses_second_final(self):
        org, formulation, version, _ = _make_version_and_draft()
        # Auto-create the FINAL, then try to create another via the
        # manual path — should refuse.
        auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        with pytest.raises(FinalSpecAlreadyExists):
            create_sheet(
                organization=org,
                actor=org.created_by,
                formulation_version_id=version.id,
                document_kind=SpecificationDocumentKind.FINAL.value,
            )

    def test_create_sheet_allows_first_final(self):
        org, formulation, version, _ = _make_version_and_draft()
        sheet = create_sheet(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            document_kind=SpecificationDocumentKind.FINAL.value,
        )
        assert sheet.document_kind == SpecificationDocumentKind.FINAL

    def test_update_to_final_refused_when_one_exists(self):
        org, formulation, version, draft = _make_version_and_draft()
        auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        # Try to flip the draft to FINAL — must refuse, the auto-created
        # FINAL already holds that slot.
        with pytest.raises(FinalSpecAlreadyExists):
            update_sheet(
                sheet=draft,
                actor=org.created_by,
                document_kind=SpecificationDocumentKind.FINAL.value,
            )


# ---------------------------------------------------------------------------
# Delete-guard for customer-signed FINAL
# ---------------------------------------------------------------------------


class TestCustomerSignedFinalDeletionLock:
    def test_signed_final_cannot_be_deleted(self):
        org, formulation, version, _ = _make_version_and_draft()
        final = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        # Simulate a customer signature: row needs to be back in DRAFT
        # status for the existing _DELETION_ALLOWED_STATUSES gate to
        # NOT trip first (we want this test to hit OUR new guard).
        SpecificationSheet.objects.filter(pk=final.pk).update(
            customer_signed_at=datetime(2026, 6, 1, tzinfo=dt_timezone.utc),
        )
        final.refresh_from_db()
        with pytest.raises(FinalSpecDeletionLocked):
            delete_sheet(sheet=final, actor=org.created_by)

    def test_unsigned_final_can_be_deleted(self):
        org, formulation, version, _ = _make_version_and_draft()
        final = auto_create_final_spec_for_version(
            formulation_version=version, actor=org.created_by
        )
        original_pk = final.pk
        # Unsigned + still DRAFT status → delete_sheet allowed.
        result = delete_sheet(sheet=final, actor=org.created_by)
        assert result["target_id"] == str(original_pk)
        assert not SpecificationSheet.objects.filter(pk=original_pk).exists()
