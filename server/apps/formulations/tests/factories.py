"""Factory Boy factories for the formulations app."""

from __future__ import annotations

from decimal import Decimal

import factory

from apps.catalogues.tests.factories import (
    ItemFactory,
    raw_materials_catalogue,
)
from apps.formulations.constants import DosageForm
from apps.formulations.models import Formulation, FormulationLine
from apps.organizations.tests.factories import OrganizationFactory


class FormulationFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Formulation
        skip_postgeneration_save = True

    organization = factory.SubFactory(OrganizationFactory)
    name = factory.Sequence(lambda n: f"Formulation {n}")
    code = factory.Sequence(lambda n: f"FORM-{n:04d}")
    description = ""
    dosage_form = DosageForm.CAPSULE.value
    capsule_size = ""
    tablet_size = ""
    serving_size = 1
    servings_per_pack = 60
    directions_of_use = ""
    suggested_dosage = ""
    appearance = ""
    disintegration_spec = ""
    created_by = factory.SelfAttribute("organization.created_by")
    updated_by = factory.SelfAttribute("organization.created_by")


class FormulationLineFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = FormulationLine
        skip_postgeneration_save = True

    formulation = factory.SubFactory(FormulationFactory)
    item = factory.LazyAttribute(
        lambda obj: ItemFactory(
            catalogue=raw_materials_catalogue(obj.formulation.organization)
        )
    )
    display_order = 0
    label_claim_mg = factory.LazyFunction(lambda: Decimal("100.0000"))
    serving_size_override = None
    mg_per_serving_cached = None
    notes = ""
