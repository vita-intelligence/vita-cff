"""Mirror ``proposals.approve`` grants onto ``proposals.manual_close``.

The new ``manual_close`` capability gates the staff-side "mark
proposal accepted / rejected" override. Without a backfill, every
existing member who used to flip a ``sent`` proposal to closed via
the generic ``edit`` route would suddenly hit a 403 — silent rights
regression on upgrade.

Heuristic: anyone already trusted to approve a proposal internally
is trusted to declare the customer outcome. Members with
``proposals.approve`` therefore inherit ``manual_close`` here.
Members without it stay clean; admins explicitly grant later if
needed (e.g. commercial leads who don't approve but do close
deals). Owners bypass capability checks anyway.

Members who already carry an out-of-band ``manual_close`` grant are
left untouched — the migration merges, never overwrites.
"""

from __future__ import annotations

from django.db import migrations


def backfill_manual_close(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    updated = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        grant = permissions.get("proposals")
        if not isinstance(grant, list):
            continue
        if "approve" not in grant:
            continue
        if "manual_close" in grant:
            continue
        permissions["proposals"] = sorted(set(grant) | {"manual_close"})
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        updated += 1
    print(f"  [manual_close_backfill] memberships updated: {updated}")


def revert_manual_close(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        grant = permissions.get("proposals")
        if not isinstance(grant, list) or "manual_close" not in grant:
            continue
        permissions["proposals"] = sorted(set(grant) - {"manual_close"})
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        cleared += 1
    print(f"  [manual_close_backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0009_rbac_pair_normalisation"),
    ]

    operations = [
        migrations.RunPython(backfill_manual_close, revert_manual_close),
    ]
