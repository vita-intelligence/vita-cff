"""Module registry for organization-scoped permissions.

A *module* is a slice of application functionality (members, ingredients,
formulations, proposals, ...) that can be independently authorised. Every
feature area is expected to register itself here so the role layer has a
stable, typed vocabulary of module keys to check permissions against.

The registry is intentionally a plain Python dict rather than a database
table: modules are code-shaped objects, they change with releases, and
new ones arrive together with their models, views, and migrations. Putting
them in the DB would just replicate what source control already tracks.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum


class PermissionLevel(IntEnum):
    """Monotonic ordering: higher levels subsume lower ones.

    Use the integer values for comparisons and ``.name.lower()`` (``read``,
    ``write``, ``admin``) for the wire / storage format.
    """

    NONE = 0
    READ = 10
    WRITE = 20
    ADMIN = 30

    @classmethod
    def parse(cls, value: str | None) -> "PermissionLevel":
        if not value:
            return cls.NONE
        try:
            return cls[value.upper()]
        except KeyError:
            return cls.NONE


@dataclass(frozen=True)
class Module:
    key: str
    name: str
    description: str


# ----------------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------------
# Register new modules here as features land. Keys must be stable machine
# strings (``snake_case``, no spaces) — they are persisted on every
# :class:`apps.organizations.models.Membership` row and referenced from
# permission checks throughout the backend.
MODULE_REGISTRY: dict[str, Module] = {
    "members": Module(
        key="members",
        name="Members",
        description="Invite, review, and remove organization members.",
    ),
}


def get_module(key: str) -> Module:
    """Return a :class:`Module` by key or raise ``KeyError``."""

    return MODULE_REGISTRY[key]


def all_modules() -> list[Module]:
    """Return every registered module in insertion order."""

    return list(MODULE_REGISTRY.values())


def module_keys() -> list[str]:
    return list(MODULE_REGISTRY.keys())


def is_valid_module(key: str) -> bool:
    return key in MODULE_REGISTRY
