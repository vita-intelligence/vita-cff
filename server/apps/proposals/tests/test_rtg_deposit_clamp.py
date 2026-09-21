"""RTG proposals are commercially always-100%: no trial-batch cycle,
no FINAL-spec sign, so the FINAL-invoice path never fires. A 50%
deposit (the model default aimed at Custom quotes) would leave the
second half of the money stranded.

Every write path is expected to set 100 explicitly, but a
model-level clamp on ``Proposal.save()`` is the safety net that
catches any future path we forget — admin-panel edit, PATCH from
the general update endpoint, data-migration script, test fixture.

These tests pin the clamp behaviour so a future refactor can't
silently regress it.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import uuid4

import pytest

from apps.accounts.tests.factories import UserFactory
from apps.formulations.models import FormulationVersion
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.proposals.models import Proposal, ProposalStatus, ProposalTemplateType

pytestmark = pytest.mark.django_db


def _seed_version(org, owner):
    formulation = FormulationFactory(organization=org)
    return FormulationVersion.objects.create(
        formulation=formulation,
        version_number=1,
        created_by=owner,
    )


class TestRtgDepositClamp:
    def test_rtg_forced_to_100_even_when_caller_passes_50(self):
        owner = UserFactory()
        org = create_organization(user=owner, name="Clamp Co")
        version = _seed_version(org, owner)

        proposal = Proposal.objects.create(
            organization=org,
            formulation_version=version,
            code=f"PROP-{uuid4().hex[:6]}",
            template_type=ProposalTemplateType.READY_TO_GO,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=1,
            # 50 is the model default and the bug shape — caller
            # writes the wrong value, clamp corrects it before save.
            deposit_percent=Decimal("50"),
            created_by=owner,
            updated_by=owner,
        )
        proposal.refresh_from_db()
        assert proposal.deposit_percent == Decimal("100")

    def test_rtg_default_construction_clamps_to_100(self):
        # Even without passing deposit_percent explicitly (default 50
        # kicks in), the clamp normalises to 100 for RTG.
        owner = UserFactory()
        org = create_organization(user=owner, name="Default Co")
        version = _seed_version(org, owner)

        proposal = Proposal.objects.create(
            organization=org,
            formulation_version=version,
            code=f"PROP-{uuid4().hex[:6]}",
            template_type=ProposalTemplateType.READY_TO_GO,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=1,
            created_by=owner,
            updated_by=owner,
        )
        proposal.refresh_from_db()
        assert proposal.deposit_percent == Decimal("100")

    def test_custom_deposit_untouched(self):
        # Custom quotes have a legit 30-50-70% deposit clause. Clamp
        # must not fire outside RTG.
        owner = UserFactory()
        org = create_organization(user=owner, name="Custom Co")
        version = _seed_version(org, owner)

        proposal = Proposal.objects.create(
            organization=org,
            formulation_version=version,
            code=f"PROP-{uuid4().hex[:6]}",
            template_type=ProposalTemplateType.CUSTOM,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=1,
            deposit_percent=Decimal("30"),
            created_by=owner,
            updated_by=owner,
        )
        proposal.refresh_from_db()
        assert proposal.deposit_percent == Decimal("30")

    def test_flipping_custom_to_rtg_re_clamps(self):
        # Edge case: a Custom proposal with deposit_percent=40 has
        # its template_type flipped to RTG (unusual but the general
        # update path allows it). The next save must clamp so the
        # RTG invariant stays true.
        owner = UserFactory()
        org = create_organization(user=owner, name="Flip Co")
        version = _seed_version(org, owner)

        proposal = Proposal.objects.create(
            organization=org,
            formulation_version=version,
            code=f"PROP-{uuid4().hex[:6]}",
            template_type=ProposalTemplateType.CUSTOM,
            status=ProposalStatus.DRAFT.value,
            currency="GBP",
            quantity=1,
            deposit_percent=Decimal("40"),
            created_by=owner,
            updated_by=owner,
        )
        assert proposal.deposit_percent == Decimal("40")

        proposal.template_type = ProposalTemplateType.READY_TO_GO
        proposal.save()
        proposal.refresh_from_db()
        assert proposal.deposit_percent == Decimal("100")
