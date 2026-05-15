"""Tests for the spec → proposal pricing auto-fill flow.

When sales picks a spec on a new proposal (or on a line within an
existing proposal), the spec's per-unit economics seed the proposal:

* Unit cost, unit price, and currency flow from the spec if the
  sales rep didn't type a value.
* Quantity is intentionally NOT inherited — it's a per-order figure
  the sales rep sets on the proposal. One spec can underpin
  proposals at very different volumes.
* Explicitly-typed values always win — sales can negotiate a
  custom rate without the spec overwriting it.

These tests pin the auto-fill so a future refactor of either side
(spec pricing service, proposal line CRUD) can't quietly break the
hand-off.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    add_proposal_line,
    create_proposal,
    update_proposal_line,
)
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.models import SpecificationStatus
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _priced_spec(org, *, formulation_version, **overrides):
    """Director-approved spec with pricing already on file."""
    defaults = {
        "organization": org,
        "formulation_version": formulation_version,
        "status": SpecificationStatus.APPROVED,
        "unit_cost": Decimal("5.00"),
        "margin_percent": Decimal("30"),
        "final_price": Decimal("7.1429"),
        "quantity": 100,
        "currency": "GBP",
    }
    defaults.update(overrides)
    return SpecificationSheetFactory(**defaults)


class TestAddProposalLineAutoFill:
    def test_line_inherits_pricing_from_spec(self) -> None:
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        spec = _priced_spec(
            org, formulation_version=proposal.formulation_version
        )

        line = add_proposal_line(
            proposal=proposal,
            actor=org.created_by,
            specification_sheet_id=spec.id,
        )
        assert line.unit_cost == Decimal("5.0000")
        assert line.unit_price == Decimal("7.1429")
        # Quantity is NOT inherited from the spec — order size is a
        # per-proposal concern, so the default "1" survives.
        assert line.quantity == 1

    def test_caller_provided_price_wins_over_spec(self) -> None:
        # When sales negotiates a custom rate they pass
        # ``unit_price`` explicitly; the spec's number doesn't
        # clobber it. Sales owns the line from that point onward.
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        spec = _priced_spec(
            org, formulation_version=proposal.formulation_version
        )

        line = add_proposal_line(
            proposal=proposal,
            actor=org.created_by,
            specification_sheet_id=spec.id,
            unit_price=Decimal("9.99"),
            quantity=5,
        )
        assert line.unit_price == Decimal("9.9900")
        assert line.quantity == 5

    def test_priceless_spec_leaves_line_blank(self) -> None:
        # Backwards-compat path: a spec carrying ``None`` for the
        # pricing trio (every spec that existed before this feature
        # shipped) doesn't poison the line with zeroes — it just
        # leaves the columns null so the sales rep fills them in.
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        spec = SpecificationSheetFactory(
            organization=org,
            formulation_version=proposal.formulation_version,
            status=SpecificationStatus.APPROVED,
            unit_cost=None,
            final_price=None,
        )

        line = add_proposal_line(
            proposal=proposal,
            actor=org.created_by,
            specification_sheet_id=spec.id,
        )
        assert line.unit_cost is None
        assert line.unit_price is None
        # Default quantity preserved.
        assert line.quantity == 1


class TestUpdateProposalLineAutoFill:
    def test_attaching_a_new_spec_seeds_empty_pricing(self) -> None:
        # Existing line with no pricing yet. Sales attaches a spec
        # in a PATCH; the spec's pricing flows in.
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        line = add_proposal_line(
            proposal=proposal, actor=org.created_by
        )
        assert line.unit_cost is None
        spec = _priced_spec(
            org, formulation_version=proposal.formulation_version
        )

        updated = update_proposal_line(
            proposal=proposal,
            line_id=line.id,
            actor=org.created_by,
            specification_sheet_id=spec.id,
        )
        assert updated.unit_cost == Decimal("5.0000")
        assert updated.unit_price == Decimal("7.1429")

    def test_attaching_a_spec_does_not_overwrite_existing_price(
        self,
    ) -> None:
        # When the line already has a deliberate positive price —
        # e.g. sales typed a custom rate for a negotiated deal —
        # switching the attached spec must NOT silently overwrite
        # that number. A positive ``line.unit_price`` is the
        # operator's stated intent and survives the spec swap.
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        line = add_proposal_line(
            proposal=proposal,
            actor=org.created_by,
            unit_price=Decimal("99.99"),
        )
        spec = _priced_spec(
            org, formulation_version=proposal.formulation_version
        )

        updated = update_proposal_line(
            proposal=proposal,
            line_id=line.id,
            actor=org.created_by,
            specification_sheet_id=spec.id,
        )
        assert updated.unit_price == Decimal("99.9900")

    def test_attaching_a_spec_fills_zero_price(self) -> None:
        # The mirror of the previous test. A line whose
        # ``unit_price`` is zero is treated as "unset" and the spec
        # swap fills it. The previous "None-only" guard left zero
        # in place forever, which made the line table's derived
        # margin column compute to nothing — the bug the operator
        # reported on the proposal-detail page (line had a typed
        # cost but no price; attaching a spec didn't seed the
        # price, so margin stayed empty).
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        line = add_proposal_line(
            proposal=proposal,
            actor=org.created_by,
            unit_cost=Decimal("15.00"),
            unit_price=Decimal("0"),
        )
        spec = _priced_spec(
            org, formulation_version=proposal.formulation_version
        )

        updated = update_proposal_line(
            proposal=proposal,
            line_id=line.id,
            actor=org.created_by,
            specification_sheet_id=spec.id,
        )
        # Cost was already a non-zero manual override; preserved.
        # Price was zero (effectively unset); filled from the spec.
        assert updated.unit_cost == Decimal("15.0000")
        assert updated.unit_price == Decimal("7.1429")

    def test_spec_attach_derives_price_from_cost_and_margin(
        self,
    ) -> None:
        # The legacy ``spec.final_price`` is the canonical wire
        # value, but historic specs (and specs typed via the
        # cost+margin path on the approval modal) may have
        # ``final_price=None`` while still carrying enough info to
        # produce a customer price. The ``_spec_unit_price`` helper
        # derives ``cost / (1 − margin/100)`` in that case so the
        # line picker doesn't silently drop the price during a spec
        # attach.
        org = OrganizationFactory()
        proposal = ProposalFactory(
            organization=org, status=ProposalStatus.DRAFT.value
        )
        line = add_proposal_line(
            proposal=proposal,
            actor=org.created_by,
        )
        spec = _priced_spec(
            org,
            formulation_version=proposal.formulation_version,
            unit_cost=Decimal("10.00"),
            margin_percent=Decimal("33.33"),
            final_price=None,
        )

        updated = update_proposal_line(
            proposal=proposal,
            line_id=line.id,
            actor=org.created_by,
            specification_sheet_id=spec.id,
        )
        # cost / (1 − 33.33/100) = 10 / 0.6667 ≈ 14.9993
        assert updated.unit_cost == Decimal("10.0000")
        assert updated.unit_price is not None
        assert abs(updated.unit_price - Decimal("14.9993")) < Decimal("0.01")


class TestCreateProposalAutoFill:
    def test_proposal_inherits_currency_from_spec(self) -> None:
        # The most subtle one: a EUR-priced spec must flip the
        # proposal's currency to EUR on create, so the rendered
        # proposal PDF doesn't show "€" alongside "£" totals.
        org = OrganizationFactory()
        from apps.formulations.services import save_version
        from apps.formulations.tests.factories import FormulationFactory

        formulation = FormulationFactory(organization=org)
        version = save_version(
            formulation=formulation, actor=org.created_by
        )
        formulation.approved_version_number = version.version_number
        formulation.save(update_fields=["approved_version_number"])
        spec = _priced_spec(
            org, formulation_version=version, currency="EUR"
        )

        proposal = create_proposal(
            organization=org,
            actor=org.created_by,
            formulation_version_id=version.id,
            specification_sheet_id=spec.id,
        )
        assert proposal.currency == "EUR"
        assert proposal.unit_price == Decimal("7.1429")
        # Quantity is NOT inherited — proposal defaults to 1 and
        # sales picks the real order size separately.
        assert proposal.quantity == 1
