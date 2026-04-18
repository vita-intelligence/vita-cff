"""Data migration: collapse RBAC levels into named capability lists.

The original permission model stored a single level (``read``, ``write``,
``admin``) per module on :attr:`Membership.permissions`. The refactor
introduces named capabilities — ``view``, ``edit``, ``approve``,
``delete`` (plus ``import`` / ``manage_fields`` on catalogues and
``invite`` / ``edit_permissions`` / ``remove`` on members) — each stored
as a string list. This migration rewrites every existing grant to the
new shape, and folds the legacy ``specifications`` module grants into
``formulations`` (the two are now one workspace).

The legacy-level → capability-list mapping is permissive: a user who
previously had ``write`` on formulations kept the ability to transition
statuses, so they get ``approve`` too. Admins — the rare higher tier —
get the full capability set. Apps can tighten grants from the new UI.
"""

from __future__ import annotations

from django.db import migrations


# Capability sets per legacy level. Keep these inline so the migration
# stays a pure data transform that does not depend on future edits to
# the live module registry.
_MEMBERS_BY_LEVEL: dict[str, list[str]] = {
    "read": ["view"],
    "write": ["view", "invite"],
    "admin": ["view", "invite", "edit_permissions", "remove"],
}

_CATALOGUES_BY_LEVEL: dict[str, list[str]] = {
    "read": ["view"],
    "write": ["view", "edit", "import"],
    "admin": ["view", "edit", "import", "manage_fields", "delete"],
}

_FORMULATIONS_BY_LEVEL: dict[str, list[str]] = {
    "read": ["view"],
    "write": ["view", "edit", "approve"],
    "admin": ["view", "edit", "approve", "delete"],
}


def _migrate_permissions(raw: dict | None) -> dict:
    """Return a refactored permissions dict for ``raw``.

    Accepts the legacy shape (``{"members": "admin"}``) or the new
    capability-list shape (``{"members": ["view", ...]}``) — the latter
    happens when this migration re-runs against already-migrated data.
    """

    if not isinstance(raw, dict):
        return {}

    result: dict = {}

    def _merge_formulations(capabilities: list[str]) -> None:
        existing = result.setdefault("formulations", [])
        for c in capabilities:
            if c not in existing:
                existing.append(c)

    # members — flat, value is level string or capability list.
    members_raw = raw.get("members")
    if isinstance(members_raw, str):
        caps = _MEMBERS_BY_LEVEL.get(members_raw)
        if caps is not None:
            result["members"] = list(caps)
    elif isinstance(members_raw, list):
        valid = {"view", "invite", "edit_permissions", "remove"}
        result["members"] = [c for c in members_raw if c in valid]

    # catalogues — row-scoped, value is ``{slug: level_or_caps}``.
    catalogues_raw = raw.get("catalogues")
    if isinstance(catalogues_raw, dict):
        out: dict[str, list[str]] = {}
        for slug, value in catalogues_raw.items():
            if not isinstance(slug, str):
                continue
            if isinstance(value, str):
                caps = _CATALOGUES_BY_LEVEL.get(value)
                if caps is not None:
                    out[slug] = list(caps)
            elif isinstance(value, list):
                valid = {"view", "edit", "import", "manage_fields", "delete"}
                out[slug] = [c for c in value if c in valid]
        if out:
            result["catalogues"] = out

    # formulations — flat.
    formulations_raw = raw.get("formulations")
    if isinstance(formulations_raw, str):
        caps = _FORMULATIONS_BY_LEVEL.get(formulations_raw)
        if caps is not None:
            _merge_formulations(list(caps))
    elif isinstance(formulations_raw, list):
        valid = {"view", "edit", "approve", "delete"}
        _merge_formulations([c for c in formulations_raw if c in valid])

    # specifications — folded into formulations. Take the maximum of
    # the two legacy grants so users who had ``specifications:admin``
    # but only ``formulations:read`` come out with the union of both.
    specifications_raw = raw.get("specifications")
    if isinstance(specifications_raw, str):
        caps = _FORMULATIONS_BY_LEVEL.get(specifications_raw)
        if caps is not None:
            _merge_formulations(list(caps))

    return result


def forwards(apps, schema_editor):
    Membership = apps.get_model("organizations", "Membership")
    Invitation = apps.get_model("organizations", "Invitation")

    for row in Membership.objects.all().iterator():
        new = _migrate_permissions(row.permissions)
        if new != row.permissions:
            row.permissions = new
            row.save(update_fields=["permissions"])

    for row in Invitation.objects.all().iterator():
        new = _migrate_permissions(row.permissions)
        if new != row.permissions:
            row.permissions = new
            row.save(update_fields=["permissions"])


def backwards(apps, schema_editor):
    """Irreversible — capability sets can't be collapsed back to a single
    level without loss. Pretend it's a no-op so ``migrate --fake`` works
    on rollback without blowing up.
    """


class Migration(migrations.Migration):
    dependencies = [
        ("organizations", "0002_invitation"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
