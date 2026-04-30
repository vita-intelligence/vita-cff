"""Module registry for organization-scoped RBAC.

A *module* is a slice of application functionality (members, catalogues,
formulations) that can be independently authorised. Each module declares
a tuple of **capabilities** — named actions a grant can unlock.

Two storage shapes, both on :attr:`Membership.permissions`:

* **Flat** modules store a list of capability strings:
  ``{"members": ["view", "invite"]}``.
* **Row-scoped** modules store a ``{scope: [capabilities]}`` dict so
  different rows of the same module can carry independent grants:
  ``{"catalogues": {"raw_materials": ["view", "edit"], "packaging":
  ["view"]}}``.

Owners' ``permissions`` field is ignored entirely — they bypass every
capability check. Non-owners must be granted each capability
explicitly, and the check layer in :func:`has_capability` refuses any
capability not declared on the module here (typoed capability strings
silently succeeding would be a nasty security footgun).
"""

from __future__ import annotations

from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Module keys (constants so call-sites don't embed magic strings)
# ---------------------------------------------------------------------------

MEMBERS_MODULE = "members"
CATALOGUES_MODULE = "catalogues"
FORMULATIONS_MODULE = "formulations"
PROPOSALS_MODULE = "proposals"
AUDIT_MODULE = "audit"


# ---------------------------------------------------------------------------
# Capability constants — import these into views, don't hard-code strings.
# The values are the wire / storage format; the attribute names are
# what shows up in ``required_capability = FormulationsCapability.EDIT``.
# ---------------------------------------------------------------------------


class MembersCapability:
    VIEW = "view"
    INVITE = "invite"
    EDIT_PERMISSIONS = "edit_permissions"
    REMOVE = "remove"


class CataloguesCapability:
    VIEW = "view"
    EDIT = "edit"
    IMPORT = "import"
    MANAGE_FIELDS = "manage_fields"
    DELETE = "delete"


class FormulationsCapability:
    VIEW = "view"
    EDIT = "edit"
    APPROVE = "approve"
    DELETE = "delete"
    #: Read the org-wide "documents waiting for approval" inbox.
    #: Split from :attr:`APPROVE` so admins can grant a stakeholder
    #: read-only visibility into the queue (e.g. ops watching the
    #: pipeline) without giving them the right to actually flip a
    #: document's status.
    VIEW_APPROVALS = "view_approvals"
    #: Read the org-wide "sent + signed by customer" archive. Split
    #: from :attr:`VIEW` so the customer-facing history surface can
    #: be opened up to commercial roles (sales tracking what's gone
    #: out and come back) without granting broader project-view
    #: access to the formulations themselves.
    VIEW_SIGNED = "view_signed"
    #: Assign / clear the commercial owner ("sales person") of a
    #: project. Deliberately split from ``EDIT`` so the role can be
    #: delegated to non-technical staff without giving them write
    #: access to the formulation itself.
    ASSIGN_SALES_PERSON = "assign_sales_person"
    #: Toggle individual sections on or off for the customer-facing
    #: spec sheet. Split from ``EDIT`` so the client-visibility
    #: decision sits with commercial / QA leads while scientists
    #: keep free-form edit access to the sheet's content.
    MANAGE_SPEC_VISIBILITY = "manage_spec_visibility"
    #: Sign a spec sheet in one of its signature slots. Placeholder
    #: capability that the Phase-B signatures work will consume.
    #: Landing the string now lets admins pre-grant the role without
    #: a second permission-UI migration later.
    SIGN_SPEC = "sign_spec"
    #: Read the comment thread on any entity in this workspace
    #: (formulations, spec sheets, later trial batches / QC). Split
    #: from ``VIEW`` so a read-only reviewer can still see discussion
    #: history without gaining broader project-view rights.
    COMMENTS_VIEW = "comments_view"
    #: Post, edit own, delete own, and resolve own comment threads.
    #: Authors always retain edit / delete / resolve on their own
    #: comments regardless of whether this capability is granted —
    #: the capability gates the *initial* post and operations on
    #: threads the caller does not own.
    COMMENTS_WRITE = "comments_write"
    #: Edit, delete, or resolve *other* users' comments. The
    #: "moderator" grant — typically held by team leads and owners
    #: only. Required to close out a thread a teammate forgot to
    #: resolve, or to take down an accidental client-facing comment.
    COMMENTS_MODERATE = "comments_moderate"


class ProposalsCapability:
    """Capabilities specific to the customer-facing proposal surface.

    Split out of :class:`FormulationsCapability` so commercial roles
    (sales, account management) can be granted access to the proposal
    workflow — list, edit, approve, sign, watch the queue, browse
    signed history — without inheriting the broader project-edit
    rights. The membership backfill migration mirrors any existing
    ``formulations.*`` grants onto matching ``proposals.*`` keys so
    no member loses access on upgrade.
    """

    VIEW = "view"
    EDIT = "edit"
    APPROVE = "approve"
    DELETE = "delete"
    #: Sign a proposal in any internal slot (Scientist, R&D Manager,
    #: Product Manager, Director). The customer signature on the
    #: public kiosk is gated by token only, not by this capability.
    SIGN = "sign"
    #: Read the proposals tab of the org-wide approvals inbox.
    VIEW_APPROVALS = "view_approvals"
    #: Read the proposals tab of the customer-signed archive.
    VIEW_SIGNED = "view_signed"
    #: Assign / clear the sales person on a proposal's parent project.
    ASSIGN_SALES_PERSON = "assign_sales_person"


class AuditCapability:
    #: Read the org-wide audit log. Deliberately the only cap today —
    #: audit rows are immutable by contract, so there's nothing else
    #: to grant. If we later add a "sign off on a forensic report"
    #: workflow it becomes its own capability alongside ``VIEW``.
    VIEW = "view"


@dataclass(frozen=True)
class Module:
    key: str
    name: str
    description: str
    capabilities: tuple[str, ...]
    #: When ``True`` the module's grant is stored as ``{scope:
    #: [capabilities]}`` rather than a bare capability list. Permission
    #: checks on row-scoped modules require a ``scope`` argument.
    row_scoped: bool = False


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

MODULE_REGISTRY: dict[str, Module] = {
    MEMBERS_MODULE: Module(
        key=MEMBERS_MODULE,
        name="Members",
        description="Invite, review, and remove organization members.",
        capabilities=(
            MembersCapability.VIEW,
            MembersCapability.INVITE,
            MembersCapability.EDIT_PERMISSIONS,
            MembersCapability.REMOVE,
        ),
    ),
    CATALOGUES_MODULE: Module(
        key=CATALOGUES_MODULE,
        name="Catalogues",
        description=(
            "Browse and manage catalogue rows (raw materials, packaging, "
            "and any custom reference tables). Row-scoped: each catalogue "
            "slug carries its own capability list."
        ),
        row_scoped=True,
        capabilities=(
            CataloguesCapability.VIEW,
            CataloguesCapability.EDIT,
            CataloguesCapability.IMPORT,
            CataloguesCapability.MANAGE_FIELDS,
            CataloguesCapability.DELETE,
        ),
    ),
    FORMULATIONS_MODULE: Module(
        key=FORMULATIONS_MODULE,
        name="Projects",
        description=(
            "Project workspace: formulations, versions, spec sheets, "
            "trial batches, and QC validations. Reads raw materials from "
            "the catalogues module but carries its own capability scope."
        ),
        capabilities=(
            FormulationsCapability.VIEW,
            FormulationsCapability.EDIT,
            FormulationsCapability.APPROVE,
            FormulationsCapability.DELETE,
            FormulationsCapability.VIEW_APPROVALS,
            FormulationsCapability.VIEW_SIGNED,
            FormulationsCapability.ASSIGN_SALES_PERSON,
            FormulationsCapability.MANAGE_SPEC_VISIBILITY,
            FormulationsCapability.SIGN_SPEC,
            FormulationsCapability.COMMENTS_VIEW,
            FormulationsCapability.COMMENTS_WRITE,
            FormulationsCapability.COMMENTS_MODERATE,
        ),
    ),
    PROPOSALS_MODULE: Module(
        key=PROPOSALS_MODULE,
        name="Proposals",
        description=(
            "Customer-facing proposal workflow: list, edit, approve, "
            "send, sign, browse approval queue and signed archive. "
            "Split from Projects so commercial roles can own the "
            "proposal pipeline without project-edit rights."
        ),
        capabilities=(
            ProposalsCapability.VIEW,
            ProposalsCapability.EDIT,
            ProposalsCapability.APPROVE,
            ProposalsCapability.DELETE,
            ProposalsCapability.SIGN,
            ProposalsCapability.VIEW_APPROVALS,
            ProposalsCapability.VIEW_SIGNED,
            ProposalsCapability.ASSIGN_SALES_PERSON,
        ),
    ),
    AUDIT_MODULE: Module(
        key=AUDIT_MODULE,
        name="Audit log",
        description=(
            "Read the org-wide audit trail of every write across "
            "catalogues, projects, spec sheets, trial batches, and "
            "QC validations. Compliance + incident review surface."
        ),
        capabilities=(AuditCapability.VIEW,),
    ),
}


# ---------------------------------------------------------------------------
# Registry helpers
# ---------------------------------------------------------------------------


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


def capabilities_for(key: str) -> tuple[str, ...]:
    """Return the declared capability tuple for a module key (or ``()``)."""

    module = MODULE_REGISTRY.get(key)
    return module.capabilities if module else ()


def is_valid_capability(module_key: str, capability: str) -> bool:
    """Return ``True`` iff ``capability`` is declared on ``module_key``."""

    return capability in capabilities_for(module_key)
