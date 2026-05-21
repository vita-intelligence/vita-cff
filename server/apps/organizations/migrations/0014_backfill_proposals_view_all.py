"""Grant ``proposals.view_all`` to memberships that already hold
``members.edit_permissions`` (i.e. org owners).

The new pipeline view (``/pipeline``) silently scopes to
``sales_person=request.user`` when this capability is missing, so a
rank-and-file rep only sees their own funnel and a manager / owner
with the grant sees the whole team. Backfilling only to memberships
with ``members.edit_permissions`` is the conservative choice: the
people who can already grant capabilities to others keep the
broadest possible view of the pipeline, but nobody else's effective
visibility changes on upgrade.

Members who already carry an out-of-band ``view_all`` grant are
left untouched — the migration merges, never overwrites.
"""

from __future__ import annotations

from django.db import migrations


def backfill_view_all(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    updated = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        members_grant = permissions.get("members")
        if not isinstance(members_grant, list):
            continue
        if "edit_permissions" not in members_grant:
            continue
        proposals_grant = permissions.get("proposals")
        if not isinstance(proposals_grant, list):
            continue
        if "view_all" in proposals_grant:
            continue
        permissions["proposals"] = sorted(
            set(proposals_grant) | {"view_all"},
        )
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        updated += 1
    print(f"  [view_all_backfill] memberships updated: {updated}")


def revert_view_all(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        grant = permissions.get("proposals")
        if not isinstance(grant, list) or "view_all" not in grant:
            continue
        permissions["proposals"] = sorted(set(grant) - {"view_all"})
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        cleared += 1
    print(f"  [view_all_backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0013_organization_wix_cff_config"),
    ]

    operations = [
        migrations.RunPython(backfill_view_all, revert_view_all),
    ]
