"""Regression tests for the Ready-to-Go spec-sheet reuse rule.

The whole point of the RTG track is that one validated recipe (and
its spec sheet) ships to many customers, and the same customer can
re-order the same product under separate proposals at different
quantities. That is the *opposite* of Custom, where every bespoke
recipe belongs to a single deal and the spec follows one proposal.

The system carries the "one spec, one proposal" assumption in two
places:

1. ``Proposal.specification_sheet`` is a ``OneToOneField``. Setting
   it twice against the same sheet raises an ``IntegrityError``.
2. The proposal-line spec picker on the FE grays out any spec whose
   ``linked_proposal`` is not rejected, so sales cannot select it.

Both need to bend around RTG. This test module pins the backend
half. The FE gate lives in ``proposals-org-list.tsx`` and reads
``formulation_project_type`` off the spec payload — covered by the
serializer test below.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.formulations.models import ProjectType
from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.services import create_proposal
from apps.specifications.api.serializers import (
    SpecificationSheetListSerializer,
)
from apps.specifications.models import SpecificationStatus
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _rtg_setup(org):
    """Ready-to-Go formulation + version + approved spec sheet — the
    minimum shape ``create_proposal`` needs to run twice against the
    same spec."""

    formulation = FormulationFactory(
        organization=org, project_type=ProjectType.READY_TO_GO
    )
    version = save_version(formulation=formulation, actor=org.created_by)
    formulation.approved_version_number = version.version_number
    formulation.save(update_fields=["approved_version_number"])
    spec = SpecificationSheetFactory(
        organization=org,
        formulation_version=version,
        status=SpecificationStatus.APPROVED,
        unit_cost=Decimal("5.00"),
        margin_percent=Decimal("30"),
        final_price=Decimal("7.1429"),
        quantity=100,
        currency="GBP",
    )
    return formulation, version, spec


def _custom_setup(org):
    """Custom equivalent — same shape but ``project_type='custom'`` so
    the OneToOne slot must still bind the first proposal."""

    formulation = FormulationFactory(
        organization=org, project_type=ProjectType.CUSTOM
    )
    version = save_version(formulation=formulation, actor=org.created_by)
    formulation.approved_version_number = version.version_number
    formulation.save(update_fields=["approved_version_number"])
    spec = SpecificationSheetFactory(
        organization=org,
        formulation_version=version,
        status=SpecificationStatus.APPROVED,
        unit_cost=Decimal("5.00"),
        margin_percent=Decimal("30"),
        final_price=Decimal("7.1429"),
        quantity=100,
        currency="GBP",
    )
    return formulation, version, spec


class TestRTGSpecCanBeReusedAcrossProposals:
    def test_two_proposals_can_share_the_same_rtg_spec(self):
        """The RTG track sells the same recipe to many customers. A
        second proposal against an already-quoted RTG spec must not
        collide on the ``Proposal.specification_sheet`` OneToOne."""

        org = OrganizationFactory()
        _, version, spec = _rtg_setup(org)

        first = create_proposal(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            specification_sheet_id=spec.id,
            customer_name="Buyer One",
            customer_email="one@buyer.test",
            quantity=100,
        )
        second = create_proposal(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            specification_sheet_id=spec.id,
            customer_name="Buyer Two",
            customer_email="two@buyer.test",
            quantity=500,
        )
        # Both proposals exist and both carry the spec via the
        # line-level FK — the discovery path used by
        # ``resolve_linked_proposal`` and ``_attached_spec_sheets``.
        first_line_specs = {
            line.specification_sheet_id for line in first.lines.all()
        }
        second_line_specs = {
            line.specification_sheet_id for line in second.lines.all()
        }
        assert spec.id in first_line_specs
        assert spec.id in second_line_specs
        # The legacy OneToOne slot stays NULL on RTG proposals — that
        # is precisely how the second create avoids the UNIQUE-
        # constraint collision.
        assert first.specification_sheet_id is None
        assert second.specification_sheet_id is None

    def test_same_customer_can_reorder_the_same_rtg_spec(self):
        """Same buyer, different quantity on a fresh proposal —
        the "same client with different quantities of same RTG" case
        the user flagged. Must not raise."""

        org = OrganizationFactory()
        _, version, spec = _rtg_setup(org)

        first = create_proposal(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            specification_sheet_id=spec.id,
            customer_name="Repeat Buyer",
            customer_email="repeat@buyer.test",
            quantity=100,
        )
        second = create_proposal(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            specification_sheet_id=spec.id,
            customer_name="Repeat Buyer",
            customer_email="repeat@buyer.test",
            quantity=500,
        )
        assert first.id != second.id
        assert first.customer_email == second.customer_email
        assert first.quantity != second.quantity


class TestCustomSpecStillLocksToOneProposal:
    def test_custom_spec_pins_the_legacy_onetoone_slot(self):
        """Regression guard on the Custom side. A bespoke recipe still
        pins ``Proposal.specification_sheet`` so downstream code that
        reads the OneToOne slot (kiosk render, email attachment)
        keeps working exactly as before for Custom projects."""

        org = OrganizationFactory()
        _, version, spec = _custom_setup(org)

        proposal = create_proposal(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            specification_sheet_id=spec.id,
            customer_name="Custom Buyer",
            customer_email="custom@buyer.test",
            quantity=100,
        )
        assert proposal.specification_sheet_id == spec.id


class TestSerializerExposesProjectType:
    def test_ready_to_go_flag_is_on_the_spec_payload(self):
        """The FE picker gates ``isBusy`` off the spec's
        ``formulation_project_type``. Without this field the gate has
        to fall back to the linked_proposal check, which would gray
        out every reused RTG spec — the bug the user flagged."""

        org = OrganizationFactory()
        _, _, spec = _rtg_setup(org)

        data = SpecificationSheetListSerializer(spec).data
        assert data["formulation_project_type"] == "ready_to_go"

    def test_custom_project_type_flows_through(self):
        org = OrganizationFactory()
        _, _, spec = _custom_setup(org)

        data = SpecificationSheetListSerializer(spec).data
        assert data["formulation_project_type"] == "custom"
