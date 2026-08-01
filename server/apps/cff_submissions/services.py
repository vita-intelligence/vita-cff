"""Service layer for the CFF intake.

All write paths into :class:`apps.cff_submissions.models.CFFSubmission`
live here — REST views, Celery tasks, and the management command are
thin shells that delegate. Two responsibilities:

1. **Import** — pull submissions from Wix for one org and upsert
   them into the database. Idempotent and incremental: re-running
   is safe and only emits work for changed rows.
2. **Assignment** — attach (or detach) a CFF to a project. Enforces
   that the target project belongs to the same organisation as the
   CFF; assignment-audit fields are stamped here so the audit trail
   stays consistent across API / admin / future webhook paths.

Permission gating is **not** done here; that's the API layer's job.
Services trust their callers — the views, the task, and the
management command are the only entry points and each handles its
own auth.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable

from django.db import transaction
from django.utils import timezone as django_timezone

from apps.formulations.models import Formulation
from apps.organizations.models import Membership, Organization

from .integration import (
    WixCFFConfig,
    WixCFFDecryptionFailed,
    WixCFFNotConfigured,
    get_wix_cff_config,
    is_wix_cff_live,
    stamp_last_poll,
    stamp_last_tested,
)
from .models import (
    CFFProjectAssignment,
    CFFSubmission,
    CFFSubmissionKind,
    CFFSubmissionStatus,
    WixFormSchemaCache,
)
from .wix_client import WixAPIError, WixClient

logger = logging.getLogger(__name__)


#: Wix slug → role of that field for the "create project from CFF"
#: flow. Pulled into one constant so a future form-side rename is a
#: one-line config change. ``startswith`` semantics: the importer
#: takes the first slug whose prefix matches, so adding more
#: variants is safe.
SALES_PERSON_EMAIL_SLUG_PREFIXES: tuple[str, ...] = (
    "vita_manufacture_account_manager_email",
    "account_manager_email",
)


#: Slug prefix list for the customer's OWN email — the email they
#: typed into the form's contact field. Used at import time to
#: populate :attr:`CFFSubmission.submitter_email`, which the portal
#: then matches against ``Customer.email`` to surface "your CFFs" on
#: the customer's own login.
#:
#: ``email`` is the canonical Wix prefix; the trailing variants
#: cover older form versions some tenants migrated from. The
#: importer takes the first non-empty match.
SUBMITTER_EMAIL_SLUG_PREFIXES: tuple[str, ...] = (
    "email_address",
    "email",
)


def extract_submitter_name(raw_payload: Any) -> str:
    """Pull "first_name last_name" out of a Wix / portal raw_payload.

    Mirrors :func:`extract_submitter_email` — walks the
    ``submissions`` dict for the first ``first_name_*`` and
    ``last_name_*`` slugs, concatenates them, returns an empty
    string when neither is present. The denormalised column that
    consumes this powers the ``/cff-candidates`` picker's search
    without touching ``raw_payload`` at query time.
    """

    submissions = (
        raw_payload.get("submissions")
        if isinstance(raw_payload, dict)
        else None
    )
    if not isinstance(submissions, dict):
        return ""
    first_name = ""
    last_name = ""
    for slug, value in submissions.items():
        if not isinstance(value, str) or not value.strip():
            continue
        lowered = slug.lower()
        if not first_name and lowered.startswith("first_name"):
            first_name = value.strip()
        elif not last_name and lowered.startswith("last_name"):
            last_name = value.strip()
        if first_name and last_name:
            break
    return " ".join(part for part in (first_name, last_name) if part)


def extract_submitter_email(raw_payload: Any) -> str:
    """Pull the customer's own email out of a Wix raw_payload.

    Mirrors :func:`_extract_sales_person_email` but skips any slug
    that's an account-manager / sales-person field — those are the
    Vita employee's email, NOT the customer's. Order of operations
    matters: we walk the submissions dict in insertion order and
    return the first value matching a customer-email prefix that is
    NOT also an account-manager slug.

    Returns an empty string (not ``None``) so the caller can store
    it directly on the model's non-nullable
    :attr:`~CFFSubmission.submitter_email` field without coercing.
    """

    submissions = (
        raw_payload.get("submissions")
        if isinstance(raw_payload, dict)
        else None
    )
    if not isinstance(submissions, dict):
        return ""
    for slug, value in submissions.items():
        # Skip Vita-side account-manager email slugs — those carry
        # the team's email, not the customer's. The customer email
        # is the un-prefixed ``email_*`` slug.
        if any(
            slug.startswith(prefix)
            for prefix in SALES_PERSON_EMAIL_SLUG_PREFIXES
        ):
            continue
        if not any(
            slug.startswith(prefix) for prefix in SUBMITTER_EMAIL_SLUG_PREFIXES
        ):
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


# ---------------------------------------------------------------------------
# Errors surfaced to the API + task layer
# ---------------------------------------------------------------------------


class CFFAssignmentError(RuntimeError):
    """Raised when an assignment would violate a workspace invariant
    (project belongs to a different org, etc.). API maps to 4xx."""


class ProjectAlreadyHasCFF(RuntimeError):
    """Raised when a caller tries to attach a CFF to a project that
    already carries a *different* CFF.

    The workspace convention is one CFF per project — a project is
    the origin of a single customer brief. Attaching the same CFF
    that's already linked is idempotent and doesn't raise; only a
    *different* CFF triggers this.

    The API surfaces this as a 409 with the currently-linked CFF's id
    so the FE can offer "Unlink and replace" without a second lookup.
    """

    def __init__(self, *, existing_submission_id: Any):
        super().__init__(
            "Project already has a different CFF attached."
        )
        self.existing_submission_id = str(existing_submission_id)


class CFFRejectionError(RuntimeError):
    """Raised when a reject/unreject would violate an invariant.

    Two triggers:

    * Rejecting a CFF that's already been routed to a project — the
      two decisions are contradictory. Detach first, then reject.
    * Rejecting with an empty reason — the whole point of storing the
      decision is that the audit trail can answer "why did we say no".
    """


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ImportResult:
    """Summary of one import pass for one org — returned by the
    task, the management command, and the verify endpoint."""

    organization_id: str
    fetched: int
    created: int
    updated: int
    skipped: int
    errors: int


def import_cff_submissions_for_org(
    *,
    organization: Organization,
    client: WixClient | None = None,
) -> ImportResult:
    """Pull every submission for ``organization``'s configured form
    and upsert into the database.

    Looks up the org's :class:`WixCFFConfig` via
    :func:`get_wix_cff_config`; if the integration is off, raises
    :class:`WixCFFNotConfigured` so the task layer can log and skip
    rather than silently dropping a misconfigured org.

    Idempotent: each submission is keyed by ``wix_submission_id``
    so re-runs only emit DB work for rows whose Wix-side state
    drifted (status flip, customer edited, etc.).
    """

    config = get_wix_cff_config(organization=organization)
    client = client or WixClient(api_key=config.api_key, site_id=config.site_id)

    fetched = created = updated = skipped = errors = 0
    for raw in client.iter_submissions(
        form_id=config.form_id,
        namespace=config.namespace,
    ):
        fetched += 1
        try:
            outcome = _upsert_submission(
                raw,
                organization=organization,
                form_id=config.form_id,
                namespace=config.namespace,
            )
        except Exception:
            errors += 1
            logger.exception(
                "cff.import: failed to upsert submission %s for org %s",
                raw.get("id") or raw.get("_id"),
                organization.id,
            )
            continue
        if outcome == "created":
            created += 1
        elif outcome == "updated":
            updated += 1
        else:
            skipped += 1

    # Refresh the field-label cache once per import so the UI never
    # renders a stale slug after a form-side rename. One extra HTTP
    # call per cycle is negligible compared to the page loop above.
    try:
        refresh_field_labels(
            client=client, form_id=config.form_id, namespace=config.namespace,
        )
    except WixAPIError:
        logger.exception(
            "cff.import: failed to refresh form schema cache for org %s "
            "(submissions still imported).",
            organization.id,
        )

    # Stamp the successful poll cycle even when nothing changed —
    # the inbox UI reads ``last_poll_at`` to render "last sync: X
    # ago" so the team can see the system is healthy during quiet
    # periods.
    stamp_last_poll(organization=organization)

    logger.info(
        "cff.import: org=%s fetched=%d created=%d updated=%d skipped=%d errors=%d",
        organization.id, fetched, created, updated, skipped, errors,
    )
    return ImportResult(
        organization_id=str(organization.id),
        fetched=fetched,
        created=created,
        updated=updated,
        skipped=skipped,
        errors=errors,
    )


def iter_orgs_with_live_wix_cff() -> Iterable[Organization]:
    """Yield every org whose Wix CFF integration is enabled + complete.

    The Celery beat task walks this; admin / management commands
    may also use it to scope a manual backfill.
    """

    # The is_live predicate enforces ``enabled`` AND credentials
    # present; we still walk every org because the JSONField shape
    # makes a SQL-level filter awkward and the org count is tiny
    # (single digits in practice).
    for org in Organization.objects.all():
        if is_wix_cff_live(org):
            yield org


#: How stale ``last_poll_at`` must be before
#: :func:`ensure_fresh_submissions` triggers a synchronous Wix pull.
#: Five minutes matches the original Celery beat cadence so the
#: visible "Last sync: X ago" copy still tells the truth.
LAZY_POLL_INTERVAL_SECONDS = 300


def ensure_fresh_submissions(*, organization: Organization) -> None:
    """Synchronously re-pull from Wix when ``last_poll_at`` is stale.

    Called at the top of inbox-facing GET endpoints so the page
    always renders at most ~5 minutes behind Wix without needing a
    background scheduler. The poll runs in the request thread; a
    cold visitor after a quiet window waits a few seconds for the
    Wix roundtrip, every subsequent visitor in the same 5-min
    window hits the local DB.

    Concurrency
    -----------
    Two protections layered together:

    * **Row-level lock via ``select_for_update(skip_locked=True)``** —
      two simultaneous page loads can't both poll. The second
      request finds the row already locked, skips it, and serves
      whatever the first request is about to write.
    * **Pre-stamp ``last_poll_at`` before the HTTP call** — keeps
      a Wix outage from making every visitor block on a 4-second
      timeout. The stamp moves forward whether or not Wix
      responds; the next refresh happens 5 minutes later.

    The transaction is intentionally closed BEFORE the HTTP call.
    Holding a Postgres row lock across a multi-second Wix request
    would tie up a database connection and risks slot exhaustion
    on a busy app (the Dockerfile already calls out a prior
    incident).

    Failure handling
    ----------------
    Any :class:`WixAPIError` / :class:`WixCFFNotConfigured` /
    :class:`WixCFFDecryptionFailed` is logged and swallowed — the
    inbox page must never break because Wix is unreachable. The
    caller still gets whatever's in the DB.
    """

    if not is_wix_cff_live(organization):
        return

    now = django_timezone.now()
    should_poll = False

    with transaction.atomic():
        # ``skip_locked=True`` means "if someone else already holds
        # this row, don't wait — assume they're polling". The other
        # request will write the same data we'd write, so doing it
        # twice is wasted work.
        locked = (
            Organization.objects
            .select_for_update(skip_locked=True)
            .filter(pk=organization.pk)
            .only("id", "wix_cff_config", "updated_at")
            .first()
        )
        if locked is None:
            return
        raw = dict(locked.wix_cff_config or {})
        last = raw.get("last_poll_at")
        if last:
            try:
                last_dt = datetime.fromisoformat(last)
            except ValueError:
                last_dt = None
            if last_dt is not None and (now - last_dt).total_seconds() < LAZY_POLL_INTERVAL_SECONDS:
                return  # fresh — nothing to do
        # Pre-stamp inside the lock. Other requests arriving during
        # the upcoming HTTP call see the fresh timestamp and skip.
        raw["last_poll_at"] = now.isoformat()
        locked.wix_cff_config = raw
        locked.save(update_fields=["wix_cff_config", "updated_at"])
        should_poll = True

    if not should_poll:
        return

    try:
        import_cff_submissions_for_org(organization=organization)
    except (WixCFFNotConfigured, WixCFFDecryptionFailed, WixAPIError) as exc:
        # ``import_cff_submissions_for_org`` only re-stamps
        # ``last_poll_at`` on success; on failure our pre-stamp
        # stays in place, gating the next attempt to 5 minutes
        # out. That stops a Wix outage from turning into a thrash
        # against their API on every page load.
        logger.warning(
            "cff.lazy_poll: refresh failed for org %s — %s",
            organization.id, exc,
        )


def _upsert_submission(
    raw: dict[str, Any],
    *,
    organization: Organization,
    form_id: str,
    namespace: str,
) -> str:
    """Insert or update one row from a raw Wix submission dict.

    Returns ``"created"``, ``"updated"`` or ``"skipped"``.
    """

    submission_id = raw.get("id") or raw.get("_id")
    if not submission_id:
        raise ValueError("Wix submission missing id field")

    status_raw = (raw.get("status") or "").strip().upper()
    if status_raw in CFFSubmissionStatus.values:
        status = status_raw
    else:
        # Don't crash on a status Wix added after we last shipped.
        # The row still imports; the UI surfaces it as "Unknown"
        # until we extend the enum.
        if status_raw:
            logger.warning(
                "cff.import: unknown status %r on submission %s",
                status_raw,
                submission_id,
            )
        status = CFFSubmissionStatus.UNKNOWN

    # Wix returns ``createdDate`` / ``updatedDate`` in the response
    # body. The underscore-prefixed ``_createdDate`` form is for
    # query-side filter/sort field names only — not the payload.
    # Keep the underscore fallbacks for forward-compat in case Wix
    # ever rolls the names back together.
    created_date = _parse_wix_datetime(
        raw.get("createdDate") or raw.get("_createdDate")
    )
    updated_date = _parse_wix_datetime(
        raw.get("updatedDate") or raw.get("_updatedDate")
    ) or created_date

    if created_date is None:
        raise ValueError(
            f"Wix submission {submission_id} missing createdDate"
        )
    if updated_date is None:
        updated_date = created_date

    defaults: dict[str, Any] = {
        "organization": organization,
        "wix_form_id": form_id,
        "wix_namespace": namespace,
        "wix_status": status,
        "wix_created_date": created_date,
        "wix_updated_date": updated_date,
        "raw_payload": raw,
        # Lifted from raw_payload on every upsert so a Wix-side
        # edit that changes the customer's email re-syncs into the
        # denormalised column. Stored lowercase via the field's own
        # ``EmailField`` validators? — Django's EmailField doesn't
        # lowercase; we leave the original casing and rely on the
        # ``__iexact`` lookups the portal does.
        "submitter_email": extract_submitter_email(raw),
        "submitter_name": extract_submitter_name(raw),
    }

    obj, was_created = CFFSubmission.objects.update_or_create(
        wix_submission_id=submission_id,
        defaults=defaults,
    )
    if was_created:
        return "created"
    del obj
    return "updated"


def _parse_wix_datetime(value: Any) -> datetime | None:
    """Parse a Wix ISO-8601 datetime string into an aware datetime."""

    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    candidate = value.rstrip("Z")
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


# ---------------------------------------------------------------------------
# Schema (field-label cache)
# ---------------------------------------------------------------------------


def refresh_field_labels(
    *,
    client: WixClient,
    form_id: str,
    namespace: str,
) -> WixFormSchemaCache:
    """Pull the form schema from Wix and store the slug → label map."""

    raw_schema = client.get_form(form_id)
    field_labels = _extract_field_labels(raw_schema)
    cache, _ = WixFormSchemaCache.objects.update_or_create(
        wix_form_id=form_id,
        wix_namespace=namespace,
        defaults={
            "field_labels": field_labels,
            "raw_schema": raw_schema,
        },
    )
    return cache


_SLUG_TAIL_RE = re.compile(r"_[a-f0-9]{2,8}$")


def _extract_field_labels(raw_schema: dict[str, Any]) -> dict[str, str]:
    """Walk a Wix form schema and produce a flat ``{slug: label}`` map.

    Wix nests fields under ``form.fields`` or ``form.steps[].fields``
    depending on which UI the form was built in. We accept both
    shapes and fall back to a slug-prettifier so an unknown shape
    still produces something human-readable.
    """

    labels: dict[str, str] = {}
    form_body = raw_schema.get("form") or raw_schema
    for field in form_body.get("fields") or []:
        _absorb_field(field, labels)
    for step in form_body.get("steps") or []:
        for field in step.get("fields") or []:
            _absorb_field(field, labels)
    return labels


def _absorb_field(field: dict[str, Any], labels: dict[str, str]) -> None:
    """Pull a ``(slug, label)`` pair out of one field definition."""

    target = field.get("target") or field.get("identifier") or field.get("name")
    label = (
        field.get("label")
        or field.get("title")
        or (field.get("properties") or {}).get("label")
    )
    if not target:
        return
    if not label:
        # Best-effort prettifier: drop the trailing 4-hex-char suffix
        # Wix appends to slugs, replace underscores with spaces,
        # capitalise the result.
        stripped = _SLUG_TAIL_RE.sub("", target)
        label = stripped.replace("_", " ").strip().title() or target
    labels[target] = label


def get_field_labels(*, form_id: str, namespace: str) -> dict[str, str]:
    """Return the cached ``{slug: label}`` map for a form, or ``{}``
    if the cache is empty (the UI then falls back to the slug). The
    list endpoint serialises this alongside each submission so the
    client doesn't have to fan out one schema fetch per render.
    """

    try:
        cache = WixFormSchemaCache.objects.get(
            wix_form_id=form_id, wix_namespace=namespace,
        )
    except WixFormSchemaCache.DoesNotExist:
        return {}
    return cache.field_labels or {}


# ---------------------------------------------------------------------------
# Verify (settings-page Test button)
# ---------------------------------------------------------------------------


def verify_wix_cff_connection(*, organization: Organization, actor: Any) -> int:
    """Hit the Wix Count endpoint once to prove the credentials work.

    Stamps ``last_tested_at`` on success so the settings card can
    render "Connected" instead of the amber "Credentials saved —
    test" state. Returns the count so the frontend can show "X
    submissions discovered".

    Raises :class:`WixCFFNotConfigured` if the integration is
    disabled / incomplete, :class:`WixCFFDecryptionFailed` if the
    stored secret can't be decrypted, and :class:`WixAPIError` for
    network or HTTP failures.
    """

    config = get_wix_cff_config(organization=organization)
    if not config.is_complete:
        raise WixCFFNotConfigured(
            "Wix CFF config is missing one or more required fields."
        )
    client = WixClient(api_key=config.api_key, site_id=config.site_id)
    total = client.count_submissions(
        form_id=config.form_id, namespace=config.namespace,
    )
    stamp_last_tested(organization=organization)
    return total


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------


@transaction.atomic
def detach_from_project(
    *,
    submission: CFFSubmission,
    project: Formulation,
    actor: Any,
) -> CFFSubmission:
    """Remove the CFF ↔ project link (idempotent — no-op when the
    link never existed).

    Kept as an explicit service (rather than a raw M2M .remove()) so
    the audit hook + ``last_synced_at`` bump run in the same place as
    :func:`assign_to_project`. ``actor`` is currently only used for
    the ``last_synced_at`` write ordering; if we later start
    recording detach rows the same actor slot is already in the
    signature.
    """

    if project.organization_id != submission.organization_id:
        raise CFFAssignmentError(
            "Project belongs to a different organisation than the CFF."
        )

    CFFProjectAssignment.objects.filter(
        submission=submission, project=project
    ).delete()
    submission.save(update_fields=("last_synced_at",))

    # Tell PSP the CFF is no longer attached to this project so its
    # project page mirrors what the scientist sees on NPD. Fires on
    # commit; silent-degrade at the PSP service boundary.
    fid = project.pk

    def _fire_cff_detached_sync() -> None:
        from apps.formulations.models import Formulation as _F
        from apps.psp.services import sync_customer_order_to_psp

        try:
            fresh = _F.objects.select_related(
                "customer", "lead_scientist", "sales_person", "organization"
            ).get(pk=fid)
            sync_customer_order_to_psp(formulation=fresh, cff_cleared=True)
        except Exception:
            import logging

            logging.getLogger(__name__).exception(
                "cff-detached: sync_customer_order_to_psp bubbled "
                "for formulation %s",
                fid,
            )

    transaction.on_commit(_fire_cff_detached_sync)
    return submission


def assign_to_project(
    *,
    submission: CFFSubmission,
    project: Formulation,
    actor: Any,
    can_assign_sales_person: bool = False,
) -> CFFSubmission:
    """Attach ``submission`` to ``project`` (additive — does not
    detach any existing links).

    Both must belong to the same organisation. Assigning a CFF to a
    project in a different tenant is a hard error, not best-effort.
    Re-attaching the same pair is idempotent: the existing
    :class:`CFFProjectAssignment` row is touched (``assigned_at``
    refreshed, ``assigned_by`` set to the current actor) so the
    audit log still reflects the latest decision, but no duplicate
    link is created — the unique constraint on (submission, project)
    would reject one anyway.

    When ``can_assign_sales_person`` is true AND the project does not
    already have a sales person, this also runs the same
    Account-Manager-Email → team-member resolution path that
    :func:`create_project_from_cff` does, so attaching a CFF to a
    bare project carries the customer-typed sales lead onto the
    project automatically. The empty-slot guard is deliberate: a
    deliberate manual assignment on the project must not be
    silently overwritten by a later CFF attach. Callers that do
    their own sales-person resolution downstream (notably
    :func:`create_project_from_cff`, which always resolves on the
    fresh project) keep this disabled so the two paths don't
    double-assign.
    """

    if project.organization_id != submission.organization_id:
        raise CFFAssignmentError(
            "Project belongs to a different organisation than the CFF."
        )

    # One-CFF-per-project invariant. Re-attaching the same CFF is
    # idempotent (falls through to the ``get_or_create`` below); a
    # *different* CFF triggers ``ProjectAlreadyHasCFF`` so the FE can
    # render a "Unlink and replace" affordance without a preflight
    # lookup. The DB carries a matching ``UniqueConstraint`` on
    # ``project`` alone as defence in depth against a race.
    existing = (
        CFFProjectAssignment.objects.filter(project=project)
        .exclude(submission=submission)
        .values_list("submission_id", flat=True)
        .first()
    )
    if existing is not None:
        raise ProjectAlreadyHasCFF(existing_submission_id=existing)

    assignment, created = CFFProjectAssignment.objects.get_or_create(
        submission=submission,
        project=project,
        defaults={"assigned_by": actor},
    )
    if not created:
        # Touch the existing row so the audit trail reflects the
        # most recent operator + timestamp. ``assigned_at`` carries
        # ``auto_now_add=True`` so a plain ``save()`` won't update
        # it — we go through the queryset path instead.
        CFFProjectAssignment.objects.filter(pk=assignment.pk).update(
            assigned_by=actor,
            assigned_at=django_timezone.now(),
        )
    # Bump ``last_synced_at`` so the inbox list refresh shows the
    # row as recently touched. The legacy single-FK path used to do
    # this implicitly via ``update_fields``; keep parity now.
    submission.save(update_fields=("last_synced_at",))

    # Empty-slot auto-assign. ``sales_person_id`` is read off the
    # already-loaded project row so we don't refetch — the value is
    # accurate as of the start of this atomic block, which is
    # exactly the moment that should arbitrate "is anyone already
    # on this project". Capability check on the actor is performed
    # by :func:`assign_sales_person` itself (raises
    # ``SalesPersonNotMember`` if the resolved user isn't a member,
    # which we treat as "no match" and proceed).
    if can_assign_sales_person and project.sales_person_id is None:
        # Lazy import — same justification as
        # :func:`create_project_from_cff`. The formulations service
        # pulls a wide dep graph that cff-side unit tests
        # deliberately don't load.
        from apps.formulations.services import (
            SalesPersonNotMember,
            assign_sales_person,
        )

        sales_email = _extract_sales_person_email(submission)
        if sales_email:
            resolved_user = _resolve_sales_person(
                organization=submission.organization,
                email=sales_email,
            )
            if resolved_user is not None:
                try:
                    assign_sales_person(
                        formulation=project,
                        sales_person=resolved_user,
                        actor=actor,
                    )
                except SalesPersonNotMember:
                    # Belt-and-braces against a TOCTOU between the
                    # membership lookup and the assign call. Treat
                    # as "no match" — the attach still succeeded.
                    pass

    # Mirror the fresh link over to PSP so the project page there
    # gains the "who asked for this?" context. Fires on commit so
    # a rollback (rare here) doesn't tell PSP about a link the
    # database threw away. Silent-degrade at the PSP boundary.
    fid = project.pk
    sid = submission.pk

    def _fire_cff_attached_sync() -> None:
        from apps.cff_submissions.models import CFFSubmission
        from apps.formulations.models import Formulation as _F
        from apps.psp.services import sync_customer_order_to_psp

        try:
            fresh_project = _F.objects.select_related(
                "customer", "lead_scientist", "sales_person", "organization"
            ).get(pk=fid)
            fresh_cff = CFFSubmission.objects.get(pk=sid)
            sync_customer_order_to_psp(
                formulation=fresh_project,
                linked_cff=fresh_cff,
            )
        except Exception:
            import logging

            logging.getLogger(__name__).exception(
                "cff-attached: sync_customer_order_to_psp bubbled "
                "for formulation %s cff %s",
                fid,
                sid,
            )

    transaction.on_commit(_fire_cff_attached_sync)

    return submission


@transaction.atomic
def unassign(
    *,
    submission: CFFSubmission,
    actor: Any,
    project: Formulation | None = None,
) -> CFFSubmission:
    """Detach a CFF from a project link.

    Two modes:

    * ``project=None`` (default) — remove **every** link the CFF has.
      Equivalent to the legacy single-FK ``unassign`` behaviour, and
      what the inbox-row "unassign" button calls when the operator
      just wants to send the CFF back to triage.
    * ``project=<Formulation>`` — remove only that one link. Used by
      the per-row "remove from this project" action on the detail
      modal, so the other links the CFF holds keep their audit rows
      intact.

    Passing a project that isn't currently linked is a silent no-op —
    the queryset delete touches zero rows. ``actor`` isn't recorded
    on the row (the row is gone) but the surrounding audit log
    captures who initiated the call.

    The CFF's ``last_synced_at`` is still bumped so the inbox list
    sort reflects the recency of this operation.
    """

    qs = CFFProjectAssignment.objects.filter(submission=submission)
    if project is not None:
        qs = qs.filter(project=project)
    qs.delete()
    submission.save(update_fields=("last_synced_at",))
    return submission


# ---------------------------------------------------------------------------
# Reject / unreject — triage's "not our problem" verdict
# ---------------------------------------------------------------------------


#: Maximum length of the reject reason. Enough for a paragraph — this
#: is an internal note, not a customer-facing letter. Enforced at the
#: service so a shorter DB column can't sneak past this guard.
_MAX_REJECTION_REASON = 2000


@transaction.atomic
def reject(
    *,
    submission: CFFSubmission,
    actor: Any,
    reason: str,
) -> CFFSubmission:
    """Mark ``submission`` as rejected with ``reason``.

    Rejecting takes the CFF out of the triage queue and files it in
    the Rejected tab so it stops re-appearing in the operator's
    face — the alternative to routing it to a project. Idempotent
    on the "already rejected" side; a second call with the same
    submission refreshes the timestamp + actor + reason (so a
    corrected note replaces the old one and the audit trail shows
    who last touched it).

    Guards:

    * The reason must be a non-blank string. Silent-empty rejections
      would defeat the entire audit purpose.
    * The CFF must not currently be assigned to any project. Under
      the M2M model a CFF can be routed AND rejected in theory, but
      that combination reads as a contradiction — the routing means
      "yes we picked this up" and the reject means "no we didn't".
      Detach first, then reject.
    """

    from apps.audit.services import record as record_audit

    trimmed = (reason or "").strip()
    if not trimmed:
        raise CFFRejectionError("A rejection reason is required.")
    if len(trimmed) > _MAX_REJECTION_REASON:
        raise CFFRejectionError(
            f"Rejection reason too long ({len(trimmed)} > "
            f"{_MAX_REJECTION_REASON} characters)."
        )
    if submission.assignments.exists():
        raise CFFRejectionError(
            "Detach the CFF from all projects before rejecting it."
        )

    before = {
        "rejected_at": (
            submission.rejected_at.isoformat()
            if submission.rejected_at is not None
            else None
        ),
        "rejection_reason": submission.rejection_reason,
    }
    submission.rejected_at = django_timezone.now()
    submission.rejected_by = actor if hasattr(actor, "pk") else None
    submission.rejection_reason = trimmed
    submission.save(
        update_fields=(
            "rejected_at",
            "rejected_by",
            "rejection_reason",
            "last_synced_at",
        ),
    )
    record_audit(
        organization=submission.organization,
        actor=actor,
        action="cff_submission.reject",
        target=submission,
        before=before,
        after={
            "rejected_at": submission.rejected_at.isoformat(),
            "rejection_reason": trimmed,
        },
    )
    return submission


@transaction.atomic
def unreject(
    *,
    submission: CFFSubmission,
    actor: Any,
) -> CFFSubmission:
    """Un-reject a previously-rejected CFF.

    Nulls all three reject fields and sends the CFF back to the
    Unassigned queue so triage can decide again. Idempotent on the
    "not rejected" side — calling on a fresh CFF is a no-op with an
    audit row still written (so the log answers "did anyone touch
    this and pull it back?").
    """

    from apps.audit.services import record as record_audit

    was_rejected = submission.rejected_at is not None
    before = {
        "rejected_at": (
            submission.rejected_at.isoformat()
            if submission.rejected_at is not None
            else None
        ),
        "rejection_reason": submission.rejection_reason,
    }
    submission.rejected_at = None
    submission.rejected_by = None
    submission.rejection_reason = ""
    submission.save(
        update_fields=(
            "rejected_at",
            "rejected_by",
            "rejection_reason",
            "last_synced_at",
        ),
    )
    if was_rejected:
        record_audit(
            organization=submission.organization,
            actor=actor,
            action="cff_submission.unreject",
            target=submission,
            before=before,
            after={"rejected_at": None, "rejection_reason": ""},
        )
    return submission


# ---------------------------------------------------------------------------
# Portal-authored CFF submissions
# ---------------------------------------------------------------------------
#
# Portal submissions land here from the authenticated customer portal
# rather than the Wix marketing form. They ship as a typed payload
# (see :class:`PortalSubmissionInput` below) and get flattened into
# the same slug-keyed ``submissions`` dict Wix produces, so the
# triage inbox, comments dock, list_customer_cffs, and every downstream
# consumer read both shapes without branching.
#
# The slugs below are the canonical portal names — flat, snake_case,
# no Wix-style ``_fc7d`` random suffix. The FE field-label rendering
# falls back to slug prettification when a label isn't in the schema
# cache, so a portal row displays cleanly without a bespoke label
# table.


class CFFPortalError(RuntimeError):
    """Raised when a portal submission would violate an invariant
    (unknown client account, empty required field, etc.). API maps
    to 4xx. Distinct from :class:`CFFAssignmentError` /
    :class:`CFFRejectionError` so the FE toast copy can differentiate."""


#: Canonical slug for the "who's your Vita account manager?" field
#: on portal submissions. Wix uses ``vita_manufacture_account_manager_email``;
#: we keep the same suffix so :func:`_extract_sales_person_email` picks
#: it up without a special case.
_PORTAL_SLUG_SALES_PERSON_EMAIL = "vita_manufacture_account_manager_email"


#: Canonical slug for the customer's own email. Also matched by
#: :data:`SUBMITTER_EMAIL_SLUG_PREFIXES` for the denormalised
#: ``submitter_email`` column.
_PORTAL_SLUG_EMAIL = "email"


@dataclass(frozen=True)
class PortalSubmissionInput:
    """Structured input for :func:`create_portal_submission`.

    Every field is optional at the type level — the service layer
    enforces required-ness with a single validator so we can produce
    field-scoped error dicts the FE can attach to the right input.
    """

    # Step 1 — General information
    first_name: str = ""
    last_name: str = ""
    email: str = ""
    phone: str = ""
    company_name: str = ""

    # Step 2 — Product information
    product_formats: tuple[str, ...] = ()
    market_segment: str = ""
    dose: str = ""
    nutritional_requirements: tuple[str, ...] = ()
    target_sex: tuple[str, ...] = ()
    target_age: tuple[str, ...] = ()
    other_nutritional_requirements: str = ""

    # Step 3 — Formulation
    dose_per_unit: str = ""
    actives_requirements: str = ""

    # Step 4 — Packaging
    primary_package_type: str = ""
    quantity_to_be_quoted: str = ""

    # Step 5 — Address
    country_region: str = ""
    address: str = ""
    city: str = ""
    postal_code: str = ""
    delivery_same_as_proposal: str = ""  # "yes" | "no" | ""

    # Step 6 — Signoff
    account_manager_email: str = ""


#: Fields that must be non-blank for a portal submission to save.
#: Mirrors the ``*`` markers on the Wix form so the two flows enforce
#: the same minimum quality bar.
_REQUIRED_PORTAL_FIELDS: tuple[tuple[str, str], ...] = (
    ("first_name", "First name"),
    ("last_name", "Last name"),
    ("email", "Email"),
    ("company_name", "Company name"),
    ("dose", "Dose"),
    ("primary_package_type", "Primary package type"),
    ("quantity_to_be_quoted", "Quantity to be quoted"),
    ("country_region", "Country / region"),
    ("address", "Address"),
    ("city", "City"),
    ("postal_code", "Postal code"),
)


def _portal_input_to_submissions(inp: PortalSubmissionInput) -> dict[str, Any]:
    """Flatten the typed input into the slug-keyed ``submissions``
    dict Wix produces. Keys are stable snake_case slugs; multi-choice
    fields collapse to a comma-separated string so a schema-agnostic
    reader can still show them.

    Empty strings survive the flatten so the triage inbox can render
    "—" instead of hiding the field. Multi-choice tuples with no
    picks land as ``""`` for the same reason.
    """

    def _join(values: tuple[str, ...]) -> str:
        return ", ".join(v for v in values if v)

    return {
        # General information
        "first_name": inp.first_name.strip(),
        "last_name": inp.last_name.strip(),
        _PORTAL_SLUG_EMAIL: inp.email.strip().lower(),
        "phone": inp.phone.strip(),
        "company_name": inp.company_name.strip(),
        # Product
        "product_format": _join(inp.product_formats),
        "market_segment": inp.market_segment.strip(),
        "dose": inp.dose.strip(),
        "nutritional_requirements": _join(inp.nutritional_requirements),
        "target_sex": _join(inp.target_sex),
        "target_age": _join(inp.target_age),
        "other_nutritional_requirements": inp.other_nutritional_requirements.strip(),
        # Formulation
        "dose_per_unit": inp.dose_per_unit.strip(),
        "actives_requirements": inp.actives_requirements.strip(),
        # Packaging
        "primary_package_type": inp.primary_package_type.strip(),
        "quantity_to_be_quoted": inp.quantity_to_be_quoted.strip(),
        # Address
        "country_region": inp.country_region.strip(),
        "address": inp.address.strip(),
        "city": inp.city.strip(),
        "postal_code": inp.postal_code.strip(),
        "delivery_same_as_proposal": inp.delivery_same_as_proposal.strip(),
        # Signoff — same slug as Wix so the sales-person resolver
        # picks it up without a special case.
        _PORTAL_SLUG_SALES_PERSON_EMAIL: inp.account_manager_email.strip().lower(),
    }


@transaction.atomic
def create_portal_submission(
    *,
    client_account: Any,
    payload: PortalSubmissionInput,
) -> CFFSubmission:
    """Create a CFFSubmission from an authenticated portal customer.

    The row lands in the triage queue immediately (provenance=portal,
    no Wix ids). ``raw_payload`` is shaped like a Wix response so
    every downstream reader — triage inbox, list_customer_cffs, the
    portal detail page — works without branching.

    Failure modes:

    * Missing required fields -> ``CFFPortalError`` with a
      per-field errors dict the API layer surfaces as 422.
    * Missing ``client_account.customer.organization`` -> the
      submission has no valid tenant to land in; refuse with a
      generic ``CFFPortalError``.
    """

    field_errors: dict[str, str] = {}
    for field_name, label in _REQUIRED_PORTAL_FIELDS:
        value = getattr(payload, field_name, "") or ""
        if not str(value).strip():
            field_errors[field_name] = f"{label} is required."

    if field_errors:
        exc = CFFPortalError("Fill in every required field before submitting.")
        exc.field_errors = field_errors  # type: ignore[attr-defined]
        raise exc

    # Resolve the tenant off the customer row on the account. Portal
    # accounts are 1:1 with a customer today; if that guarantee ever
    # breaks the API layer will need to pick which tenant to route to.
    customer = getattr(client_account, "customer", None)
    if customer is None or customer.organization_id is None:
        raise CFFPortalError(
            "This portal account isn't attached to a customer yet — "
            "reach out to your account manager to get set up.",
        )

    now = django_timezone.now()
    submissions = _portal_input_to_submissions(payload)

    submission = CFFSubmission.objects.create(
        organization_id=customer.organization_id,
        provenance="portal",
        submission_kind=CFFSubmissionKind.CUSTOM,
        # Portal rows carry no Wix ids; the fields are nullable now.
        wix_submission_id=None,
        wix_form_id=None,
        wix_namespace="",
        wix_status="",
        wix_created_date=now,
        wix_updated_date=now,
        raw_payload={
            "submissions": submissions,
            # Match the top-level Wix envelope shape so tests / readers
            # walking the payload don't hit an unfamiliar structure.
            "_meta": {
                "provenance": "portal",
                "submitted_at": now.isoformat(),
                "submitted_by_client_account_id": str(client_account.pk),
            },
        },
        submitter_email=payload.email.strip().lower(),
        submitter_name=" ".join(
            part
            for part in (
                payload.first_name.strip(),
                payload.last_name.strip(),
            )
            if part
        ),
        submitted_by_client_account=client_account,
    )
    return submission


# ---------------------------------------------------------------------------
# "Create project from CFF" — one-click triage path
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CreateFromCFFResult:
    """Return shape for :func:`create_project_from_cff`.

    The frontend uses every field of this — ``project`` to navigate,
    ``cff`` to refresh the inbox view, and the two ``sales_person``
    fields to render an outcome-specific toast (auto-assigned to X,
    or "no team member matched the customer's account-manager
    email Y — assign manually" if the match failed).
    """

    project: Formulation
    submission: CFFSubmission
    auto_assigned_sales_person_id: str | None
    auto_assigned_sales_person_email: str | None
    #: Email harvested from the CFF payload, even when the match
    #: failed. The UI surfaces it so a triager can decide whether to
    #: chase the customer for a corrected email or just assign by
    #: hand.
    cff_sales_person_email_hint: str | None


def _extract_sales_person_email(submission: CFFSubmission) -> str | None:
    """Pull the customer-typed sales-person email out of the CFF
    payload. Returns ``None`` if the field is missing or blank so
    the caller can decide on the fallback path."""

    submissions = (
        submission.raw_payload.get("submissions")
        if isinstance(submission.raw_payload, dict)
        else None
    )
    if not isinstance(submissions, dict):
        return None
    for slug, value in submissions.items():
        if not any(
            slug.startswith(prefix) for prefix in SALES_PERSON_EMAIL_SLUG_PREFIXES
        ):
            continue
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _resolve_sales_person(
    *,
    organization: Organization,
    email: str,
) -> Any | None:
    """Look up the org member whose email matches ``email`` (case-
    insensitive). Returns ``None`` if no member matches — the
    caller treats that as "no auto-assignment", not an error.
    """

    membership = (
        Membership.objects
        .select_related("user")
        .filter(
            organization=organization,
            user__email__iexact=email.strip(),
        )
        .first()
    )
    return membership.user if membership else None


@transaction.atomic
def create_project_from_cff(
    *,
    submission: CFFSubmission,
    actor: Any,
    name: str,
    code: str,
    description: str = "",
    dosage_form: str | None = None,
    capsule_size: str = "",
    tablet_size: str = "",
    serving_size: int = 1,
    servings_per_pack: int = 60,
    directions_of_use: str = "",
    suggested_dosage: str = "",
    appearance: str = "",
    disintegration_spec: str = "",
    target_fill_weight_mg: Any | None = None,
    powder_type: str = "",
    water_volume_ml: Any | None = None,
    can_assign_sales_person: bool = True,
) -> CreateFromCFFResult:
    """Triage shortcut: create a project, attach the CFF to it, and
    (when possible) auto-assign the sales person inferred from the
    customer's ``vita_manufacture_account_manager_email`` field.

    Failure modes:

    * Project creation errors propagate as their original DRF-mapped
      exceptions (``ValidationError``, etc.) — same contract as the
      manual new-project form.
    * Sales-person auto-assignment is a **best-effort** side-effect:
      missing field, missing member, or actor lacking the
      ``formulations.assign_sales_person`` capability all silently
      skip the assign and surface the outcome in the result so the
      UI can tell the user.

    All three operations (create / attach / assign) run inside one
    transaction so a partial state can't survive — if anything
    bombs, none of the three writes commit.
    """

    # Import lazily so a unit test that mocks formulation creation
    # doesn't have to import the world.
    from apps.formulations.services import (
        SalesPersonNotMember,
        assign_sales_person,
        create_formulation,
    )

    # Only pass through fields the operator actually filled in;
    # ``create_formulation`` has its own validated defaults
    # (``powder_type=standard`` etc.) and threading an empty
    # string would trip a stricter validator.
    kwargs: dict[str, Any] = {
        "organization": submission.organization,
        "actor": actor,
        "name": name,
        "code": code,
        "description": description,
        "serving_size": serving_size,
        "servings_per_pack": servings_per_pack,
    }
    optional_strings = {
        "capsule_size": capsule_size,
        "tablet_size": tablet_size,
        "directions_of_use": directions_of_use,
        "suggested_dosage": suggested_dosage,
        "appearance": appearance,
        "disintegration_spec": disintegration_spec,
        "powder_type": powder_type,
    }
    for key, value in optional_strings.items():
        if value:
            kwargs[key] = value
    if dosage_form:
        kwargs["dosage_form"] = dosage_form
    if target_fill_weight_mg is not None:
        kwargs["target_fill_weight_mg"] = target_fill_weight_mg
    if water_volume_ml is not None:
        kwargs["water_volume_ml"] = water_volume_ml

    project = create_formulation(**kwargs)

    assign_to_project(submission=submission, project=project, actor=actor)
    submission.refresh_from_db()

    sales_email = _extract_sales_person_email(submission)
    resolved_user = None
    if sales_email and can_assign_sales_person:
        resolved_user = _resolve_sales_person(
            organization=submission.organization, email=sales_email,
        )
        if resolved_user is not None:
            try:
                assign_sales_person(
                    formulation=project,
                    sales_person=resolved_user,
                    actor=actor,
                )
            except SalesPersonNotMember:
                # Membership check inside ``assign_sales_person`` is
                # belt-and-braces against a TOCTOU between our
                # ``_resolve_sales_person`` query and the assign
                # call. Treat the same as "no match".
                resolved_user = None

    return CreateFromCFFResult(
        project=project,
        submission=submission,
        auto_assigned_sales_person_id=(
            str(resolved_user.id) if resolved_user else None
        ),
        auto_assigned_sales_person_email=(
            resolved_user.email if resolved_user else None
        ),
        cff_sales_person_email_hint=sales_email,
    )


# ---------------------------------------------------------------------------
# Customer portal — "show this customer their own CFFs"
# ---------------------------------------------------------------------------


def list_customer_cffs(*, client_account) -> QuerySet[CFFSubmission]:
    """Return every CFFSubmission the logged-in portal customer
    should be able to read.

    Ownership rule (union of two paths — :func:`PortalCommentConsumer
    ._authorise_portal` enforces the same rule on the WS side):

    * **Email match** — ``CFFSubmission.submitter_email`` matches
      the parent ``Customer.email`` case-insensitively. The
      denormalised email column is populated at import time from
      the customer's own form entry, so this catches every CFF the
      customer submitted with their portal-account email — even
      the ones still in the unassigned-intake state.
    * **Project link** — the CFF was assigned to a project that
      has at least one proposal owned by this customer's
      :class:`Customer` row. Catches the case where the customer
      typed a different email originally (typo, work vs personal)
      but the team has since wired the CFF into one of their
      projects.

    Defaults are conservative: an empty ``customer.email`` skips
    the email-match branch entirely so we don't return every CFF
    with an empty ``submitter_email``. Returns a queryset (not a
    list) so the caller can paginate / annotate / ``.select_related``
    as needed.
    """

    from apps.client_portal.queries import customer_ids_for_account
    from apps.customers.models import Customer

    customer_id = getattr(client_account, "customer_id", None)
    if not customer_id:
        return CFFSubmission.objects.none()

    customer = Customer.objects.filter(id=customer_id).first()
    if customer is None:
        return CFFSubmission.objects.none()

    # Widen the customer scope to every sibling Customer row in the
    # same org that shares the account's email — survives the
    # duplicate-customer footprint until the Phase 4 sweep collapses
    # them. The project-link leg below filters on the union; the
    # email-match leg already accumulates every alias on the
    # canonical row below.
    owner_ids = customer_ids_for_account(client_account)

    # Both legs scope to the customer's organisation. Without this
    # a stray CFF in a sibling tenant could theoretically match
    # (no real risk today since portal accounts are 1:1 with a
    # single tenant, but the explicit scope keeps the invariant
    # readable in the query plan).
    org_id = customer.organization_id

    from django.db.models import Q

    # Build the set of addresses this customer has ever used so a
    # portal-side email change doesn't silently hide historical CFFs.
    # Canonical ``Customer.email`` plus every row in
    # :class:`CustomerEmailAlias` — the alias table archives prior
    # addresses each time the customer rotates their portal email
    # (see :func:`apps.client_portal.profile_services
    # .confirm_email_change`).
    #
    # We lower-case everything and dedupe so a customer who
    # ping-pongs between cases still hits exactly one branch of the
    # OR, and ``submitter_email__iexact`` per address handles the
    # case-insensitivity on the join side too.
    candidate_emails: set[str] = set()
    if customer.email:
        candidate_emails.add(customer.email.strip().lower())
    candidate_emails.update(
        alias.lower()
        for alias in customer.email_aliases
        .values_list("email", flat=True)
        if alias and alias.strip()
    )
    # Sibling Customer rows (the duplicate-customer footprint) may
    # carry their own email + aliases; fold them in too so a CFF
    # submitted under the sibling row's address still surfaces.
    sibling_ids = [cid for cid in owner_ids if cid != customer_id]
    if sibling_ids:
        from apps.customers.models import CustomerEmailAlias

        sibling_emails = Customer.objects.filter(
            id__in=sibling_ids,
        ).values_list("email", flat=True)
        for raw in sibling_emails:
            if raw and raw.strip():
                candidate_emails.add(raw.strip().lower())
        sibling_aliases = CustomerEmailAlias.objects.filter(
            customer_id__in=sibling_ids,
        ).values_list("email", flat=True)
        for raw in sibling_aliases:
            if raw and raw.strip():
                candidate_emails.add(raw.strip().lower())

    email_filter = Q(pk__in=[])  # always-empty seed
    for addr in candidate_emails:
        email_filter |= Q(submitter_email__iexact=addr)

    # CFFSubmission ↔ Formulation is now M2M (``projects``). From
    # any linked formulation the path to a Proposal is via that
    # formulation's saved versions: each Proposal pins against a
    # ``FormulationVersion`` (the snapshot it quotes), and
    # FormulationVersion has a ``formulation`` FK back to
    # Formulation. Reverse-related-name walk:
    # ``cff.projects.versions.proposals.customer_id``. Django turns
    # the M2M traversal into a join, so a CFF linked to *any*
    # project owned by this customer matches — exactly the
    # semantics the portal wants.
    project_filter = Q(
        projects__versions__proposals__customer_id__in=owner_ids,
    )

    return (
        CFFSubmission.objects
        .filter(organization_id=org_id)
        .filter(email_filter | project_filter)
        .distinct()
        .order_by("-wix_created_date")
    )


def get_customer_cff(*, client_account, submission_id) -> CFFSubmission | None:
    """Single-row variant of :func:`list_customer_cffs`. Returns
    ``None`` when the CFF doesn't exist OR fails the ownership
    union, so the portal view can map both to a single 404 without
    leaking which case it hit."""

    return list_customer_cffs(client_account=client_account).filter(
        id=submission_id,
    ).first()


# ---------------------------------------------------------------------------
# Ready-to-Go portal submissions
# ---------------------------------------------------------------------------
#
# RTG rows come off a distinct portal path: the customer picks a
# published SKU from the org's catalog, fills in a short quantity /
# packaging / delivery form, and this service wires up the
# CFFSubmission, source-project reference, and a draft Proposal all
# in one atomic step. Triage's job on the resulting row is to open
# the drafted proposal, sanity-check, and hit Send — no re-typing.


class CFFRTGSubmissionError(CFFPortalError):
    """Distinct subclass so the FE toast + FE inline-field errors can
    differentiate an RTG validation failure from a Custom one.
    Uses the same ``field_errors`` attribute pattern as
    :class:`CFFPortalError` so callers can attach a per-field errors
    dict."""


@dataclass(frozen=True)
class PortalRTGSubmissionInput:
    """Structured input for :func:`create_portal_rtg_submission`.

    Every field is required at submission time — validation lives in
    the service so the same guard fires regardless of whether the
    call came from a DRF view (JSON) or an internal test. Optional
    entries (``target_ship_date``, ``notes``) surface as ``None`` /
    ``""`` so ``dataclass(frozen=True)`` doesn't complain about
    kw-only defaults.
    """

    rtg_formulation_id: str
    quantity: int
    packaging: str
    delivery_address: str
    target_ship_date: str | None = None
    notes: str = ""
    #: Phase 2 packaging combo pick. When set (and the formulation
    #: has combos configured), overrides the free-text ``packaging``
    #: validation — the combo's name becomes the display packaging
    #: label + the combo FK lands on the ProposalLine so downstream
    #: spec / routing cascade knows what to pull.
    packaging_combo_id: str | None = None


def _extract_rtg_summary(formulation, packaging: str) -> str:
    """Compose the human summary written into ``raw_payload`` and
    used by the triage inbox + portal list as a preview line.

    Short-lived — the drafted proposal takes over the display once
    triage sends it — but useful for the 30-second window between
    the customer hitting submit and staff hitting Send."""

    parts = [formulation.name or "Ready-to-Go product"]
    if packaging:
        parts.append(packaging)
    return " · ".join(parts)


@transaction.atomic
def create_portal_rtg_submission(
    *,
    client_account: Any,
    payload: PortalRTGSubmissionInput,
) -> CFFSubmission:
    """Create the CFFSubmission + drafted Proposal for one RTG order.

    Steps (all inside one transaction so a partial state can't
    survive):

    1. Resolve the source :class:`Formulation` on the customer's
       org. Un-published rows or rows on a different org surface as
       a 404-shaped ``CFFRTGSubmissionError``.
    2. Enforce ``quantity >= rtg_moq`` and packaging membership.
    3. Reuse the source formulation directly — the RTG customer's
       project points at the same validated recipe. We do NOT clone
       the recipe; a clone would fork the audit trail against a
       spec that already exists and is approved.
    4. Create a Proposal in ``draft`` status against the source
       formulation's approved version. Line item is the SKU
       description × quantity × ``rtg_base_price``, snapshotted so
       later catalog re-pricing doesn't rewrite the drafted quote.
    5. Create the CFFSubmission with ``submission_kind=ready_to_go``,
       ``provenance=portal``, and ``drafted_proposal`` pointed at
       the draft. ``raw_payload.submissions`` mirrors the Wix
       envelope so the triage renderer treats it uniformly.

    Failure modes surface as :class:`CFFRTGSubmissionError` with
    ``code`` set to one of:

    * ``rtg_sku_not_found`` — formulation unpublished / missing /
      belongs to a different org.
    * ``below_moq`` — quantity below the SKU's MOQ. ``field_errors``
      carries ``{"quantity": …}``.
    * ``invalid_packaging`` — packaging not in the allowed list.
      ``field_errors`` carries ``{"packaging": …}``.
    * ``rtg_no_approved_version`` — the source formulation has no
      approved version yet, so a proposal can't quote against it.
      An RTG SKU without an approved version shouldn't have been
      published in the first place; guard rail against the drift.
    """

    from apps.customers.models import Customer
    from apps.formulations.models import Formulation, ProjectType
    from apps.proposals.models import (
        Proposal,
        ProposalLine,
        ProposalStatus,
        ProposalTemplateType,
    )

    customer = getattr(client_account, "customer", None)
    if customer is None or customer.organization_id is None:
        exc = CFFRTGSubmissionError(
            "This portal account isn't attached to a customer yet — "
            "reach out to your account manager to get set up.",
        )
        exc.code = "no_customer"  # type: ignore[attr-defined]
        raise exc

    # 1) Resolve + tenant-scope the RTG SKU.
    formulation = (
        Formulation.objects
        .select_related("organization")
        .filter(
            pk=payload.rtg_formulation_id,
            organization_id=customer.organization_id,
            is_rtg_published=True,
            project_type=ProjectType.READY_TO_GO,
        )
        .first()
    )
    if formulation is None:
        exc = CFFRTGSubmissionError(
            "That Ready-to-Go product isn't available anymore. "
            "Head back to the catalog and pick another.",
        )
        exc.code = "rtg_sku_not_found"  # type: ignore[attr-defined]
        raise exc

    # 2) MOQ + packaging guards. Field errors so the FE can hang the
    # message against the right input.
    field_errors: dict[str, str] = {}
    quantity = int(payload.quantity or 0)
    moq = int(formulation.rtg_moq or 1)
    if quantity < moq:
        field_errors["quantity"] = (
            f"Minimum order quantity is {moq}."
        )

    # Phase 2: prefer packaging_combo_id when the formulation has
    # combos configured. Falls back to the legacy free-text
    # ``packaging`` field for pre-migration cards.
    from apps.formulations.models import PackagingCombo

    combo_choice: PackagingCombo | None = None
    if payload.packaging_combo_id:
        combo_choice = (
            PackagingCombo.objects
            .filter(id=payload.packaging_combo_id, formulation=formulation)
            .first()
        )
        if combo_choice is None:
            field_errors["packaging_combo_id"] = (
                "That packaging option isn't offered for this product."
            )
    packaging_choice = (payload.packaging or "").strip()
    if combo_choice is not None:
        # Display packaging label = combo name so the drafted proposal
        # line still reads naturally even when the FE only sent the
        # combo id.
        packaging_choice = combo_choice.name
    else:
        allowed = [
            str(entry).strip()
            for entry in (formulation.rtg_packaging_options or [])
        ]
        if not packaging_choice:
            field_errors["packaging"] = "Pick a packaging option."
        elif allowed and packaging_choice not in allowed:
            field_errors["packaging"] = (
                "That packaging isn't offered for this product."
            )
    delivery = (payload.delivery_address or "").strip()
    if not delivery:
        field_errors["delivery_address"] = "A delivery address is required."

    if field_errors:
        # Return the first specific machine code so the API layer
        # can key the toast copy; the fields dict still carries every
        # violation for the FE to highlight.
        if "quantity" in field_errors:
            code = "below_moq"
        elif "packaging" in field_errors:
            code = "invalid_packaging"
        else:
            code = "rtg_validation"
        exc = CFFRTGSubmissionError(
            "Please fix the highlighted fields before submitting."
        )
        exc.code = code  # type: ignore[attr-defined]
        exc.field_errors = field_errors  # type: ignore[attr-defined]
        raise exc

    # 3) A valid RTG SKU must already have an approved version — the
    # publish flow expects the recipe to be signed off. Guard against
    # a rogue publish that skipped the approval step.
    from apps.formulations.models import FormulationVersion

    approved_number = formulation.approved_version_number
    approved_version: FormulationVersion | None = None
    if approved_number is not None:
        approved_version = (
            FormulationVersion.objects
            .filter(
                formulation=formulation,
                version_number=approved_number,
            )
            .first()
        )
    if approved_version is None:
        # Fall back to the latest version so a mis-configured RTG SKU
        # (published without a signed approval) still produces a
        # workable draft rather than a 500. Staff sees the row in
        # triage and can decide what to do.
        approved_version = (
            FormulationVersion.objects
            .filter(formulation=formulation)
            .order_by("-version_number")
            .first()
        )
    if approved_version is None:
        exc = CFFRTGSubmissionError(
            "This product isn't ready to quote yet. Our team has "
            "been notified.",
        )
        exc.code = "rtg_no_version"  # type: ignore[attr-defined]
        raise exc

    now = django_timezone.now()
    summary = _extract_rtg_summary(formulation, packaging_choice)
    unit_price = formulation.rtg_base_price
    # Phase 2: combo price delta rides on top of the base RTG price.
    # Applied once per unit so the customer sees "base + premium
    # packaging uplift" reflected in the drafted quote.
    if combo_choice is not None and unit_price is not None:
        try:
            unit_price = Decimal(unit_price) + Decimal(combo_choice.price_delta)
        except Exception:  # pragma: no cover - defensive
            pass
    currency = (formulation.rtg_currency_code or "GBP").upper()[:3]

    # 4) Draft proposal — mirrors what ``create_proposal`` would emit
    # for a template=ready_to_go quote. We build it directly (not via
    # the service) so we can skirt the "must be approved version"
    # guard on the shared helper — the RTG catalog is the source of
    # truth here, not the version pin. The proposal starts in DRAFT
    # so staff can review before hitting Send.
    from apps.proposals.services import _generate_unique_code

    proposal_code = _generate_unique_code(formulation.organization)
    line_description = (
        f"{formulation.name or 'Ready-to-Go product'} · {packaging_choice}"
    ).strip(" ·")
    # Phase 3: append the combo's item names so the pricing-table
    # description column reads "SKU · Combo (item, item, item)".
    # Puts the picked packaging on the proposal PDF without any
    # bespoke section surgery — the pricing table is already there.
    if combo_choice is not None:
        combo_item_names = [
            (row.item.name or "").strip()
            for row in combo_choice.items.select_related("item").all()
            if row.item_id
        ]
        combo_item_names = [n for n in combo_item_names if n]
        if combo_item_names:
            line_description = (
                f"{line_description} ({', '.join(combo_item_names)})"
            )
    # ``created_by`` / ``updated_by`` on Proposal are PROTECT + required.
    # RTG rows come off an authenticated customer, not a staff user;
    # attribute the create action to the sales person configured on
    # the customer (if any), falling back to the first org member so
    # the FK stays satisfied. The audit trail records the true
    # portal account in the CFFSubmission's ``raw_payload`` and the
    # ``submitted_by_client_account`` FK.
    from django.contrib.auth import get_user_model

    User = get_user_model()
    proposal_actor = (
        getattr(customer, "account_manager", None)
        or getattr(customer, "sales_person", None)
    )
    if proposal_actor is None:
        proposal_actor = (
            User.objects
            .filter(
                memberships__organization_id=customer.organization_id,
                is_active=True,
            )
            .order_by("date_joined")
            .first()
        )
    if proposal_actor is None:
        # A pathological org with zero members shouldn't have any
        # published RTG SKUs; refuse rather than 500.
        exc = CFFRTGSubmissionError(
            "No staff member is available to review this order. "
            "Contact your account manager.",
        )
        exc.code = "no_staff_actor"  # type: ignore[attr-defined]
        raise exc

    proposal = Proposal.objects.create(
        organization=formulation.organization,
        formulation_version=approved_version,
        customer=customer,
        code=proposal_code,
        template_type=ProposalTemplateType.READY_TO_GO,
        status=ProposalStatus.DRAFT,
        customer_name=customer.name or "",
        customer_email=customer.email or "",
        customer_phone=getattr(customer, "phone", "") or "",
        customer_company=customer.company or "",
        invoice_address=getattr(customer, "invoice_address", "") or "",
        delivery_address=delivery,
        dear_name=customer.name or "",
        reference=proposal_code,
        currency=currency,
        quantity=max(1, quantity),
        unit_price=unit_price,
        cover_notes=(payload.notes or "").strip(),
        created_by=proposal_actor,
        updated_by=proposal_actor,
    )
    ProposalLine.objects.create(
        proposal=proposal,
        formulation_version=approved_version,
        product_code=formulation.code or "",
        description=line_description,
        quantity=max(1, quantity),
        unit_price=unit_price,
        display_order=0,
        selected_packaging_combo=combo_choice,
    )

    # 5) CFFSubmission with RTG discriminator + proposal FK.
    submissions_dict: dict[str, Any] = {
        # Customer identity so triage renders the row without a
        # per-account lookup.
        "first_name": (customer.name or "").split(" ", 1)[0],
        "last_name": (
            (customer.name or "").split(" ", 1)[1]
            if " " in (customer.name or "")
            else ""
        ),
        _PORTAL_SLUG_EMAIL: (customer.email or "").strip().lower(),
        "company_name": customer.company or "",
        # RTG-specific answers. These slugs stay stable so the
        # dashboard's ``_cff_summary`` heuristic can pick up a
        # useful preview line without a special case.
        "rtg_sku_id": str(formulation.pk),
        "rtg_sku_name": formulation.name or "",
        "market_segment": summary,
        "quantity_to_be_quoted": str(quantity),
        "primary_package_type": packaging_choice,
        "address": delivery,
        "target_ship_date": payload.target_ship_date or "",
    }

    submission = CFFSubmission.objects.create(
        organization=formulation.organization,
        provenance="portal",
        submission_kind=CFFSubmissionKind.READY_TO_GO,
        wix_submission_id=None,
        wix_form_id=None,
        wix_namespace="",
        wix_status="",
        wix_created_date=now,
        wix_updated_date=now,
        raw_payload={
            "submissions": submissions_dict,
            "_meta": {
                "provenance": "portal",
                "submission_kind": CFFSubmissionKind.READY_TO_GO,
                "submitted_at": now.isoformat(),
                "submitted_by_client_account_id": str(client_account.pk),
                "rtg_source_formulation_id": str(formulation.pk),
                "rtg_drafted_proposal_id": str(proposal.pk),
                "rtg_packaging_combo_id": (
                    str(combo_choice.id) if combo_choice else ""
                ),
                "rtg_packaging_combo_name": (
                    combo_choice.name if combo_choice else ""
                ),
            },
        },
        submitter_email=(customer.email or "").strip().lower(),
        submitter_name=(customer.name or "").strip(),
        submitted_by_client_account=client_account,
        drafted_proposal=proposal,
    )
    return submission


__all__ = [
    "CFFAssignmentError",
    "ProjectAlreadyHasCFF",
    "CFFPortalError",
    "CFFRTGSubmissionError",
    "CFFRejectionError",
    "PortalRTGSubmissionInput",
    "PortalSubmissionInput",
    "create_portal_rtg_submission",
    "create_portal_submission",
    "CreateFromCFFResult",
    "ImportResult",
    "WixAPIError",
    "WixCFFConfig",
    "WixCFFDecryptionFailed",
    "WixCFFNotConfigured",
    "assign_to_project",
    "detach_from_project",
    "create_project_from_cff",
    "ensure_fresh_submissions",
    "extract_submitter_email",
    "extract_submitter_name",
    "get_customer_cff",
    "get_field_labels",
    "import_cff_submissions_for_org",
    "iter_orgs_with_live_wix_cff",
    "list_customer_cffs",
    "refresh_field_labels",
    "reject",
    "unassign",
    "unreject",
    "verify_wix_cff_connection",
]
