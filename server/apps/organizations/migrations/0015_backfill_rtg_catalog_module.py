"""Backfill the new ``rtg_catalog`` module onto every existing
membership that already holds ``formulations.edit``.

Before this change, RTG publish + marketing edits rode on
``formulations.edit``. Splitting them into their own module would
otherwise strip access from every catalog manager on the deploy: their
existing ``formulations.edit`` grant no longer maps to any
``rtg_catalog.*`` capability, so ``FormulationRTGPublishView`` would
403 them the moment the code change lands.

The mirror is conservative:

* Any member with ``formulations.edit`` gets
  ``rtg_catalog.view + manage + publish`` — the full set. That
  matches the pre-split behaviour exactly (they could already
  publish anything they wanted).
* Members without ``formulations.edit`` are left alone. Owners are
  untouched too because owners bypass capability checks anyway; the
  migration only walks non-owner memberships to keep the JSON tidy.

The backfill merges into whatever ``rtg_catalog`` grant the
membership might already carry (an admin could have pre-seeded the
key manually) so this migration is safe to re-run — the union stays
identical.

Reverse migration strips the ``rtg_catalog`` key entirely so the
downgrade returns the schema to its pre-migration shape.
"""

from __future__ import annotations

from django.db import migrations

from apps.organizations.rtg_catalog_permissions import (
    RTG_MODULE,
    backfill_membership_permissions,
)


def backfill_rtg_catalog(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    updated = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        original_snapshot = dict(permissions)
        updated_permissions = backfill_membership_permissions(permissions)
        if updated_permissions == original_snapshot:
            continue
        membership.permissions = updated_permissions
        membership.save(update_fields=["permissions"])
        updated += 1
    print(f"  [rtg_catalog_backfill] memberships updated: {updated}")


def revert_rtg_catalog(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        if RTG_MODULE not in permissions:
            continue
        del permissions[RTG_MODULE]
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        cleared += 1
    print(f"  [rtg_catalog_backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0014_backfill_proposals_view_all"),
    ]

    operations = [
        migrations.RunPython(backfill_rtg_catalog, revert_rtg_catalog),
    ]
