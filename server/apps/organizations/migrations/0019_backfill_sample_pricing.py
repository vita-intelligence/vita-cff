"""Seed the new ``sample_pricing`` module onto existing memberships.

The Sample pricing settings module (defined in
:mod:`apps.organizations.modules`) governs the free-sample allowance,
per-extra-sample price, and discount tiers that drive the customer's
post-proposal sample-selection stage on the portal.

Backfill rule:

* ``sample_pricing.view`` → every membership that already carries
  ``finance.view``. Finance eyeballs what the customer will be
  charged before invoicing, so read access mirrors their existing
  scope. No inheritance the other way — reading pricing doesn't
  grant record/approve on Payments.

* ``sample_pricing.edit`` → every membership that already carries
  ``members.edit_permissions``. Editing pricing is a config-time act
  with organization-wide effect (the next customer sees the new
  numbers immediately) so it sits with permission admins by default;
  they can delegate to specific finance leads via the members module
  post-migration.

Merges into existing grants; never overwrites out-of-band grants.
"""

from __future__ import annotations

from django.db import migrations


MODULE = "sample_pricing"
CAP_VIEW = "view"
CAP_EDIT = "edit"


def _grant(permissions: dict, module: str, cap: str) -> bool:
    """Add ``cap`` to ``permissions[module]``, return True if changed."""

    grant = permissions.get(module)
    if not isinstance(grant, list):
        grant = []
    if cap in grant:
        return False
    permissions[module] = sorted({*grant, cap})
    return True


def _revoke(permissions: dict, module: str, cap: str) -> bool:
    """Remove ``cap`` from ``permissions[module]``, return True if changed."""

    grant = permissions.get(module)
    if not isinstance(grant, list) or cap not in grant:
        return False
    remaining = sorted(set(grant) - {cap})
    if remaining:
        permissions[module] = remaining
    else:
        permissions.pop(module, None)
    return True


def backfill(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    view_updates = 0
    edit_updates = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue

        finance_grant = permissions.get("finance")
        members_grant = permissions.get("members")

        touched = False
        if isinstance(finance_grant, list) and "view" in finance_grant:
            if _grant(permissions, MODULE, CAP_VIEW):
                view_updates += 1
                touched = True
        if (
            isinstance(members_grant, list)
            and "edit_permissions" in members_grant
        ):
            if _grant(permissions, MODULE, CAP_EDIT):
                edit_updates += 1
                touched = True

        if touched:
            membership.permissions = permissions
            membership.save(update_fields=["permissions"])
    print(
        f"  [sample_pricing_backfill] memberships updated: "
        f"view={view_updates}, edit={edit_updates}"
    )


def revert(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    cleared = 0
    for membership in Membership.objects.all():
        permissions = membership.permissions or {}
        if not isinstance(permissions, dict):
            continue
        touched = False
        if _revoke(permissions, MODULE, CAP_VIEW):
            touched = True
        if _revoke(permissions, MODULE, CAP_EDIT):
            touched = True
        if touched:
            membership.permissions = permissions
            membership.save(update_fields=["permissions"])
            cleared += 1
    print(f"  [sample_pricing_backfill] memberships cleared: {cleared}")


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0018_backfill_manage_page_builder_templates"),
        # Ensure the model tables exist before we start seeding
        # permissions that reference the module.
        ("payments", "0007_sample_pricing"),
    ]

    operations = [
        migrations.RunPython(backfill, revert),
    ]
