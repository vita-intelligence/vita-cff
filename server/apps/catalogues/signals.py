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

from apps.catalogues.models import (
    PACKAGING_SLUG,
    RAW_MATERIALS_SLUG,
    Catalogue,
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


@receiver(post_save, sender=Organization)
def seed_system_catalogues(
    sender, instance: Organization, created: bool, **kwargs
) -> None:
    """Create the system catalogues on first save of an organization.

    Idempotent: if the catalogue already exists (re-running a fixture,
    for instance) we skip it instead of raising. Non-system custom
    catalogues added by owners are never touched.
    """

    if not created:
        return

    for slug, name, description in SYSTEM_CATALOGUE_SPEC:
        Catalogue.objects.get_or_create(
            organization=instance,
            slug=slug,
            defaults={
                "name": name,
                "description": description,
                "is_system": True,
            },
        )
