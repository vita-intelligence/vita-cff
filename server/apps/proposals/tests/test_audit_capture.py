"""E-signature audit-trail tests.

ESIGN/UETA evidence captured at kiosk sign time: source IP, raw
``User-Agent`` header, and a SHA-256 of the rendered document. The
goal of these tests is to lock the audit trail end-to-end so a
refactor that silently drops one of the three signals fails CI
instead of fails court.
"""

from __future__ import annotations

import hashlib

import pytest

from apps.proposals.models import ProposalStatus
from apps.proposals.services import (
    capture_customer_signature_on_attached_spec,
    capture_customer_signature_on_proposal,
)
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.models import SpecificationStatus
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


_TINY_PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _sent_proposal_with_spec():
    """Build a sent proposal with one attached spec ready to sign."""
    from apps.formulations.services import save_version

    proposal = ProposalFactory(status=ProposalStatus.SENT.value)
    sheet = SpecificationSheetFactory(
        organization=proposal.organization,
        status=SpecificationStatus.SENT,
    )
    line = proposal.lines.first()
    if line is None:
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


class TestProposalAuditCapture:
    def test_sign_records_ip_user_agent_and_hash(self) -> None:
        proposal, _ = _sent_proposal_with_spec()
        ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15"
        ip = "203.0.113.42"
        doc_hash = hashlib.sha256(b"<html>contract body</html>").hexdigest()

        updated = capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex Buyer",
            signer_email="alex@buyer.test",
            signer_company="Buyer Ltd",
            signature_image=_TINY_PNG,
            ack_spec_signing=True,
            ack_lead_times=True,
            ack_terms=True,
            ack_rd_terms=True,
            sign_ip=ip,
            sign_user_agent=ua,
            sign_document_hash=doc_hash,
        )

        assert updated.customer_sign_ip == ip
        assert updated.customer_sign_user_agent == ua
        assert updated.customer_sign_document_hash == doc_hash
        assert len(updated.customer_sign_document_hash) == 64

    def test_sign_truncates_oversize_ip(self) -> None:
        # IPv6 is at most 39 chars; the column allows 45. A garbage
        # IP header longer than that must be truncated rather than
        # raising, so a malformed proxy header can't 500 the signer.
        proposal, _ = _sent_proposal_with_spec()
        oversize = "a" * 200

        updated = capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
            ack_spec_signing=True,
            ack_lead_times=True,
            ack_terms=True,
            ack_rd_terms=True,
            sign_ip=oversize,
            sign_user_agent="",
            sign_document_hash="",
        )
        assert len(updated.customer_sign_ip) <= 45

    def test_sign_attached_spec_records_audit(self) -> None:
        proposal, sheet = _sent_proposal_with_spec()
        ua = "curl/8.0.0"
        ip = "198.51.100.7"
        doc_hash = "f" * 64

        updated = capture_customer_signature_on_attached_spec(
            proposal=proposal,
            sheet_id=sheet.id,
            signer_name="Alex Buyer",
            signer_email="alex@buyer.test",
            signer_company="Buyer Ltd",
            signature_image=_TINY_PNG,
            sign_ip=ip,
            sign_user_agent=ua,
            sign_document_hash=doc_hash,
        )

        assert updated.customer_sign_ip == ip
        assert updated.customer_sign_user_agent == ua
        assert updated.customer_sign_document_hash == doc_hash

    def test_audit_defaults_to_empty_when_omitted(self) -> None:
        # Existing call sites that don't pass audit kwargs must keep
        # working — backwards compatibility for the test suite and any
        # script that hits the service directly. Audit columns land as
        # empty strings, signalling "no evidence captured" without
        # blowing up the request.
        proposal, _ = _sent_proposal_with_spec()

        updated = capture_customer_signature_on_proposal(
            proposal=proposal,
            signer_name="Alex",
            signer_email="alex@buyer.test",
            signer_company="Buyer",
            signature_image=_TINY_PNG,
            ack_spec_signing=True,
            ack_lead_times=True,
            ack_terms=True,
            ack_rd_terms=True,
        )

        assert updated.customer_sign_ip == ""
        assert updated.customer_sign_user_agent == ""
        assert updated.customer_sign_document_hash == ""
