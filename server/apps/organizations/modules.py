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
RTG_CATALOG_MODULE = "rtg_catalog"
PROPOSALS_MODULE = "proposals"
AUDIT_MODULE = "audit"
CFF_SUBMISSIONS_MODULE = "cff_submissions"
LABELLING_MODULE = "labelling"
FINANCE_MODULE = "finance"
SAMPLE_PRICING_MODULE = "sample_pricing"


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
    #: Assign / clear the lead scientist on a project. Mirrors
    #: :attr:`ASSIGN_SALES_PERSON` but for the R&D side: a triage
    #: lead can route a fresh project to the scientist who will own
    #: the recipe work without inheriting full ``EDIT`` rights on
    #: the formulation. The assignment is advisory only — it does
    #: not gate edit access, since other R&D members still need to
    #: collaborate on the same workspace.
    ASSIGN_LEAD_SCIENTIST = "assign_lead_scientist"
    #: See the org-wide R&D kanban (``/rd-pipeline``) across *every*
    #: scientist's projects — not just the ones assigned to the
    #: caller. The pipeline endpoint silently scopes to
    #: ``lead_scientist=request.user`` when this cap is missing, so
    #: a rank-and-file scientist sees their own funnel and a triage
    #: lead / R&D director with this grant sees the whole team.
    #:
    #: Mirrors :attr:`ProposalsCapability.VIEW_ALL` on the sales side.
    #: Owners bypass capability checks anyway; admins explicitly
    #: grant this to managers via the members admin grid.
    VIEW_ALL_RD_PIPELINE = "view_all_rd_pipeline"
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
    #: Create / edit / delete the org's reusable stage templates
    #: (Capsule / Gummy / Tablet / etc). Scientists with ``VIEW``
    #: still see the templates in the picker and can apply them —
    #: only editing the template library itself is gated. Kept
    #: separate from ``EDIT`` so the R&D lead can curate templates
    #: without every rank-and-file scientist reshaping the org's
    #: canonical routes.
    MANAGE_STAGE_TEMPLATES = "manage_stage_templates"
    #: Create / edit / delete the org's reusable page-builder
    #: templates used to seed the RTG product page editor. Scientists
    #: with ``VIEW`` still see the templates in the "Apply template"
    #: picker on the page editor toolbar — only editing the template
    #: library itself is gated behind this cap. Mirrors the
    #: MANAGE_STAGE_TEMPLATES model for symmetry.
    MANAGE_PAGE_BUILDER_TEMPLATES = "manage_page_builder_templates"


class ProposalsCapability:
    """Capabilities specific to the customer-facing proposal surface.

    Split out of :class:`FormulationsCapability` so commercial roles
    (sales, account management) can be granted access to the proposal
    workflow — list, edit, approve, sign, watch the queue, browse
    signed history — without inheriting the broader project-edit
    rights. The membership backfill migration mirrors any existing
    ``formulations.*`` grants onto matching ``proposals.*`` keys so
    no member loses access on upgrade.

    Several caps here are MIRRORS of the matching ``formulations.*``
    cap and must always be granted together for the day-to-day UI to
    line up (a member with only one half sees a partial Approvals or
    Signed tab). The members admin grid pairs them so toggling either
    half sets both atomically; migration
    ``0009_rbac_pair_normalisation`` backfills any pre-existing
    half-granted memberships.

    ``assign_sales_person`` USED to live here too as a mirror of
    :attr:`FormulationsCapability.ASSIGN_SALES_PERSON`, but the
    only endpoint that enforces the cap (the project-level
    ``FormulationSalesPersonView``) reads the ``formulations.*``
    half, so the proposals mirror was dead code. It was removed in
    migration ``0009_rbac_pair_normalisation``; any remaining
    grants get silently dropped by
    :func:`validate_permissions_payload` on the next round-trip.
    """

    VIEW = "view"
    EDIT = "edit"
    APPROVE = "approve"
    DELETE = "delete"
    #: Sign a proposal in any internal slot (Scientist, R&D Manager,
    #: Product Manager, Director). The customer signature on the
    #: public kiosk is gated by token only, not by this capability.
    #: Paired with :attr:`FormulationsCapability.SIGN_SPEC`.
    SIGN = "sign"
    #: Read the proposals tab of the org-wide approvals inbox.
    #: Paired with :attr:`FormulationsCapability.VIEW_APPROVALS`.
    VIEW_APPROVALS = "view_approvals"
    #: Read the proposals tab of the customer-signed archive.
    #: Paired with :attr:`FormulationsCapability.VIEW_SIGNED`.
    VIEW_SIGNED = "view_signed"
    #: Manually close a ``sent`` proposal as ``accepted`` or
    #: ``rejected`` from the staff UI — i.e. overriding the
    #: kiosk-driven flow when the customer responded over phone /
    #: email and the team needs to mark the deal closed by hand.
    #: Deliberately split from :attr:`EDIT` so a sales rep with
    #: edit rights can't unilaterally mark a deal won; deliberately
    #: split from :attr:`APPROVE` so the role that internally
    #: approves a proposal isn't automatically the role that
    #: declares a customer outcome. Usually granted to commercial
    #: leads or directors.
    MANUAL_CLOSE = "manual_close"
    #: See the org-wide commercial pipeline (``/pipeline``) across
    #: *every* sales person's proposals — not just the ones assigned
    #: to the caller. The pipeline endpoint silently scopes to
    #: ``sales_person=request.user`` when this cap is missing, so a
    #: rank-and-file rep sees their own funnel and a commercial
    #: lead / director with this grant sees the whole team.
    #:
    #: Backfilled only to memberships that already hold
    #: :attr:`MembersCapability.EDIT_PERMISSIONS` (i.e. owners) so
    #: the upgrade does not silently broaden anyone else's view —
    #: admins explicitly grant it to managers via the members admin
    #: grid.
    VIEW_ALL = "view_all"


class AuditCapability:
    #: Read the org-wide audit log. Deliberately the only cap today —
    #: audit rows are immutable by contract, so there's nothing else
    #: to grant. If we later add a "sign off on a forensic report"
    #: workflow it becomes its own capability alongside ``VIEW``.
    VIEW = "view"


class LabellingCapability:
    """Capabilities for the Labelling team workflow.

    Split from :class:`FormulationsCapability` so the labelling team
    can own the post-spec design phase without holding formulation-
    edit rights. The two roles ``REVIEW_SCIENTIST`` and
    ``REVIEW_DIRECTOR`` mirror the signature slots on the
    SpecificationSheet (prepared-by vs director) — pair them with
    the matching staff role on the team, never on the same user.
    """

    #: Read access to label-design rows and their revisions.
    VIEW = "view"
    #: Create / edit revisions, upload artwork.
    DESIGN = "design"
    #: Submit the scientist review on a revision. Mirrors the
    #: prepared-by signature slot on the spec sheet.
    REVIEW_SCIENTIST = "review_scientist"
    #: Submit the director review on a revision. Mirrors the
    #: director signature slot on the spec sheet.
    REVIEW_DIRECTOR = "review_director"
    #: Assign a designer, hold / resume the workflow. The "manager"
    #: of the labelling team.
    MANAGE = "manage"


class FinanceCapability:
    """Capabilities for the finance team.

    The finance role is the gate between an APPROVED project and
    the LabelDesign workflow opening up to the customer — finance
    records a payment, approves it, and that drives the LabelDesign
    forward from ``PAYMENT_PENDING`` to ``LABEL_PATH_PENDING``.
    """

    VIEW = "view"
    RECORD_PAYMENT = "record_payment"
    APPROVE_PAYMENT = "approve_payment"
    #: Assign / clear the finance-officer pointer on a Payment —
    #: i.e. who in the finance team owns recording / chasing this
    #: specific customer payment. Mirrors
    #: :attr:`FormulationsCapability.ASSIGN_SALES_PERSON` /
    #: ``ASSIGN_LEAD_SCIENTIST``: pointer-only, no capability
    #: inheritance. Lives on :class:`payments.Payment` (the unit
    #: of work the finance team owns) rather than ``LabelDesign``
    #: so the labelling team and finance team each have a clean
    #: queue keyed on their own pointer.
    ASSIGN_OFFICER = "assign_officer"


class RTGCatalogCapability:
    """Capabilities for the Ready-to-Go catalog surface.

    Split from :class:`FormulationsCapability` so a "catalog manager"
    role can list, edit marketing copy, and flip the publish switch on
    RTG SKUs without inheriting broader project-edit rights on the
    underlying formulation (which controls the recipe, spec sheets,
    trial batches, and QC). The three caps mirror the mental model of
    the catalog:

    * :attr:`VIEW` — read the RTG catalog list and detail. Sees which
      SKUs are published and their marketing block. Does not grant
      access to the recipe / R&D data on the underlying formulation.
    * :attr:`MANAGE` — edit the marketing block (display name, short
      description, hero image, price, MOQ, packaging options) on RTG
      SKUs. Held by copy owners / commercial ops.
    * :attr:`PUBLISH` — flip the ``is_rtg_published`` flag on or off.
      The go-live gate, deliberately split from ``MANAGE`` so the
      person drafting copy and the person authorising customer
      visibility can be different people (segregation of duties on
      what appears in the customer portal).

    Membership backfill on ``0011_rtg_catalog_module`` mirrors any
    existing ``formulations.edit`` grant onto
    ``rtg_catalog.view + manage + publish`` so no member loses access
    on upgrade. Owners bypass regardless.
    """

    VIEW = "view"
    MANAGE = "manage"
    PUBLISH = "publish"


class SamplePricingCapability:
    """Capabilities for the org-level "sample pricing" settings module.

    Drives the customer-portal sample-selection stage after proposal
    sign — finance edits ``free_samples_included`` /
    ``price_per_extra_sample`` + the quantity-threshold discount
    tiers, and the portal's picker renders those knobs live. Kept
    separate from :class:`FinanceCapability` because pricing setup is
    a config-time act (rarely touched, sits with an ops / finance
    lead) while recording + approving individual payments is a
    day-to-day finance-team workflow — different frequencies, often
    different people.

    * :attr:`VIEW` — read the config + tiers. Held by finance so they
      can eyeball what the customer will be charged before invoicing.
    * :attr:`EDIT` — mutate the config + tiers. Held by ops leads /
      finance heads. Editing here is a live change: the next customer
      to hit sample selection sees the new numbers immediately.
    """

    VIEW = "view"
    EDIT = "edit"


class CFFSubmissionsCapability:
    """Capabilities for the CFF (Custom Formulation Request) intake.

    The CFF intake is the upstream funnel for new project work:
    customers fill in a public Wix-hosted form, our poller mirrors
    each submission, and a team member with
    :attr:`ASSIGN_PROJECT` attaches it to a :class:`Formulation`
    (project), which is when the workspace actually opens.

    Split from the Projects module on purpose — commercial / triage
    roles often need to read the intake and route it without holding
    formulation-edit rights, and granting "view CFFs" via
    ``formulations.view`` would over-share. The admin UI pairs
    :attr:`ASSIGN_PROJECT` with
    :attr:`FormulationsCapability.ASSIGN_LEAD_SCIENTIST` on the same
    roles so the triage workflow stays coherent — one click routes
    the CFF to a project and nominates the scientist on it.
    """

    VIEW = "view"
    #: Attach a CFF submission to a project (or detach it). Split
    #: from :attr:`VIEW` so a read-only reviewer can browse the
    #: intake without changing what's wired to which project.
    ASSIGN_PROJECT = "assign_project"


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
            FormulationsCapability.ASSIGN_LEAD_SCIENTIST,
            FormulationsCapability.VIEW_ALL_RD_PIPELINE,
            FormulationsCapability.MANAGE_SPEC_VISIBILITY,
            FormulationsCapability.SIGN_SPEC,
            FormulationsCapability.COMMENTS_VIEW,
            FormulationsCapability.COMMENTS_WRITE,
            FormulationsCapability.COMMENTS_MODERATE,
            FormulationsCapability.MANAGE_STAGE_TEMPLATES,
            FormulationsCapability.MANAGE_PAGE_BUILDER_TEMPLATES,
        ),
    ),
    RTG_CATALOG_MODULE: Module(
        key=RTG_CATALOG_MODULE,
        name="RTG Catalog",
        description=(
            "Ready-to-Go catalog: browse, edit marketing copy, "
            "and publish / unpublish SKUs that appear in the "
            "customer portal. Split from Projects so the catalog "
            "manager can go live without holding recipe-edit "
            "rights on the underlying formulation."
        ),
        capabilities=(
            RTGCatalogCapability.VIEW,
            RTGCatalogCapability.MANAGE,
            RTGCatalogCapability.PUBLISH,
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
            ProposalsCapability.MANUAL_CLOSE,
            ProposalsCapability.VIEW_ALL,
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
    CFF_SUBMISSIONS_MODULE: Module(
        key=CFF_SUBMISSIONS_MODULE,
        name="CFF Submissions",
        description=(
            "Custom Formulation Request intake: read submissions "
            "imported from the public Wix-hosted form and attach "
            "each one to a project. Upstream of the Projects module."
        ),
        capabilities=(
            CFFSubmissionsCapability.VIEW,
            CFFSubmissionsCapability.ASSIGN_PROJECT,
        ),
    ),
    LABELLING_MODULE: Module(
        key=LABELLING_MODULE,
        name="Labelling",
        description=(
            "Post-approval label-design workflow: customer chooses "
            "design path, scientist + director review the artwork, "
            "customer signs off. Includes the spec-derived "
            "Compliance Content Block exports."
        ),
        capabilities=(
            LabellingCapability.VIEW,
            LabellingCapability.DESIGN,
            LabellingCapability.REVIEW_SCIENTIST,
            LabellingCapability.REVIEW_DIRECTOR,
            LabellingCapability.MANAGE,
        ),
    ),
    FINANCE_MODULE: Module(
        key=FINANCE_MODULE,
        name="Finance",
        description=(
            "Record customer payments and approve them. Approving a "
            "payment unlocks the downstream label-design workflow "
            "for the customer."
        ),
        capabilities=(
            FinanceCapability.VIEW,
            FinanceCapability.RECORD_PAYMENT,
            FinanceCapability.APPROVE_PAYMENT,
            FinanceCapability.ASSIGN_OFFICER,
        ),
    ),
    SAMPLE_PRICING_MODULE: Module(
        key=SAMPLE_PRICING_MODULE,
        name="Sample pricing",
        description=(
            "Free sample allowance + per-extra-sample price + "
            "quantity-threshold discount tiers. Drives the customer "
            "portal's post-proposal sample-selection stage: the "
            "customer picks a quantity, the numbers here compute what "
            "they owe on top of the deposit, and a single bundled "
            "invoice lands on the finance queue for approval."
        ),
        capabilities=(
            SamplePricingCapability.VIEW,
            SamplePricingCapability.EDIT,
        ),
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
