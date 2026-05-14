"""Tests for the spec-sheet pricing service.

Three invariants matter most:

1. Pricing math mirrors the proposal modal — same
   ``cost / (1 - margin/100)`` derivation, no drift.
2. Pricing freezes once the sheet hits ``approved`` or later.
   Editing a signed price would orphan the director's signature.
3. ``allow_locked=True`` is the only escape hatch — used by the
   director-approval flow so the price can be touched up at the
   moment of signing, in the same transaction.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from apps.organizations.tests.factories import OrganizationFactory
from apps.specifications.models import SpecificationStatus
from apps.specifications.services import (
    SpecificationPricingLocked,
    set_spec_pricing,
    update_sheet,
)
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


class TestSetSpecPricing:
    def test_cost_plus_margin_derives_unit_price(self) -> None:
        # Same formula the proposal modal uses: £5 cost at 30% margin
        # → £7.1429 per-unit price. Pin to four decimal places so
        # rounding drift can't sneak in.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)

        updated = set_spec_pricing(
            sheet=sheet,
            actor=org.created_by,
            unit_cost="5.00",
            margin_percent="30",
        )
        # Derived price = 5 / (1 - 0.3) = 7.142857… → quantised to
        # 4dp matching the model column.
        assert updated.unit_cost == Decimal("5.00")
        assert updated.margin_percent == Decimal("30")
        assert updated.final_price == Decimal("7.1429")

    def test_explicit_price_overrides_derivation(self) -> None:
        # When the team negotiates a custom rate, they pass
        # ``final_price`` directly — the cost+margin derivation
        # doesn't clobber it.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)

        updated = set_spec_pricing(
            sheet=sheet,
            actor=org.created_by,
            unit_cost="5.00",
            margin_percent="30",
            final_price="9.99",
        )
        assert updated.final_price == Decimal("9.9900")

    def test_quantity_clamped_to_minimum_one(self) -> None:
        # Quantity 0 / negative would break downstream math — coerce
        # to at least 1 so a malformed payload doesn't corrupt the
        # row. (Serializer also rejects this, defense in depth.)
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(organization=org)

        updated = set_spec_pricing(
            sheet=sheet, actor=org.created_by, quantity=0
        )
        assert updated.quantity == 1

    def test_lock_engages_on_approved_status(self) -> None:
        # Approved means a director signed the snapshot — including
        # the price. Edits after that point would orphan the
        # signature, so we refuse them at the service layer.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.APPROVED
        )
        with pytest.raises(SpecificationPricingLocked):
            set_spec_pricing(
                sheet=sheet,
                actor=org.created_by,
                final_price="100.00",
            )

    def test_allow_locked_bypasses_the_gate(self) -> None:
        # The director-approval transaction sets the price + the
        # signature in one shot; ``allow_locked=True`` is the only
        # supported way past the lock. Tests pin the escape hatch.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.APPROVED
        )
        updated = set_spec_pricing(
            sheet=sheet,
            actor=org.created_by,
            final_price="50.00",
            allow_locked=True,
        )
        assert updated.final_price == Decimal("50.0000")

    def test_update_sheet_also_blocks_pricing_on_approved(self) -> None:
        # The generic ``update_sheet`` PATCH path goes through the
        # broader edit lock now — any field on an approved sheet
        # surfaces ``SpecificationNotMutable``, not just pricing.
        # Editing any field after director sign-off would orphan
        # the captured signature.
        from apps.specifications.services import SpecificationNotMutable

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.APPROVED
        )
        with pytest.raises(SpecificationNotMutable):
            update_sheet(
                sheet=sheet,
                actor=org.created_by,
                final_price="200.00",
            )

    def test_any_patch_on_approved_blocked(self) -> None:
        # Non-pricing fields (cover notes, packaging strings) are
        # locked too — once a signature is captured, every field on
        # the snapshot is part of what was attested to.
        from apps.specifications.services import SpecificationNotMutable

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org, status=SpecificationStatus.APPROVED
        )
        with pytest.raises(SpecificationNotMutable):
            update_sheet(
                sheet=sheet,
                actor=org.created_by,
                cover_notes="Updated post-approval",
            )


class TestApprovalWithPricing:
    def test_pricing_applies_before_lock_engages(self) -> None:
        # End-to-end: a sheet sitting at ``in_review`` advances to
        # ``approved`` AND lands its first price in one transition
        # call. The pricing writes happen *before* the status flip
        # so the ``_PRICING_LOCKED_STATUSES`` gate doesn't reject
        # them. After the call the lock engages — a follow-up
        # pricing patch must fail.
        from apps.specifications.services import (
            SpecificationPricingLocked,
            transition_status,
        )

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org,
            status=SpecificationStatus.IN_REVIEW,
            unit_cost=None,
            margin_percent=None,
            final_price=None,
        )

        updated = transition_status(
            sheet=sheet,
            actor=org.created_by,
            next_status=SpecificationStatus.APPROVED,
            signature_image=(
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
                "CAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJ"
                "RU5ErkJggg=="
            ),
            pricing={
                "unit_cost": "5.00",
                "margin_percent": "30",
                "final_price": None,
                "quantity": None,
                "currency": None,
            },
        )
        assert updated.status == SpecificationStatus.APPROVED
        assert updated.unit_cost == Decimal("5.00")
        assert updated.margin_percent == Decimal("30")
        # Derived per the same formula the proposal modal uses.
        assert updated.final_price == Decimal("7.1429")

        # Lock now engaged — a follow-up pricing patch must fail.
        with pytest.raises(SpecificationPricingLocked):
            set_spec_pricing(
                sheet=updated,
                actor=org.created_by,
                final_price="999.99",
            )


class TestSpecEditLock:
    """Once the director signs (``approved`` and later) the snapshot
    is locked — every field becomes part of what was attested to, so
    edit-style services must refuse writes. ``in_review`` stays open
    so the director can tweak before signing."""

    @pytest.mark.parametrize(
        "locked_status",
        [
            SpecificationStatus.APPROVED,
            SpecificationStatus.SENT,
            SpecificationStatus.ACCEPTED,
            SpecificationStatus.REJECTED,
        ],
    )
    def test_update_sheet_blocked_on_locked_status(
        self, locked_status: str
    ) -> None:
        from apps.specifications.services import SpecificationNotMutable

        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org, status=locked_status
        )
        with pytest.raises(SpecificationNotMutable):
            update_sheet(
                sheet=sheet,
                actor=org.created_by,
                cover_notes="should not persist",
            )

    @pytest.mark.parametrize(
        "editable_status",
        [SpecificationStatus.DRAFT, SpecificationStatus.IN_REVIEW],
    )
    def test_pre_approval_states_remain_editable(
        self, editable_status: str
    ) -> None:
        # Both ``draft`` and ``in_review`` write through — the
        # director needs the in_review window to fine-tune before
        # signing. The prepared-by stamp at in_review tolerates
        # edits because it's an internal marker, not the legally
        # binding signature.
        org = OrganizationFactory()
        sheet = SpecificationSheetFactory(
            organization=org, status=editable_status
        )
        updated = update_sheet(
            sheet=sheet,
            actor=org.created_by,
            cover_notes="edit landed",
        )
        assert updated.cover_notes == "edit landed"
