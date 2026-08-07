"""Backfill ``rtg_slug`` on already-published RTG formulations.

Freshly published rows will get a slug via the publish service, but
this migration handles any RTG that was published BEFORE the field
existed. Strategy:

    slug = slugify(rtg_display_name or code or id-prefix)
    dedupe by appending -2, -3, ... until the row is unique

Non-RTG formulations (or drafts) stay at ``NULL`` — they don't have
a marketing page and never need a slug.
"""

from __future__ import annotations

from django.db import migrations
from django.utils.text import slugify


def _dedupe_slug(base: str, model, existing_ids: set[str]) -> str:
    """Return a unique slug derived from ``base``. Uses ``base``,
    ``base-2``, ``base-3``, ... until a collision-free value lands.

    ``existing_ids`` is the set of rows already re-slugged in this
    migration, so we detect intra-batch collisions without hitting
    the DB per attempt."""
    if not base:
        return ""
    candidate = base
    counter = 2
    while (
        model.objects.filter(rtg_slug=candidate).exists()
        or candidate in existing_ids
    ):
        candidate = f"{base}-{counter}"
        counter += 1
    return candidate


def forwards(apps, schema_editor):
    Formulation = apps.get_model("formulations", "Formulation")
    assigned: set[str] = set()

    qs = Formulation.objects.filter(
        is_rtg_published=True,
        rtg_slug__isnull=True,
    ).only("id", "code", "rtg_display_name", "rtg_slug")

    for formulation in qs:
        seed = (
            formulation.rtg_display_name
            or formulation.code
            or str(formulation.id)[:8]
        )
        base = slugify(seed) or f"rtg-{str(formulation.id)[:8]}"
        slug = _dedupe_slug(base, Formulation, assigned)
        formulation.rtg_slug = slug
        formulation.save(update_fields=["rtg_slug"])
        assigned.add(slug)


def backwards(apps, schema_editor):
    """No-op reverse — leaving the slugs behind is safe (the field
    is nullable) and blowing them away would break any live links
    that shipped between the migrations. If a rollback truly needs
    to clear them, do it in the ORM shell."""


class Migration(migrations.Migration):
    dependencies = [
        ("formulations", "0071_rtg_slug_sample_fields"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
