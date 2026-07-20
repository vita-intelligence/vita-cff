"""Grant ``formulations.manage_stage_templates`` to memberships that
already hold ``members.edit_permissions`` (i.e. org owners /
permission admins).

Rationale — templates codify the org's canonical production routes
(Capsule / Gummy / Tablet / etc). Rank-and-file scientists should be
able to APPLY templates but not RESHAPE them; the reshape right sits
with whoever already curates the workspace's permission matrix.
Backfilling to ``members.edit_permissions`` holders gives every
existing admin the reshape right on upgrade without expanding
anyone else's blast radius.

Members who already carry an out-of-band grant are left untouched —
the migration merges, never overwrites.
"""

from __future__ import annotations

from django.db import migrations


def backfill(apps, schema_editor):
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
        formulations_grant = permissions.get("formulations")
        if not isinstance(formulations_grant, list):
            continue
        if "manage_stage_templates" in formulations_grant:
            continue
        permissions["formulations"] = sorted(
            set(formulations_grant) | {"manage_stage_templates"},
        )
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        updated += 1
    print(f"  [manage_stage_templates backfill] memberships updated: {updated}")


def revert(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        grant = permissions.get("formulations")
        if not isinstance(grant, list) or "manage_stage_templates" not in grant:
            continue
        permissions["formulations"] = sorted(
            set(grant) - {"manage_stage_templates"},
        )
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        cleared += 1
    print(f"  [manage_stage_templates backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0016_organization_psp_config"),
    ]

    operations = [
        migrations.RunPython(backfill, revert),
    ]
