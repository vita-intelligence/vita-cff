"""Grant ``formulations.manage_page_builder_templates`` to existing
permission-admin memberships.

Same rationale as ``0017_backfill_manage_stage_templates`` — the RTG
page-builder template library codifies the org's marketing shape, so
the reshape right sits with the permission admins; rank-and-file
scientists can APPLY templates without holding library-edit rights.

Merges into existing grants; never overwrites out-of-band grants.
"""

from __future__ import annotations

from django.db import migrations


CAP = "manage_page_builder_templates"


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
        if CAP in formulations_grant:
            continue
        permissions["formulations"] = sorted(
            set(formulations_grant) | {CAP},
        )
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        updated += 1
    print(f"  [{CAP} backfill] memberships updated: {updated}")


def revert(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        grant = permissions.get("formulations")
        if not isinstance(grant, list) or CAP not in grant:
            continue
        permissions["formulations"] = sorted(set(grant) - {CAP})
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        cleared += 1
    print(f"  [{CAP} backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0017_backfill_manage_stage_templates"),
    ]

    operations = [
        migrations.RunPython(backfill, revert),
    ]
