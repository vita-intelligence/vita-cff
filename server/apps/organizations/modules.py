"""Module registry for organization-scoped permissions.

A *module* is a slice of application functionality (members, catalogues,
formulations, ...) that can be independently authorised. Every feature
area is expected to register itself here so the role layer has a
stable, typed vocabulary of module keys to check permissions against.

Two kinds of modules exist:

* **Flat** modules store their grant as a single ``{module_key: level}``
  entry on the membership. ``members`` is a flat module.
* **Row-scoped** modules carry a per-row map instead of a single level,
  so different rows of the same kind can have different access. The
  ``catalogues`` module is row-scoped: a non-owner can have
  ``catalogues.raw_materials = read`` while having no access at all to
  ``catalogues.packaging``. Storage shape on the membership is
  ``{"catalogues": {"raw_materials": "read", "packaging": "write"}}``.

The registry is intentionally a plain Python dict rather than a
database table: modules are code-shaped objects, they change with
releases, and new ones arrive together with their models, views, and
migrations. Putting them in the DB would just replicate what source
control already tracks.
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
    #: When ``True`` the module's permission map holds a ``{row_scope:
    #: level}`` dict instead of a single level. Permission checks on
    #: row-scoped modules require a ``scope`` argument.
    row_scoped: bool = False


#: Name of the row-scope key on ``catalogues`` permission checks — the
#: catalogue slug (``raw_materials``, ``packaging``, ...). Exposed as a
#: constant so callers do not embed magic strings in permission calls.
CATALOGUES_MODULE = "catalogues"
FORMULATIONS_MODULE = "formulations"
MEMBERS_MODULE = "members"


# ----------------------------------------------------------------------------
# Registry
# ----------------------------------------------------------------------------
# Register new modules here as features land. Keys must be stable machine
# strings (``snake_case``, no spaces) — they are persisted on every
# :class:`apps.organizations.models.Membership` row and referenced from
# permission checks throughout the backend.
MODULE_REGISTRY: dict[str, Module] = {
    MEMBERS_MODULE: Module(
        key=MEMBERS_MODULE,
        name="Members",
        description="Invite, review, and remove organization members.",
    ),
    CATALOGUES_MODULE: Module(
        key=CATALOGUES_MODULE,
        name="Catalogues",
        description=(
            "Browse and manage catalogue rows (raw materials, packaging, "
            "and any custom reference tables). Row-scoped: each catalogue "
            "carries its own permission level."
        ),
        row_scoped=True,
    ),
    FORMULATIONS_MODULE: Module(
        key=FORMULATIONS_MODULE,
        name="Formulations",
        description=(
            "Build, version, and approve product formulations. Reads "
            "raw materials from the catalogues module but has its own "
            "permission scope so scientists can be granted builder "
            "access without touching the source catalogue."
        ),
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


def is_row_scoped(key: str) -> bool:
    module = MODULE_REGISTRY.get(key)
    return bool(module and module.row_scoped)
