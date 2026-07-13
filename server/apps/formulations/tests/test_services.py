"""Service-layer tests covering CRUD, versioning, and rollback."""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.models import FormulationLine
from apps.formulations.models import ProjectStatus
from apps.formulations.services import (
    CloneTargetIsSource,
    CloneTargetNotFound,
    CloneTargetRequired,
    FormulationCodeConflict,
    FormulationCodeRequired,
    FormulationNotFound,
    FormulationVersionNotFound,
    InvalidCapsuleSize,
    ProjectTypeLocked,
    InvalidCloneMode,
    InvalidDcpCarrierItem,
    InvalidDosageForm,
    InvalidMccCarrierItem,
    RawMaterialNotInOrg,
    clone_formulation,
    compute_formulation_totals,
    create_formulation,
    get_formulation,
    list_formulations,
    list_versions,
    replace_lines,
    rollback_to_version,
    save_version,
    set_approved_version,
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

    def test_search_matches_name_case_insensitive(self) -> None:
        org = OrganizationFactory()
        FormulationFactory(organization=org, name="Valley Fat Burner", code="MA-1")
        FormulationFactory(organization=org, name="Mountain Vitality", code="MA-2")

        names = {
            f.name
            for f in list_formulations(organization=org, search="valley")
        }
        assert names == {"Valley Fat Burner"}

    def test_search_matches_code(self) -> None:
        org = OrganizationFactory()
        FormulationFactory(organization=org, name="Alpha", code="MA-200724")
        FormulationFactory(organization=org, name="Beta", code="MB-100999")

        codes = {
            f.code
            for f in list_formulations(organization=org, search="200724")
        }
        assert codes == {"MA-200724"}

    def test_blank_search_is_ignored(self) -> None:
        org = OrganizationFactory()
        FormulationFactory(organization=org, name="One")
        FormulationFactory(organization=org, name="Two")

        results = list(list_formulations(organization=org, search="   "))
        assert {f.name for f in results} == {"One", "Two"}

    def test_has_open_proposal_false_hides_busy_and_accepted(self) -> None:
        # The New-proposal modal uses ``has_open_proposal=False`` so
        # the picker never offers a project that already carries a
        # proposal in a non-rejected status. Accepted proposals
        # count as "open" (closed-and-signed = no new quote against
        # the same recipe; the team clones the project to re-order).
        # Only ``rejected`` returns the project to the picker.
        from apps.formulations.services import save_version
        from apps.proposals.models import ProposalStatus
        from apps.proposals.tests.factories import ProposalFactory

        org = OrganizationFactory()
        free = FormulationFactory(organization=org, name="Free")
        busy = FormulationFactory(organization=org, name="Busy")
        # Accepted: deal closed, project should be hidden so we
        # don't send a duplicate.
        accepted = FormulationFactory(organization=org, name="Accepted")
        # Rejected: deal lost, project returns to the picker.
        rejected = FormulationFactory(organization=org, name="Rejected")

        seed = (
            (busy, ProposalStatus.SENT.value),
            (accepted, ProposalStatus.ACCEPTED.value),
            (rejected, ProposalStatus.REJECTED.value),
        )
        for f, status_value in seed:
            version = save_version(formulation=f, actor=org.created_by)
            ProposalFactory(
                organization=org,
                formulation_version=version,
                status=status_value,
            )

        eligible = {
            f.name
            for f in list_formulations(
                organization=org, has_open_proposal=False
            )
        }
        assert eligible == {"Free", "Rejected"}
        assert "Busy" not in eligible
        assert "Accepted" not in eligible

    def test_has_open_proposal_false_keeps_project_with_free_second_spec(
        self,
    ) -> None:
        # Multi-spec bug fix: a project with one in-flight proposal
        # AND a second director-approved spec that isn't yet bundled
        # into any proposal must STILL appear in the picker. Sales
        # raises the second proposal against the second spec; hiding
        # the project at the formulation level stripped that workflow.
        from apps.formulations.services import save_version
        from apps.proposals.models import ProposalStatus
        from apps.proposals.tests.factories import ProposalFactory
        from apps.specifications.models import (
            SpecificationSheet,
            SpecificationStatus,
        )

        org = OrganizationFactory()
        project = FormulationFactory(organization=org, name="Multi-Spec")
        version = save_version(formulation=project, actor=org.created_by)

        # Spec A — director-approved AND already attached to a sent
        # proposal. Mirrors the user's reported flow: the customer
        # has Spec A in their inbox.
        spec_a = SpecificationSheet.objects.create(
            organization=org,
            formulation_version=version,
            code="SPEC-A",
            status=SpecificationStatus.ACCEPTED,
            created_by=org.created_by,
            updated_by=org.created_by,
        )
        ProposalFactory(
            organization=org,
            formulation_version=version,
            specification_sheet=spec_a,
            status=ProposalStatus.SENT.value,
        )

        # Spec B — also director-approved on the same recipe but
        # not yet bundled into any proposal. This is the spec sales
        # wants to attach to a brand-new quote.
        SpecificationSheet.objects.create(
            organization=org,
            formulation_version=version,
            code="SPEC-B",
            status=SpecificationStatus.APPROVED,
            created_by=org.created_by,
            updated_by=org.created_by,
        )

        eligible = {
            f.name
            for f in list_formulations(
                organization=org, has_open_proposal=False
            )
        }
        assert "Multi-Spec" in eligible

    def test_has_open_proposal_false_hides_project_with_every_spec_busy(
        self,
    ) -> None:
        # Inverse of the multi-spec fix: a project where *every*
        # director-approved spec is already linked to a non-rejected
        # proposal stays excluded — there's nothing free to bundle.
        from apps.formulations.services import save_version
        from apps.proposals.models import ProposalLine, ProposalStatus
        from apps.proposals.tests.factories import ProposalFactory
        from apps.specifications.models import (
            SpecificationSheet,
            SpecificationStatus,
        )

        org = OrganizationFactory()
        project = FormulationFactory(organization=org, name="All-Busy")
        version = save_version(formulation=project, actor=org.created_by)

        spec_a = SpecificationSheet.objects.create(
            organization=org,
            formulation_version=version,
            code="SPEC-A",
            status=SpecificationStatus.APPROVED,
            created_by=org.created_by,
            updated_by=org.created_by,
        )
        ProposalFactory(
            organization=org,
            formulation_version=version,
            specification_sheet=spec_a,
            status=ProposalStatus.SENT.value,
        )

        # Spec B is busy through a multi-spec ProposalLine instead
        # of the legacy OneToOne — the resolver must spot both
        # attachment shapes or the bug fix only half-lands.
        spec_b = SpecificationSheet.objects.create(
            organization=org,
            formulation_version=version,
            code="SPEC-B",
            status=SpecificationStatus.APPROVED,
            created_by=org.created_by,
            updated_by=org.created_by,
        )
        line_proposal = ProposalFactory(
            organization=org,
            formulation_version=version,
            status=ProposalStatus.DRAFT.value,
        )
        ProposalLine.objects.create(
            proposal=line_proposal,
            formulation_version=version,
            specification_sheet=spec_b,
        )

        eligible = {
            f.name
            for f in list_formulations(
                organization=org, has_open_proposal=False
            )
        }
        assert "All-Busy" not in eligible

    def test_has_open_proposal_true_includes_accepted(self) -> None:
        # Inverse of the above. Anything not rejected counts as
        # "open" so a dashboard listing live + closed deals would
        # surface both.
        from apps.formulations.services import save_version
        from apps.proposals.models import ProposalStatus
        from apps.proposals.tests.factories import ProposalFactory

        org = OrganizationFactory()
        FormulationFactory(organization=org, name="Idle")
        busy = FormulationFactory(organization=org, name="Busy")
        accepted = FormulationFactory(organization=org, name="Accepted")
        rejected = FormulationFactory(organization=org, name="Rejected")
        for f, status_value in (
            (busy, ProposalStatus.IN_REVIEW.value),
            (accepted, ProposalStatus.ACCEPTED.value),
            (rejected, ProposalStatus.REJECTED.value),
        ):
            version = save_version(formulation=f, actor=org.created_by)
            ProposalFactory(
                organization=org,
                formulation_version=version,
                status=status_value,
            )

        names = {
            f.name
            for f in list_formulations(
                organization=org, has_open_proposal=True
            )
        }
        assert names == {"Busy", "Accepted"}
        assert "Rejected" not in names
        assert "Idle" not in names

    def test_status_filter_keeps_listed_states(self) -> None:
        # Multi-select chip behaviour: passing two statuses returns
        # rows in either bucket; the union, not intersection.
        org = OrganizationFactory()
        FormulationFactory(
            organization=org, name="In dev", project_status="in_development"
        )
        FormulationFactory(
            organization=org, name="Concept", project_status="concept"
        )
        FormulationFactory(
            organization=org, name="Done", project_status="approved"
        )

        names = {
            f.name
            for f in list_formulations(
                organization=org,
                statuses=["concept", "in_development"],
            )
        }
        assert names == {"Concept", "In dev"}

    def test_empty_status_list_is_ignored(self) -> None:
        # The frontend strips empty filters before sending, but a
        # stale URL with ``?status=`` would otherwise produce an
        # empty IN clause and hide everything. Treat falsy lists
        # as "no filter" to keep the URL forgiving.
        org = OrganizationFactory()
        FormulationFactory(organization=org, name="A")
        FormulationFactory(organization=org, name="B")

        names = {
            f.name
            for f in list_formulations(organization=org, statuses=[])
        }
        assert names == {"A", "B"}

    def test_sales_person_filter_matches_assignment(self) -> None:
        # Sales person dropdown filters to one assignee. The
        # special ``"unassigned"`` token returns rows with no
        # sales person — a discoverable way to surface the bucket
        # in the UI without a magic null value.
        from apps.accounts.tests.factories import UserFactory

        org = OrganizationFactory()
        alice = UserFactory(email="alice@vita.test")
        bob = UserFactory(email="bob@vita.test")
        FormulationFactory(organization=org, name="Alice 1", sales_person=alice)
        FormulationFactory(organization=org, name="Alice 2", sales_person=alice)
        FormulationFactory(organization=org, name="Bob", sales_person=bob)
        FormulationFactory(organization=org, name="None", sales_person=None)

        alice_names = {
            f.name
            for f in list_formulations(
                organization=org, sales_person_id=alice.id
            )
        }
        assert alice_names == {"Alice 1", "Alice 2"}

        unassigned = {
            f.name
            for f in list_formulations(
                organization=org, sales_person_id="unassigned"
            )
        }
        assert unassigned == {"None"}

    def test_project_type_filter(self) -> None:
        org = OrganizationFactory()
        FormulationFactory(
            organization=org, name="Custom A", project_type="custom"
        )
        FormulationFactory(
            organization=org, name="Custom B", project_type="custom"
        )
        FormulationFactory(
            organization=org,
            name="Ready",
            project_type="ready_to_go",
        )

        names = {
            f.name
            for f in list_formulations(
                organization=org, project_type="custom"
            )
        }
        assert names == {"Custom A", "Custom B"}

    def test_filters_compose(self) -> None:
        # The four filters layer multiplicatively — narrowing by
        # status AND project_type AND sales person AND search must
        # all match. Sanity-check that no filter accidentally
        # short-circuits when another is in play.
        from apps.accounts.tests.factories import UserFactory

        org = OrganizationFactory()
        alice = UserFactory(email="combo@vita.test")
        match = FormulationFactory(
            organization=org,
            name="Burner Plus",
            code="MA-700",
            project_status="in_development",
            project_type="custom",
            sales_person=alice,
        )
        # Same sales person but wrong status:
        FormulationFactory(
            organization=org,
            name="Burner Lite",
            project_status="approved",
            project_type="custom",
            sales_person=alice,
        )
        # Wrong sales person:
        FormulationFactory(
            organization=org,
            name="Burner Pro",
            project_status="in_development",
            project_type="custom",
            sales_person=None,
        )

        names = {
            f.name
            for f in list_formulations(
                organization=org,
                search="burner",
                statuses=["in_development"],
                sales_person_id=alice.id,
                project_type="custom",
            )
        }
        assert names == {match.name}


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

    def test_project_type_editable_before_any_signature(self) -> None:
        """No customer signature anywhere on the project → the
        engagement model is still a free-text field. Sales flips
        between custom and ready-to-go while the deal is negotiated.
        """
        from apps.formulations.models import ProjectType

        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        assert formulation.project_type == ProjectType.CUSTOM.value

        update_formulation(
            formulation=formulation,
            actor=org.created_by,
            project_type=ProjectType.READY_TO_GO.value,
        )
        formulation.refresh_from_db()
        assert formulation.project_type == ProjectType.READY_TO_GO.value

    def test_project_type_locked_after_signed_spec(self) -> None:
        """The moment the customer signs anything the engagement
        model freezes. Switching mid-flight would either orphan
        signed documents or resurrect stages the customer thought
        were done — see :class:`ProjectTypeLocked`.
        """
        from apps.formulations.models import ProjectType
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )
        from django.utils import timezone

        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        sheet = SpecificationSheetFactory(
            organization=org,
            status="sent",
            document_kind="draft",
        )
        # Point the sheet's version at our formulation, then stamp
        # the customer signature column so the guard reads it as
        # "signed".
        sheet.formulation_version.formulation = formulation
        sheet.formulation_version.save(update_fields=["formulation"])
        sheet.customer_signed_at = timezone.now()
        sheet.save(update_fields=["customer_signed_at"])

        with pytest.raises(ProjectTypeLocked):
            update_formulation(
                formulation=formulation,
                actor=org.created_by,
                project_type=ProjectType.READY_TO_GO.value,
            )

    def test_project_type_noop_ignored_even_when_signed(self) -> None:
        """Echoing the current value passes through — bulk-update
        payloads often re-send every field, and rejecting a no-op
        would 422 those callers for no reason.
        """
        from apps.formulations.models import ProjectType
        from apps.specifications.tests.factories import (
            SpecificationSheetFactory,
        )
        from django.utils import timezone

        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        sheet = SpecificationSheetFactory(
            organization=org,
            status="sent",
            document_kind="draft",
        )
        sheet.formulation_version.formulation = formulation
        sheet.formulation_version.save(update_fields=["formulation"])
        sheet.customer_signed_at = timezone.now()
        sheet.save(update_fields=["customer_signed_at"])

        # Same value as current — must not raise.
        update_formulation(
            formulation=formulation,
            actor=org.created_by,
            project_type=formulation.project_type,
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


class TestCloneFormulation:
    """End-to-end coverage of the duplicate-formulation flow.

    The clone service is the only entry point for the builder's
    'Duplicate' button — it has two modes (new project / replace
    existing) and the replace mode auto-snapshots the target before
    overwriting. These tests cover the happy paths plus the cross-
    tenant / self-target / mode-validation guardrails so a malicious
    or buggy client cannot end up with a half-cloned project.
    """

    def _seed_recipe_source(self, org):
        catalogue = raw_materials_catalogue(org)
        active_one = ItemFactory(
            catalogue=catalogue,
            name='Caffeine Anhydrous',
            attributes={
                'use_as': 'Active',
                'purity': '0.99',
                'ingredient_list_name': 'Caffeine',
            },
        )
        active_two = ItemFactory(
            catalogue=catalogue,
            name='L-Theanine',
            attributes={
                'use_as': 'Active',
                'purity': '0.99',
                'ingredient_list_name': 'L-Theanine',
            },
        )
        carrier = ItemFactory(
            catalogue=catalogue,
            name='MCC PH-101',
            attributes={
                'use_as': 'Bulking Agent',
                'ingredient_list_name': 'Microcrystalline Cellulose',
            },
        )
        source = FormulationFactory(
            organization=org,
            name='Source Project',
            code='SRC-1',
            dosage_form='capsule',
            capsule_size='double_00',
            servings_per_pack=90,
            serving_size=2,
            directions_of_use='Take 2 with breakfast.',
            suggested_dosage='2 per day',
        )
        replace_lines(
            formulation=source,
            actor=org.created_by,
            lines=[
                {'item_id': str(active_one.id), 'label_claim_mg': '200'},
                {'item_id': str(active_two.id), 'label_claim_mg': '100'},
            ],
        )
        update_formulation(
            formulation=source,
            actor=org.created_by,
            mcc_carrier_item_ids=[str(carrier.id)],
        )
        source.refresh_from_db()
        return source, [active_one, active_two], carrier

    def test_new_creates_separate_formulation(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        cloned = clone_formulation(
            source=source,
            actor=org.created_by,
            mode='new',
            new_code='COPY-1',
            new_name='Copy of source',
        )

        assert cloned.pk != source.pk
        assert cloned.code == 'COPY-1'
        assert cloned.name == 'Copy of source'
        assert cloned.organization_id == org.id

    def test_new_copies_recipe_metadata(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        cloned = clone_formulation(
            source=source,
            actor=org.created_by,
            mode='new',
            new_code='COPY-META',
            new_name='Copy meta',
        )

        assert cloned.dosage_form == source.dosage_form
        assert cloned.capsule_size == source.capsule_size
        assert cloned.servings_per_pack == source.servings_per_pack
        assert cloned.serving_size == source.serving_size
        assert cloned.directions_of_use == source.directions_of_use
        assert cloned.suggested_dosage == source.suggested_dosage

    def test_new_copies_lines_in_display_order(self) -> None:
        org = OrganizationFactory()
        source, actives, _ = self._seed_recipe_source(org)

        cloned = clone_formulation(
            source=source,
            actor=org.created_by,
            mode='new',
            new_code='COPY-LINES',
            new_name='Copy lines',
        )

        cloned_lines = list(cloned.lines.order_by('display_order'))
        assert [line.item_id for line in cloned_lines] == [
            actives[0].id,
            actives[1].id,
        ]
        assert [str(line.label_claim_mg) for line in cloned_lines] == [
            '200.0000',
            '100.0000',
        ]

    def test_new_copies_m2m_picks(self) -> None:
        org = OrganizationFactory()
        source, _, carrier = self._seed_recipe_source(org)

        cloned = clone_formulation(
            source=source,
            actor=org.created_by,
            mode='new',
            new_code='COPY-M2M',
            new_name='Copy m2m',
        )

        assert list(cloned.mcc_carrier_items.all()) == [carrier]

    def test_new_does_not_carry_project_identity(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)
        # Save a version + mark approved so we can prove they don't
        # bleed into the clone.
        version = save_version(formulation=source, actor=org.created_by)
        source.approved_version_number = version.version_number
        source.save(update_fields=['approved_version_number'])

        cloned = clone_formulation(
            source=source,
            actor=org.created_by,
            mode='new',
            new_code='COPY-ID',
            new_name='Copy id',
        )

        assert cloned.versions.count() == 0
        assert cloned.approved_version_number is None
        assert cloned.sales_person_id is None

    def test_new_rejects_duplicate_code(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        with pytest.raises(FormulationCodeConflict):
            clone_formulation(
                source=source,
                actor=org.created_by,
                mode='new',
                new_code=source.code,
                new_name='Dup',
            )

    def test_new_rejects_blank_code(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        with pytest.raises(FormulationCodeRequired):
            clone_formulation(
                source=source,
                actor=org.created_by,
                mode='new',
                new_code='',
                new_name='No code',
            )

    def test_replace_overwrites_target_recipe(self) -> None:
        org = OrganizationFactory()
        source, actives, _ = self._seed_recipe_source(org)
        target = FormulationFactory(
            organization=org,
            name='Target Project',
            code='TGT-1',
            dosage_form='powder',
        )

        result = clone_formulation(
            source=source,
            actor=org.created_by,
            mode='replace',
            target_formulation=target,
        )

        assert result.pk == target.pk
        result.refresh_from_db()
        assert result.dosage_form == source.dosage_form
        assert result.capsule_size == source.capsule_size
        result_lines = list(result.lines.order_by('display_order'))
        assert [line.item_id for line in result_lines] == [
            actives[0].id,
            actives[1].id,
        ]

    def test_replace_preserves_target_identity(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)
        target = FormulationFactory(
            organization=org,
            name='Target Project',
            code='TGT-2',
            dosage_form='powder',
        )

        clone_formulation(
            source=source,
            actor=org.created_by,
            mode='replace',
            target_formulation=target,
        )

        target.refresh_from_db()
        assert target.code == 'TGT-2'
        assert target.name == 'Target Project'

    def test_replace_auto_snapshots_target_before_overwrite(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)
        target = FormulationFactory(
            organization=org,
            name='Target Project',
            code='TGT-3',
            dosage_form='powder',
        )

        clone_formulation(
            source=source,
            actor=org.created_by,
            mode='replace',
            target_formulation=target,
        )

        target.refresh_from_db()
        versions = list(target.versions.order_by('version_number'))
        assert len(versions) == 1
        # Snapshot captures the powder dosage form the target had
        # before the capsule recipe overwrote it.
        assert (
            versions[0].snapshot_metadata['dosage_form'] == 'powder'
        )

    def test_replace_rejects_cross_org_target(self) -> None:
        org_a = OrganizationFactory()
        org_b = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org_a)
        foreign_target = FormulationFactory(
            organization=org_b,
            name='Foreign',
            code='FGN-1',
            dosage_form='capsule',
        )

        with pytest.raises(CloneTargetNotFound):
            clone_formulation(
                source=source,
                actor=org_a.created_by,
                mode='replace',
                target_formulation=foreign_target,
            )

    def test_replace_rejects_self_target(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        with pytest.raises(CloneTargetIsSource):
            clone_formulation(
                source=source,
                actor=org.created_by,
                mode='replace',
                target_formulation=source,
            )

    def test_replace_requires_target(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        with pytest.raises(CloneTargetRequired):
            clone_formulation(
                source=source,
                actor=org.created_by,
                mode='replace',
                target_formulation=None,
            )

    def test_invalid_mode_raises(self) -> None:
        org = OrganizationFactory()
        source, _, _ = self._seed_recipe_source(org)

        with pytest.raises(InvalidCloneMode):
            clone_formulation(
                source=source,
                actor=org.created_by,
                mode='nope',
            )


class TestProjectStatusAutoAdvance:
    """Auto-advance rules for the project roadmap chip.

    Forward-only: every test pinpoints one trigger and verifies that
    the status only moves when the rule says it should — never
    backwards, never to ``discontinued``, never from ``discontinued``.
    """

    def _seed_item(self, org):
        return ItemFactory(
            catalogue=raw_materials_catalogue(org),
            attributes={"purity": 1.0, "type": "Vitamin"},
        )

    def test_first_line_advances_concept_to_in_development(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        item = self._seed_item(org)
        assert formulation.project_status == ProjectStatus.CONCEPT.value

        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
        )

        formulation.refresh_from_db()
        assert (
            formulation.project_status == ProjectStatus.IN_DEVELOPMENT.value
        )

    def test_replace_lines_with_empty_list_does_not_advance(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)

        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[],
        )

        formulation.refresh_from_db()
        assert formulation.project_status == ProjectStatus.CONCEPT.value

    def test_replace_lines_never_demotes_from_higher_status(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org,
            project_status=ProjectStatus.PILOT.value,
        )
        item = self._seed_item(org)

        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
        )

        formulation.refresh_from_db()
        # Already past in_development → forward-only rule keeps pilot.
        assert formulation.project_status == ProjectStatus.PILOT.value

    def test_set_approved_version_does_not_advance_project_status(self) -> None:
        """``set_approved_version`` is now a pure pointer write — the
        project roadmap chip is driven exclusively by customer-side
        spec-sheet signatures, so this call must leave the chip
        alone even when a fresh approved version is wired."""
        org = OrganizationFactory()
        formulation = FormulationFactory(organization=org)
        version = save_version(formulation=formulation, actor=org.created_by)

        set_approved_version(
            formulation=formulation,
            actor=org.created_by,
            version_number=version.version_number,
        )

        formulation.refresh_from_db()
        assert formulation.project_status == ProjectStatus.CONCEPT.value
        assert (
            formulation.approved_version_number == version.version_number
        )

    def test_discontinued_is_never_auto_advanced_by_line_edits(self) -> None:
        org = OrganizationFactory()
        formulation = FormulationFactory(
            organization=org,
            project_status=ProjectStatus.DISCONTINUED.value,
        )
        item = self._seed_item(org)

        replace_lines(
            formulation=formulation,
            actor=org.created_by,
            lines=[{"item_id": str(item.id), "label_claim_mg": "100"}],
        )

        formulation.refresh_from_db()
        # Restarting a discontinued project is an explicit operator
        # decision — line edits alone don't resurrect it.
        assert (
            formulation.project_status == ProjectStatus.DISCONTINUED.value
        )

