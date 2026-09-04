"""Database models for the CFF (Custom Formulation Request Form) intake surface.

Customers fill in a public Wix-hosted form at vitamanufacture.co.uk. The
Celery beat task in this app polls Wix every few minutes and upserts
each submission into :class:`CFFSubmission`. A team member with the
``cff_submissions.assign_project`` capability later attaches a
submission to one or more :class:`apps.formulations.Formulation` rows
(projects), at which point the actual product workspace gets created
or wired up.

The CFF-to-project relationship is many-to-many. One real-world CFF
can fan out into multiple workspaces — a single customer brief may
spawn a flavour-A project and a flavour-B project, or a follow-up CFF
may need to be attached to an existing in-flight project on top of
its new sibling. The link is materialised by
:class:`CFFProjectAssignment` (the M2M through-table) so each link
carries its own audit trail — *who* attached the CFF to *which*
project and *when*.

Schema is denormalised on purpose — the full Wix payload lives in
``raw_payload`` JSONB so the UI can render arbitrary form fields
without us shipping a migration every time a question is added or
renamed in Wix. Field labels (Wix gives us ugly slugs like
``email_fc7d``) are resolved through :class:`WixFormSchemaCache`.
"""

from __future__ import annotations

import uuid

from django.db import models
from django.utils.translation import gettext_lazy as _


class CFFProvenance(models.TextChoices):
    """Where a CFF submission originated.

    ``wix`` — pulled from the public marketing-site form. Anonymous
    (no portal login), synced by the poller, carries every
    ``wix_*`` id field.
    ``portal`` — submitted through the authenticated customer portal.
    Ships from a logged-in :class:`ClientAccount`; the ``wix_*`` id
    columns are NULL for these rows.

    Triage doesn't need to branch on this — both are ``CFFSubmission``
    rows with the same ``raw_payload`` shape and same reject / assign
    lifecycle. The field is here to answer "how did this land in our
    inbox?" for audits + power the ``@Portal`` badge on the row.
    """

    WIX = "wix", _("Wix marketing form")
    PORTAL = "portal", _("Portal (authenticated)")


class CFFSubmissionKind(models.TextChoices):
    """What flavour of engagement this CFF represents.

    ``custom`` is the historical default — a bespoke brief that
    needs R&D. ``ready_to_go`` is a customer picking an existing
    published SKU off the RTG catalog: the submission service
    auto-drafts a Proposal against the source formulation so
    triage only needs to sanity-check + send. ``reorder`` is a
    customer re-buying a Custom formulation they've previously
    signed off — auto-drafts a Proposal that reuses the original
    signed spec sheet by FK so the customer only signs the
    proposal, not the spec.

    Kept as a discriminator (not a computed property) so the
    inbox list can filter without touching ``raw_payload``.
    """

    CUSTOM = "custom", _("Custom brief")
    READY_TO_GO = "ready_to_go", _("Ready-to-Go order")
    REORDER = "reorder", _("Reorder of past Custom")


class CFFSubmissionStatus(models.TextChoices):
    """Mirror of Wix's ``status`` field on a Submission object.

    Wix's enum is open-ended — "UNKNOWN" catches any future status
    the API returns that we haven't taught the codebase about yet so
    a single bad row never breaks the import.
    """

    CONFIRMED = "CONFIRMED", _("Confirmed")
    PENDING = "PENDING", _("Pending")
    PAYMENT_REQUIRED = "PAYMENT_REQUIRED", _("Payment required")
    PAYMENT_PENDING = "PAYMENT_PENDING", _("Payment pending")
    PAYMENT_CANCELED = "PAYMENT_CANCELED", _("Payment canceled")
    UNKNOWN = "UNKNOWN", _("Unknown")


class CFFSubmission(models.Model):
    """One CFF submission, mirrored from Wix.

    ``wix_submission_id`` is the idempotency key — re-imports update
    the existing row in place. ``raw_payload`` is the source of truth
    for what the customer answered; everything else on the row is
    either denormalised lookup data (for filtering / ordering) or
    workspace state we've added on top (assignment, audit).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    organization = models.ForeignKey(
        "organizations.Organization",
        on_delete=models.PROTECT,
        related_name="cff_submissions",
        help_text=_(
            "Org that owns this CFF intake stream. Populated at import "
            "time from settings.WIX_CFF_TARGET_ORGANIZATION_ID."
        ),
    )

    #: Provenance discriminator — see :class:`CFFProvenance`. Every
    #: ``wix_*`` column below is nullable so portal submissions can
    #: skip them; the DB check constraint ``portal_submissions_have_no_wix_id``
    #: keeps the invariant explicit for downstream readers of the
    #: schema (the migration adds one via ``check`` constraint).
    provenance = models.CharField(
        _("provenance"),
        max_length=16,
        choices=CFFProvenance.choices,
        default=CFFProvenance.WIX,
        db_index=True,
        help_text=_(
            "Where the submission originated. Wix rows come from the "
            "public marketing form via the poller; portal rows come "
            "from the authenticated customer portal."
        ),
    )

    #: Wix-side identifiers. ``wix_submission_id`` is the idempotency
    #: key for the poller's ``update_or_create``. NULL for portal
    #: submissions (there's no Wix row to update). ``unique`` still
    #: applies when set — Postgres unique constraints allow multiple
    #: NULLs by default so portal rows don't collide.
    wix_submission_id = models.UUIDField(
        null=True,
        blank=True,
        unique=True,
        help_text=_("Wix's id for the submission. Idempotency key. NULL for portal rows."),
    )
    wix_form_id = models.UUIDField(null=True, blank=True, db_index=True)
    wix_namespace = models.CharField(max_length=64, default="wix.form_app.form")

    wix_status = models.CharField(
        max_length=32,
        choices=CFFSubmissionStatus.choices,
        default=CFFSubmissionStatus.UNKNOWN,
    )

    #: These land on the Wix row from Wix's API; for portal rows the
    #: importer path is bypassed and we stamp them with
    #: ``timezone.now()`` at creation so downstream ordering
    #: (``-wix_created_date``) still sorts consistently.
    wix_created_date = models.DateTimeField(null=True, blank=True)
    wix_updated_date = models.DateTimeField(null=True, blank=True)

    raw_payload = models.JSONField(
        help_text=_(
            "Full form response object. For Wix rows this is the raw "
            "Wix API payload; for portal rows we build the same "
            "slug-keyed ``submissions`` shape so triage renders both "
            "uniformly. Never re-shape into columns or we lose "
            "resilience against form-schema drift."
        ),
    )

    #: The authenticated portal customer who submitted this CFF.
    #: NULL for Wix rows (anonymous marketing-site submissions). The
    #: FK keeps history intact if the ClientAccount is later deleted
    #: (``SET_NULL``) so triage can still see "submitted via portal"
    #: even if the account is gone.
    submitted_by_client_account = models.ForeignKey(
        "client_portal.ClientAccount",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="submitted_cffs",
        help_text=_(
            "Portal customer that authored this submission. NULL when "
            "the CFF came in via Wix (anonymous marketing form)."
        ),
    )

    #: Denormalised customer email lifted from ``raw_payload``. Wix
    #: stores form responses under opaque slugs (``email_fc7d``); the
    #: importer walks the submissions dict for any ``email_*`` key and
    #: copies the first non-empty value here so we can do
    #: indexed lookups by email. Powers "show this customer their own
    #: CFFs" on the portal — the customer portal account matches a
    #: customer by ``Customer.email``, so the denormalised column is
    #: the indexable side of that join.
    #:
    #: Empty string (not ``NULL``) when the submission has no email
    #: field at all — keeps the column non-nullable so we can index
    #: it without a partial index.
    submitter_email = models.EmailField(
        max_length=320,
        blank=True,
        default="",
        db_index=True,
        help_text=_(
            "Customer-typed email harvested from raw_payload at "
            "import time. Empty when the form has no email slug."
        ),
    )

    #: Denormalised customer display name — first_name + last_name
    #: concatenated at import time. Powers the "Link CFF" picker's
    #: search so the query stays index-only instead of walking every
    #: ``raw_payload`` JSON on the tenant. Wix slugs are
    #: ``first_name_*`` / ``last_name_*``; portal rows land the same
    #: values from the wizard's identity step. Empty string when the
    #: submission has neither, matching the same shape as
    #: ``submitter_email`` (non-nullable, indexed).
    submitter_name = models.CharField(
        max_length=300,
        blank=True,
        default="",
        db_index=True,
        help_text=_(
            "First + last name harvested from raw_payload at import "
            "time. Feeds the CFF search picker; the payload is the "
            "source of truth, this column is a cheap lookup."
        ),
    )

    #: Many-to-many link to the workspaces this CFF has been
    #: attached to. Materialised through :class:`CFFProjectAssignment`
    #: so each link carries its own audit (``assigned_by`` /
    #: ``assigned_at``). The empty set is the "still in triage queue"
    #: state — the inbox's headline filter keys on it.
    projects = models.ManyToManyField(
        "formulations.Formulation",
        through="CFFProjectAssignment",
        through_fields=("submission", "project"),
        related_name="cff_submissions",
        blank=True,
    )

    #: Coarse flow discriminator — ``custom`` (bespoke brief, needs
    #: R&D) vs ``ready_to_go`` (customer picked an existing published
    #: SKU off the RTG catalog). Set at creation time by
    #: :func:`create_portal_submission` (custom) or
    #: :func:`create_portal_rtg_submission` (ready_to_go). Wix rows
    #: land as ``custom`` by default.
    submission_kind = models.CharField(
        _("submission kind"),
        max_length=16,
        choices=CFFSubmissionKind.choices,
        default=CFFSubmissionKind.CUSTOM,
        db_index=True,
        help_text=_(
            "Discriminates a bespoke Custom brief from a Ready-to-Go "
            "order off the published catalog. Drives the triage-inbox "
            "badge and, on the customer portal, whether the pending "
            "card reads 'Under review' or 'Awaiting proposal'."
        ),
    )

    #: The Proposal auto-drafted by the RTG submission service.
    #: NULL for Custom rows (no proposal exists until triage creates
    #: one manually). Cleared on proposal delete via ``SET_NULL``
    #: so a rogue delete doesn't cascade the CFFSubmission away.
    drafted_proposal = models.ForeignKey(
        "proposals.Proposal",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="source_rtg_cff_submissions",
        help_text=_(
            "Auto-drafted proposal for RTG submissions. Triage opens "
            "this proposal, sanity-checks the lines, and hits Send — "
            "no re-typing. NULL on Custom rows."
        ),
    )

    imported_at = models.DateTimeField(auto_now_add=True)
    last_synced_at = models.DateTimeField(
        auto_now=True,
        help_text=_("Stamped on every successful re-pull from Wix."),
    )

    #: Triage decision — the alternative to routing a CFF to a project
    #: is rejecting it (spam, duplicate, off-topic, unqualified enquiry).
    #: Rejected submissions leave the main queue but stay on record so
    #: a wrong call can be undone and audits can see who said no + why.
    #: ``rejected_at`` doubles as the "is rejected?" flag — non-null →
    #: rejected. Nulling all three fields un-rejects the submission
    #: back to triage.
    rejected_at = models.DateTimeField(
        null=True,
        blank=True,
        db_index=True,
        help_text=_(
            "Set the moment a triage user marks the CFF as rejected. "
            "NULL means the CFF is either in triage or already assigned."
        ),
    )
    rejected_by = models.ForeignKey(
        "accounts.User",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="rejected_cff_submissions",
        help_text=_(
            "The triage user who rejected the CFF. Nulled on unreject "
            "so subsequent re-rejections don't stack conflicting authorship."
        ),
    )
    rejection_reason = models.TextField(
        blank=True,
        default="",
        help_text=_(
            "Free-text reason shown alongside the row in the rejected "
            "list. Empty when the CFF isn't rejected."
        ),
    )

    class Meta:
        verbose_name = _("CFF submission")
        verbose_name_plural = _("CFF submissions")
        ordering = ("-wix_created_date",)
        indexes = [
            # Primary list view filters by org + recency. The
            # assigned/unassigned filter joins through
            # ``CFFProjectAssignment``, which carries its own
            # ``(submission, project)`` index — see that model's
            # Meta — so we don't duplicate it here.
            models.Index(fields=["organization", "-wix_created_date"]),
            models.Index(fields=["organization", "-wix_updated_date"]),
        ]

    def __str__(self) -> str:
        return f"CFF {self.wix_submission_id} ({self.wix_status})"

    @property
    def is_rejected(self) -> bool:
        """``True`` when this CFF has been rejected via triage."""

        return self.rejected_at is not None

    @property
    def is_assigned(self) -> bool:
        """``True`` when this CFF has at least one project link.

        Callers that already have the assignment set loaded (via
        ``prefetch_related``) get an in-memory check; otherwise this
        triggers one ``EXISTS`` query. List endpoints should annotate
        ``has_assignments`` upstream to avoid the N+1.
        """

        return self.assignments.exists()


class CFFProjectAssignment(models.Model):
    """One CFF ↔ project link with its own audit trail.

    Through-model for :attr:`CFFSubmission.projects`. Each row is
    immutable apart from being created or deleted — re-assigning the
    same CFF to the same project after a detach creates a new row so
    the audit log keeps history. ``assigned_at`` is stamped at
    insert; ``assigned_by`` is the user who triggered the link
    (nullable because the importer or a system path may create one).
    """

    submission = models.ForeignKey(
        CFFSubmission,
        on_delete=models.CASCADE,
        related_name="assignments",
        help_text=_("CFF being attached."),
    )
    project = models.ForeignKey(
        "formulations.Formulation",
        on_delete=models.CASCADE,
        related_name="cff_assignments",
        help_text=_("Project the CFF is being attached to."),
    )
    assigned_by = models.ForeignKey(
        "accounts.User",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
        help_text=_(
            "User who created this link. ``NULL`` for system-driven "
            "links (importer back-fill, future webhook paths)."
        ),
    )
    assigned_at = models.DateTimeField(
        auto_now_add=True,
        help_text=_("Stamped on insert. Use the most recent row to "
                    "answer 'when was this CFF last touched'."),
    )

    class Meta:
        verbose_name = _("CFF project assignment")
        verbose_name_plural = _("CFF project assignments")
        constraints = [
            # One link per (CFF, project) pair. Re-attaching after a
            # detach is supported via delete + insert — the service
            # layer uses ``get_or_create`` so a redundant re-attach
            # is a no-op rather than a constraint violation.
            models.UniqueConstraint(
                fields=("submission", "project"),
                name="cff_assignment_unique_per_pair",
            ),
            # One CFF per project — a project is the origin of a
            # single customer brief. The M2M in the other direction
            # is still legitimate (one CFF, multiple flavour-variant
            # projects) but the project side is now single-owner.
            models.UniqueConstraint(
                fields=("project",),
                name="cff_assignment_unique_per_project",
            ),
        ]
        indexes = [
            # Reverse lookup: "every CFF linked to project X". Covers
            # the project-detail-page sidebar and the
            # ``?project_id=`` list filter.
            models.Index(fields=("project", "-assigned_at")),
        ]
        ordering = ("-assigned_at",)

    def __str__(self) -> str:
        return f"CFF {self.submission_id} → project {self.project_id}"


class WixFormSchemaCache(models.Model):
    """Cached form schema fetched from Wix's Get Form endpoint.

    Lets the UI display human labels ("Email", "Company") instead of
    the Wix-internal slugs ("email_fc7d", "company_name_3ab2"). One
    row per ``(wix_form_id, wix_namespace)``. Refreshed by the
    importer whenever it encounters an unknown field key, or by a
    24h TTL when the importer next runs.
    """

    wix_form_id = models.UUIDField()
    wix_namespace = models.CharField(max_length=64)

    field_labels = models.JSONField(
        help_text=_(
            "Mapping {field_key: human_label}. Looked up by the UI "
            "every time a submission is rendered, so keep it flat."
        ),
    )
    raw_schema = models.JSONField(
        help_text=_("Full schema response — kept for debugging only."),
    )
    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = _("Wix form schema cache")
        verbose_name_plural = _("Wix form schema caches")
        constraints = [
            models.UniqueConstraint(
                fields=["wix_form_id", "wix_namespace"],
                name="cff_wix_form_schema_unique",
            ),
        ]

    def __str__(self) -> str:
        return f"Schema for {self.wix_form_id}"
