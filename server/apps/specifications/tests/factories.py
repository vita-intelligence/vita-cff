"""Factory Boy factories for the specifications app."""

from __future__ import annotations

import factory

from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.tests.factories import OrganizationFactory
from apps.specifications.models import SpecificationSheet


class SpecificationSheetFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = SpecificationSheet
        skip_postgeneration_save = True

    organization = factory.SubFactory(OrganizationFactory)
    formulation_version = factory.LazyAttribute(
        lambda obj: _version_in_org(obj.organization)
    )
    code = factory.Sequence(lambda n: f"SPEC-{n:04d}")
    client_name = "Test Client"
    client_email = "client@example.test"
    client_company = "Test Co."
    cover_notes = ""
    status = "draft"
    created_by = factory.SelfAttribute("organization.created_by")
    updated_by = factory.SelfAttribute("organization.created_by")


def _version_in_org(organization):
    """Build a saved formulation + version inside ``organization``.

    Factories can't lazily reach into ``save_version`` without the
    organization in scope, so this helper composes the two steps in
    the right order.
    """

    from apps.formulations.services import save_version

    formulation = FormulationFactory(organization=organization)
    return save_version(formulation=formulation, actor=organization.created_by)
