"""Signal handlers for the catalogues app.

Every organization receives a fixed set of *system* catalogues on
creation. Their slugs (``raw_materials``, ``packaging``) are referenced
from downstream business logic (formulation engine, specification
sheets) so they must exist before those features run.

We hook the seeding into ``post_save`` on :class:`Organization` rather
than into the organization service so the guarantee holds regardless
of how the org is created (admin, fixtures, factories, management
commands).
"""

from __future__ import annotations

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.attributes.models import AttributeDefinition, DataType
from apps.catalogues.models import (
    PACKAGING_SLUG,
    RAW_MATERIALS_SLUG,
    Catalogue,
)
from apps.formulations.constants import (
    POWDER_WATER_DOSE_ATTRIBUTE_KEY,
    POWDER_WATER_DOSE_ATTRIBUTE_LABEL,
)
from apps.organizations.models import Organization


SYSTEM_CATALOGUE_SPEC: tuple[tuple[str, str, str], ...] = (
    (
        RAW_MATERIALS_SLUG,
        "Raw Materials",
        "Active ingredients, excipients, and other formulation inputs.",
    ),
    (
        PACKAGING_SLUG,
        "Packaging",
        "Bottles, lids, labels, tubs, pouches, and other pack components.",
    ),
)


#: AttributeDefinition rows the raw_materials catalogue is guaranteed to
#: carry. Each tuple is ``(key, label, data_type, required)``. Keys are
#: load-bearing for the formulation engine (the powder acidity math
#: reads ``powder_water_dose_mg_per_ml`` directly from
#: ``Item.attributes``), so seeding them on org creation keeps the
#: math contract honest across every new tenant. Existing orgs are
#: covered by the parallel data migration.
RAW_MATERIALS_SYSTEM_ATTRIBUTES: tuple[tuple[str, str, str, bool], ...] = (
    (
        POWDER_WATER_DOSE_ATTRIBUTE_KEY,
        POWDER_WATER_DOSE_ATTRIBUTE_LABEL,
        DataType.NUMBER,
        False,
    ),
)


@receiver(post_save, sender=Organization)
def seed_system_catalogues(
    sender, instance: Organization, created: bool, **kwargs
) -> None:
    """Create the system catalogues on first save of an organization.

    Idempotent: if the catalogue already exists (re-running a fixture,
    for instance) we skip it instead of raising. Non-system custom
    catalogues added by owners are never touched.

    After the catalogues are in place we also seed the
    :data:`RAW_MATERIALS_SYSTEM_ATTRIBUTES` so the formulation engine
    can read load-bearing keys (powder water dose, etc.) off every
    new raw material the moment the catalogue is populated. Attribute
    seeding is idempotent — re-running the signal never duplicates
    rows or overrides a label the scientist has already customised.
    """

    if not created:
        return

    raw_materials_catalogue: Catalogue | None = None
    for slug, name, description in SYSTEM_CATALOGUE_SPEC:
        catalogue, _ = Catalogue.objects.get_or_create(
            organization=instance,
            slug=slug,
            defaults={
                "name": name,
                "description": description,
                "is_system": True,
            },
        )
        if slug == RAW_MATERIALS_SLUG:
            raw_materials_catalogue = catalogue

    if raw_materials_catalogue is None:
        return

    actor = instance.created_by
    for key, label, data_type, required in RAW_MATERIALS_SYSTEM_ATTRIBUTES:
        AttributeDefinition.objects.get_or_create(
            catalogue=raw_materials_catalogue,
            key=key,
            defaults={
                "label": label,
                "data_type": data_type,
                "required": required,
                "options": [],
                "display_order": 0,
                "created_by": actor,
                "updated_by": actor,
            },
        )
