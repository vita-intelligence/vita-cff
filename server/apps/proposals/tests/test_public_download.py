"""Public PDF-download endpoint smoke tests.

WeasyPrint is exercised by the spec-sheet test suite already, so
these tests focus on the proposal-side wiring: route is registered,
returns ``application/pdf`` with an ``attachment`` disposition, and
404s when the token is unknown or the public link is disabled.

WeasyPrint relies on cairo/pango shared libraries, which aren't on
every developer's machine. The tests skip cleanly if the import
fails — same pattern other PDF tests in the repo use.
"""

from __future__ import annotations

import uuid

import pytest
from rest_framework.test import APIClient

from apps.proposals.models import ProposalStatus
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


@pytest.fixture
def api_client() -> APIClient:
    return APIClient()


@pytest.fixture
def weasyprint_available() -> bool:
    try:
        import weasyprint  # noqa: F401
    except Exception:  # pragma: no cover - env-specific
        return False
    return True


class TestPublicProposalDownload:
    def test_returns_pdf_when_token_valid(
        self, api_client: APIClient, weasyprint_available: bool
    ) -> None:
        if not weasyprint_available:
            pytest.skip("WeasyPrint not installed in this environment")
        proposal = ProposalFactory(status=ProposalStatus.SENT.value)
        proposal.public_token = uuid.uuid4()
        proposal.save(update_fields=["public_token"])

        url = f"/api/public/proposals/{proposal.public_token}/download/"
        response = api_client.get(url)

        assert response.status_code == 200
        assert response["Content-Type"] == "application/pdf"
        # Browser must save instead of inline-render.
        assert "attachment" in response["Content-Disposition"]
        # PDF magic number — ``%PDF-`` is the literal first 5 bytes of
        # every PDF file. Anything else means WeasyPrint emitted
        # something other than a PDF, which is the failure mode to
        # catch.
        assert response.content[:5] == b"%PDF-"

    def test_404_on_unknown_token(self, api_client: APIClient) -> None:
        # Random UUID with no proposal behind it — preview and
        # download share the same 404 surface, so a probe can't
        # enumerate which tokens exist.
        url = f"/api/public/proposals/{uuid.uuid4()}/download/"
        response = api_client.get(url)
        assert response.status_code == 404

    def test_404_when_public_token_not_set(
        self, api_client: APIClient
    ) -> None:
        # A proposal without ``public_token`` set must not be
        # downloadable via any UUID — the public link gate covers
        # both "never enabled" and "revoked" cases.
        proposal = ProposalFactory(status=ProposalStatus.SENT.value)
        # Public token defaults to NULL on a fresh factory.
        assert proposal.public_token is None
        url = f"/api/public/proposals/{uuid.uuid4()}/download/"
        response = api_client.get(url)
        assert response.status_code == 404
