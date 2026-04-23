"""Factory Boy factories for the proposals app."""

from __future__ import annotations

import factory

from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.proposals.models import Proposal


class ProposalFactory(factory.django.DjangoModelFactory):
    """Build a draft :class:`Proposal` pinned to a freshly-saved
    formulation version, owned by the formulation's creator.

    The template type defaults to ``custom`` because that's the
    document the sales team reaches for first; tests that care
    about Ready-to-Go-specific copy set it explicitly.
    """

    class Meta:
        model = Proposal
        skip_postgeneration_save = True

    organization = factory.SubFactory(OrganizationFactory)
    formulation_version = factory.LazyAttribute(
        lambda obj: _version_in_org(obj.organization)
    )
    code = factory.Sequence(lambda n: f"PROP-{n:04d}")
    template_type = "custom"
    status = "draft"
    currency = "GBP"
    quantity = 1
    created_by = factory.SelfAttribute("organization.created_by")
    updated_by = factory.SelfAttribute("organization.created_by")


def _version_in_org(organization):
    """Build a saved formulation + version inside ``organization``.

    Mirrors the spec-sheet factory's helper so proposal fixtures can
    pin against a snapshot without callers stitching the formulation
    lifecycle by hand.
    """

    from apps.formulations.services import save_version

    formulation = FormulationFactory(organization=organization)
    return save_version(
        formulation=formulation, actor=organization.created_by
    )
