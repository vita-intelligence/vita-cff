"""Helper for the ``rtg_catalog`` backfill migration.

Kept next to the migration file (rather than in the app's main
services module) so future readers tracing a one-off migration can
find the transform + its test coverage in one place. The migration
imports :func:`backfill_membership_permissions` directly.
"""

from __future__ import annotations


RTG_MODULE = "rtg_catalog"
RTG_ALL_CAPS = ("view", "manage", "publish")


def backfill_membership_permissions(
    permissions: dict[str, object],
) -> dict[str, object]:
    """Return ``permissions`` augmented with the RTG catalog mirror.

    Mutates the input dict AND returns it (matching the migration's
    in-place update pattern). Contract:

    * If the membership does not carry a ``formulations`` grant that
      is a list containing ``"edit"``, the input is returned unchanged.
    * Otherwise the ``rtg_catalog`` key is set to the union of its
      current value (if any list) and the full RTG capability set.
    * A non-list ``formulations`` grant (typo, hand-edited membership)
      is treated as "no signal" and left alone. Safer to no-op than
      to guess intent.
    """

    if not isinstance(permissions, dict):
        return permissions
    formulations_grant = permissions.get("formulations")
    if not isinstance(formulations_grant, list):
        return permissions
    if "edit" not in formulations_grant:
        return permissions

    existing = permissions.get(RTG_MODULE)
    if not isinstance(existing, list):
        existing = []
    merged = sorted(set(existing) | set(RTG_ALL_CAPS))
    permissions[RTG_MODULE] = merged
    return permissions
