"""Tests for the proposal-centric kiosk flow.

The flow is legally load-bearing: a client who signs a multi-product
deal must sign the commercial proposal AND every attached spec
sheet, and the whole set must advance to ``accepted`` atomically.
These tests lock in the guardrails:

* Partial signing captures the signature but leaves every document
  at ``sent`` — a refresh of the page shows the same state.
* Finalize fails loudly (``kiosk_signatures_pending``) until every
  document carries a signature.
* Attempting to sign a spec that isn't on the proposal is rejected
  (would otherwise let a crafted URL write a signature onto an
  unrelated sheet).
"""

from __future__ import annotations

import pytest

from apps.formulations.services import save_version
from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    KioskSignaturesPending,
    KioskSpecNotOnProposal,
    capture_customer_signature_on_attached_spec,
    capture_customer_signature_on_proposal,
    finalize_proposal_kiosk,
)
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.models import SpecificationStatus
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


#: 1×1 transparent PNG as a data URL — good enough to pass the
#: signature-image validator without shipping a real drawing.
_TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _sent_proposal_with_spec():
    """Build a proposal already at ``sent`` status with one attached
    spec sheet (also at ``sent``). Mirrors the state a kiosk visitor
    would actually encounter — approvals have happened server-side,
    the public link has been shared, and the client is about to sign.
    """

    proposal = ProposalFactory(status=ProposalStatus.SENT.value)
    # Attach a spec on a ProposalLine in the same org so the kiosk's
    # _attached_spec_sheets helper picks it up.
    sheet = SpecificationSheetFactory(
        organization=proposal.organization,
        status=SpecificationStatus.SENT,
    )
    line = proposal.lines.first()
    if line is None:
        # Older factories may not seed a line; build one minimally.
        version = save_version(
            formulation=proposal.formulation_version.formulation,
            actor=proposal.organization.created_by,
        )
        line = proposal.lines.create(
            formulation_version=version,
            specification_sheet=sheet,
            quantity=1,
        )
    else:
        line.specification_sheet = sheet
        line.save(update_fields=["specification_sheet"])
    return proposal, sheet


class TestProposalKioskSigning:
    def test_sign_proposal_captures_signature_without_advancing(self) -> None:
        proposal, _ = _sent_proposal_with_spec()

        updated = capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex Buyer",
            signer_email="alex@buyer.test",
            signer_company="Buyer Ltd",
            signature_image=_TINY_PNG,
        )

        assert updated.customer_signed_at is not None
        # Status must stay at sent — the signature alone is not the
        # acceptance, the finalize call is.
        assert updated.status == ProposalStatus.SENT.value

    def test_sign_attached_spec_captures_signature(self) -> None:
        proposal, sheet = _sent_proposal_with_spec()

        updated = capture_customer_signature_on_attached_spec(
            proposal=proposal,
            sheet_id=sheet.id,
            signer_name="Alex Buyer",
            signer_email="alex@buyer.test",
            signer_company="Buyer Ltd",
            signature_image=_TINY_PNG,
        )

        assert updated.customer_signed_at is not None
        assert updated.status == SpecificationStatus.SENT

    def test_sign_spec_not_on_proposal_is_rejected(self) -> None:
        proposal, _ = _sent_proposal_with_spec()
        # A sheet in the same org but not attached to this proposal
        # should not be signable via this proposal's kiosk.
        orphan = SpecificationSheetFactory(
            organization=proposal.organization,
            status=SpecificationStatus.SENT,
        )
        with pytest.raises(KioskSpecNotOnProposal):
            capture_customer_signature_on_attached_spec(
                proposal=proposal,
                sheet_id=orphan.id,
                signer_name="Alex",
                signer_email="alex@buyer.test",
                signer_company="Buyer",
                signature_image=_TINY_PNG,
            )


class TestProposalKioskFinalize:
    def test_finalize_blocks_when_proposal_unsigned(self) -> None:
        proposal, sheet = _sent_proposal_with_spec()
        # Sign the spec but not the proposal — finalize must refuse
        # and report the proposal as pending.
        capture_customer_signature_on_attached_spec(
            proposal=proposal,
            sheet_id=sheet.id,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
        )
        with pytest.raises(KioskSignaturesPending) as exc:
            finalize_proposal_kiosk(proposal=proposal)
        pending = exc.value.args[0]
        assert any(p.startswith("proposal:") for p in pending)

    def test_finalize_blocks_when_spec_unsigned(self) -> None:
        proposal, sheet = _sent_proposal_with_spec()
        capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
        )
        with pytest.raises(KioskSignaturesPending) as exc:
            finalize_proposal_kiosk(proposal=proposal)
        pending = exc.value.args[0]
        assert any(p.startswith("spec:") for p in pending)

    def test_finalize_advances_everything_when_all_signed(self) -> None:
        proposal, sheet = _sent_proposal_with_spec()
        capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
        )
        capture_customer_signature_on_attached_spec(
            proposal=proposal,
            sheet_id=sheet.id,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
        )

        result = finalize_proposal_kiosk(proposal=proposal)

        proposal.refresh_from_db()
        sheet.refresh_from_db()
        assert proposal.status == ProposalStatus.ACCEPTED.value
        assert sheet.status == SpecificationStatus.ACCEPTED
        assert result["already_finalized"] is False

    def test_finalize_is_idempotent_on_already_accepted(self) -> None:
        # Legal concern: a double-click on the finalize button after
        # a slow network round-trip must not explode. The second call
        # should report the proposal as already finalized and leave
        # everything untouched.
        proposal, sheet = _sent_proposal_with_spec()
        capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
        )
        capture_customer_signature_on_attached_spec(
            proposal=proposal,
            sheet_id=sheet.id,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
        )
        finalize_proposal_kiosk(proposal=proposal)
        proposal.refresh_from_db()

        result = finalize_proposal_kiosk(proposal=proposal)
        assert result["already_finalized"] is True
