"""Backfill ``proposals.*`` grants from existing ``formulations.*``.

Splitting the proposal workflow into its own RBAC module would
otherwise revoke access from every member who already had broad
``formulations.*`` capabilities — they'd hit a 404 on the proposals
list page until an admin re-granted it. This data migration mirrors
each member's relevant ``formulations`` grants onto a parallel
``proposals`` grant, preserving status quo.

Mapping (all lossless — every proposals capability has a 1:1 source
on the formulations side):

* ``formulations.view``                → ``proposals.view``
* ``formulations.edit``                → ``proposals.edit``
* ``formulations.approve``             → ``proposals.approve``
* ``formulations.delete``              → ``proposals.delete``
* ``formulations.sign_spec``           → ``proposals.sign``
* ``formulations.view_approvals``     → ``proposals.view_approvals``
* ``formulations.view_signed``        → ``proposals.view_signed``
* ``formulations.assign_sales_person`` → ``proposals.assign_sales_person``

Memberships that already carry a ``proposals`` grant are merged with
the formulations-derived set rather than overwritten — operators who
ran an out-of-band migration in advance keep their explicit picks.
Owners are unaffected because their ``permissions`` field is ignored
at check time anyway.
"""

from __future__ import annotations

from django.db import migrations


CAPABILITY_MAP: dict[str, str] = {
    "view": "view",
    "edit": "edit",
    "approve": "approve",
    "delete": "delete",
    "sign_spec": "sign",
    "view_approvals": "view_approvals",
    "view_signed": "view_signed",
    "assign_sales_person": "assign_sales_person",
}


def backfill_proposals(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    updated = 0

    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue

        formulations_grant = permissions.get("formulations")
        if not isinstance(formulations_grant, list):
            continue

        derived: set[str] = set()
        for cap in formulations_grant:
            target = CAPABILITY_MAP.get(cap)
            if target is not None:
                derived.add(target)

        if not derived:
            continue

        existing = permissions.get("proposals")
        if isinstance(existing, list):
            merged = sorted(set(existing) | derived)
        else:
            merged = sorted(derived)

        permissions["proposals"] = merged
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        updated += 1

    print(f"  [proposals_backfill] memberships updated: {updated}")


def revert_proposals(apps, schema_editor):
    """Drop the ``proposals`` grant entirely on rollback.

    Safe because the migration is purely additive — anyone who manually
    seeded ``proposals.*`` post-deploy will lose those picks here, but
    that's the expected semantic of rolling the split back.
    """

    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        if permissions.pop("proposals", None) is None:
            continue
        membership.permissions = permissions
        membership.save(update_fields=["permissions"])
        cleared += 1
    print(f"  [proposals_backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0005_organization_default_spec_limits"),
    ]

    operations = [
        migrations.RunPython(backfill_proposals, revert_proposals),
    ]
