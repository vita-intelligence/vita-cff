"""Render-path tests for the proposals template filler.

The scenarios here nail down contracts that broke in production
support threads — specifically the signatory-replacement at the
bottom of the letter. Scientists reported seeing the hard-coded
"Matthew Bowden" survive into the client-facing PDF even after the
project had an assigned sales person; these tests lock in the fix
so a future template tweak or refactor can't silently regress it.

The assertions run against the rendered .docx bytes (not the PDF)
because:

* ``render_docx_bytes`` is pure — it doesn't shell out to
  LibreOffice, so the tests don't need a system dependency that CI
  can't easily install.
* The text content in the .docx is an XML tree we can ``grep``
  directly; the PDF would add an additional LibreOffice conversion
  step that's slower and obscures the failure (PDF text search is
  not exact, especially with kerning).
"""

from __future__ import annotations

import io
import zipfile

import pytest

from apps.formulations.services import assign_sales_person
from apps.proposals.render import render_docx_bytes
from apps.proposals.tests.factories import ProposalFactory

pytestmark = pytest.mark.django_db


def _docx_body_text(docx_bytes: bytes) -> str:
    """Concatenate every ``w:t`` node in the rendered .docx into one
    plain string. Room for false positives if the template ever
    wraps placeholder text in a ``w:instrText`` instead, but that
    would be a template change worth re-evaluating anyway."""

    with zipfile.ZipFile(io.BytesIO(docx_bytes), "r") as zf:
        body = zf.read("word/document.xml").decode("utf-8")

    # Crude but sufficient — lxml stripping the tags would be
    # heavier and the test only needs "does this substring appear?".
    import re

    runs = re.findall(r"<w:t[^>]*>([^<]*)</w:t>", body)
    return "".join(runs)


class TestSignatoryReplacement:
    """The closing "Yours sincerely, …" block must show the project's
    assigned sales person, never the template's hard-coded default.
    Covers both the inherited (from the project) and override (set
    on the proposal itself) paths so multi-project proposals can
    still nominate a signatory without touching the project."""

    def test_unassigned_leaves_template_name_alone(self) -> None:
        """With no sales person anywhere, the renderer leaves the
        template's default name untouched so the output stays
        coherent — printing "Yours sincerely," above a blank line
        would look broken to a client."""

        proposal = ProposalFactory()
        body = _docx_body_text(render_docx_bytes(proposal))
        assert "Matthew Bowden" in body or "Mathew Bowden" in body

    def test_project_assignment_replaces_template_name(self) -> None:
        """Assigning the sales person on the project (not the
        proposal) still flows through — single-project proposals
        inherit the project's owner so scientists don't re-pick per
        quote."""

        proposal = ProposalFactory()
        formulation = proposal.formulation_version.formulation
        assign_sales_person(
            formulation=formulation,
            sales_person=proposal.organization.created_by,
            actor=proposal.organization.created_by,
        )
        expected = (
            proposal.organization.created_by.get_full_name()
            or proposal.organization.created_by.email
        ).strip()

        body = _docx_body_text(render_docx_bytes(proposal))

        assert expected in body
        assert "Matthew Bowden" not in body
        assert "Mathew Bowden" not in body

    def test_proposal_override_wins_over_project(self) -> None:
        """The proposal-level override takes precedence so a multi-
        project proposal (where the primary project's owner doesn't
        match the deal's owner) can nominate a different
        signatory."""

        from apps.accounts.tests.factories import UserFactory
        from apps.organizations.tests.factories import MembershipFactory

        proposal = ProposalFactory()
        formulation = proposal.formulation_version.formulation

        # Owner assigned on the project.
        assign_sales_person(
            formulation=formulation,
            sales_person=proposal.organization.created_by,
            actor=proposal.organization.created_by,
        )

        # Different user picks the proposal up as signatory.
        override = UserFactory(first_name="Alex", last_name="Nguyen")
        MembershipFactory(user=override, organization=proposal.organization)
        proposal.sales_person = override
        proposal.save(update_fields=["sales_person"])

        body = _docx_body_text(render_docx_bytes(proposal))

        assert "Alex Nguyen" in body
        assert "Matthew Bowden" not in body
        assert "Mathew Bowden" not in body
