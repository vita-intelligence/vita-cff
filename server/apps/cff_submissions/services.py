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
from .models import CFFSubmission, CFFSubmissionStatus, WixFormSchemaCache
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


# ---------------------------------------------------------------------------
# Errors surfaced to the API + task layer
# ---------------------------------------------------------------------------


class CFFAssignmentError(RuntimeError):
    """Raised when an assignment would violate a workspace invariant
    (project belongs to a different org, etc.). API maps to 4xx."""


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
def assign_to_project(
    *,
    submission: CFFSubmission,
    project: Formulation,
    actor: Any,
) -> CFFSubmission:
    """Attach ``submission`` to ``project``.

    Both must belong to the same organisation. Assigning a CFF to a
    project in a different tenant is a hard error, not best-effort.
    Re-assigning to the same project updates ``assigned_at`` so the
    audit trail reflects the latest decision.
    """

    if project.organization_id != submission.organization_id:
        raise CFFAssignmentError(
            "Project belongs to a different organisation than the CFF."
        )

    submission.project = project
    submission.assigned_by = actor
    submission.assigned_at = django_timezone.now()
    submission.save(
        update_fields=("project", "assigned_by", "assigned_at", "last_synced_at"),
    )
    return submission


@transaction.atomic
def unassign(
    *,
    submission: CFFSubmission,
    actor: Any,
) -> CFFSubmission:
    """Detach a CFF from its project. ``actor`` is recorded as the
    last touch so the audit trail reflects who broke the link, not
    who made it."""

    submission.project = None
    submission.assigned_by = actor
    submission.assigned_at = django_timezone.now()
    submission.save(
        update_fields=("project", "assigned_by", "assigned_at", "last_synced_at"),
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


__all__ = [
    "CFFAssignmentError",
    "CreateFromCFFResult",
    "ImportResult",
    "WixAPIError",
    "WixCFFConfig",
    "WixCFFDecryptionFailed",
    "WixCFFNotConfigured",
    "assign_to_project",
    "create_project_from_cff",
    "ensure_fresh_submissions",
    "get_field_labels",
    "import_cff_submissions_for_org",
    "iter_orgs_with_live_wix_cff",
    "refresh_field_labels",
    "unassign",
    "verify_wix_cff_connection",
]
