"""Factory Boy factories for the attributes app."""

from __future__ import annotations

import factory

from apps.attributes.models import AttributeDefinition, DataType
from apps.catalogues.tests.factories import raw_materials_catalogue
from apps.organizations.tests.factories import OrganizationFactory


class AttributeDefinitionFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = AttributeDefinition
        skip_postgeneration_save = True

    catalogue = factory.LazyAttribute(
        lambda obj: raw_materials_catalogue(OrganizationFactory())
    )
    key = factory.Sequence(lambda n: f"attr_{n}")
    label = factory.Sequence(lambda n: f"Attribute {n}")
    data_type = DataType.TEXT
    required = False
    options: list = factory.LazyFunction(list)
    display_order = 0
    is_archived = False
    created_by = factory.SelfAttribute("catalogue.organization.created_by")
    updated_by = factory.SelfAttribute("catalogue.organization.created_by")
