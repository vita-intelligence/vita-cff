"""Normalise the formulations / proposals capability pair grants.

Several capabilities exist on BOTH the ``formulations`` and
``proposals`` modules and have identical semantics — granting one
without the other left users with a partial UI (e.g. "approver"
seeing only the Proposals tab on the Approvals queue but not the
Spec Sheets tab, or vice versa).

This migration:

1. **Mirrors paired grants** in BOTH directions. Anyone who today
   has ``formulations.view_approvals`` (but not its proposals
   mirror) gets ``proposals.view_approvals`` granted too — and the
   other way around. Lossless and idempotent: re-running adds
   nothing new on a clean DB.

2. **Drops the dead ``proposals.assign_sales_person`` cap.** The
   ``Customer.sales_person`` assignment endpoint only enforces
   ``formulations.assign_sales_person``; the proposals mirror was
   created by the original split-out migration but never wired to
   any endpoint. Cleaning it out of memberships now lets us drop
   the cap from the module registry without leaving stale grants
   that would be silently ignored on every subsequent permissions
   round-trip.

Owners are unaffected — their ``permissions`` dict is ignored by
the runtime ``has_capability`` checks.
"""

from __future__ import annotations

from django.db import migrations


#: ``[primary, mirror]`` pairs we mirror in both directions. The cap
#: name on each side does NOT have to match — the asymmetric
#: ``sign_spec`` ↔ ``sign`` pair has identical meaning and is treated
#: the same as the symmetric pairs below it.
CAPABILITY_PAIRS: list[tuple[tuple[str, str], tuple[str, str]]] = [
    (("formulations", "view_approvals"), ("proposals", "view_approvals")),
    (("formulations", "view_signed"), ("proposals", "view_signed")),
    (("formulations", "approve"), ("proposals", "approve")),
    (("formulations", "delete"), ("proposals", "delete")),
    (("formulations", "sign_spec"), ("proposals", "sign")),
]


#: Caps removed from the module registry in the same change-set as
#: this migration. We strip them out of every membership so the
#: ``permissions`` dict stays clean — leaving them in would just
#: trip the silent-drop branch of ``validate_permissions_payload``
#: on every subsequent edit. Pure cleanup.
DEAD_CAPS: list[tuple[str, str]] = [
    ("proposals", "assign_sales_person"),
]


def _list_caps(grants: dict, module: str) -> list[str]:
    raw = grants.get(module)
    if not isinstance(raw, list):
        return []
    return [str(c) for c in raw if isinstance(c, str)]


def normalise_grants(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    mirrored = 0
    cleaned = 0

    for membership in Membership.objects.all():
        permissions = membership.permissions
        if not isinstance(permissions, dict):
            continue
        changed = False

        # ---- Mirror paired caps in both directions -----------------
        for (a_mod, a_cap), (b_mod, b_cap) in CAPABILITY_PAIRS:
            a_caps = set(_list_caps(permissions, a_mod))
            b_caps = set(_list_caps(permissions, b_mod))
            if a_cap in a_caps and b_cap not in b_caps:
                b_caps.add(b_cap)
                permissions[b_mod] = sorted(b_caps)
                changed = True
            elif b_cap in b_caps and a_cap not in a_caps:
                a_caps.add(a_cap)
                permissions[a_mod] = sorted(a_caps)
                changed = True

        if changed:
            mirrored += 1

        # ---- Drop dead caps ----------------------------------------
        for module, cap in DEAD_CAPS:
            existing = _list_caps(permissions, module)
            if cap in existing:
                filtered = [c for c in existing if c != cap]
                if filtered:
                    permissions[module] = filtered
                else:
                    # Empty list → remove the module entry entirely
                    # so the wire shape stays compact.
                    permissions.pop(module, None)
                cleaned += 1
                changed = True

        if changed:
            membership.permissions = permissions
            membership.save(update_fields=["permissions"])

    print(
        f"  [rbac_pair_normalisation] mirrored memberships: {mirrored}, "
        f"dead-cap rows cleaned: {cleaned}"
    )


def revert(apps, schema_editor):
    """Roll-back is intentionally a no-op.

    Forward is purely additive (mirror) + a one-row cleanup (dead
    cap). Reversing the mirror would silently strip capabilities
    operators have since come to rely on; reversing the cleanup
    would re-introduce dead capability rows. Neither is desirable
    on rollback. If a true revert is ever needed it can be done
    via a fresh data migration.
    """
    return None


class Migration(migrations.Migration):

    dependencies = [
        ("organizations", "0008_organization_dynamics_config"),
    ]

    operations = [
        migrations.RunPython(normalise_grants, revert),
    ]
