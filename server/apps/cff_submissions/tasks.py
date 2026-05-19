"""Celery tasks for the CFF intake.

A single periodic task that walks every org with the Wix CFF
integration live, polls Wix for that org's form, and upserts
submissions into the local database. Wired into
``CELERY_BEAT_SCHEDULE`` in ``config/settings.py`` so the standard
``celery -A config beat`` process picks it up.

When the broker is unconfigured (dev, tests) the task runs eagerly
in the calling process — same code path the
``manage.py poll_cff_submissions`` management command exercises.
"""

from __future__ import annotations

import logging

from celery import shared_task

from .integration import WixCFFDecryptionFailed, WixCFFNotConfigured
from .services import (
    import_cff_submissions_for_org,
    iter_orgs_with_live_wix_cff,
)
from .wix_client import WixAPIError

logger = logging.getLogger(__name__)


@shared_task(
    name="apps.cff_submissions.tasks.poll_cff_submissions",
    # Network blips and transient Wix-side 5xx get a bounded retry.
    # Config errors are NOT autoretried — they're operator
    # misconfigurations that won't fix themselves and would just
    # spam the broker.
    autoretry_for=(WixAPIError,),
    retry_backoff=True,
    retry_backoff_max=300,
    max_retries=3,
    # The whole walk is paginated; even with several orgs and 100s
    # of submissions it finishes in seconds. Cap aggressively so a
    # hung connection frees the worker for the next tick.
    time_limit=120,
    soft_time_limit=90,
)
def poll_cff_submissions() -> list[dict[str, object]]:
    """Walk every org with a live Wix CFF integration and pull
    their submissions.

    Returns one summary per org in the result backend so operators
    can spot-check via Flower / Celery's inspect API without having
    to read worker logs.
    """

    summaries: list[dict[str, object]] = []
    for organization in iter_orgs_with_live_wix_cff():
        try:
            result = import_cff_submissions_for_org(organization=organization)
        except (WixCFFNotConfigured, WixCFFDecryptionFailed) as exc:
            logger.error(
                "cff.poll: skipping org %s — %s", organization.id, exc,
            )
            summaries.append({
                "organization_id": str(organization.id),
                "fetched": 0, "created": 0, "updated": 0,
                "skipped": 0, "errors": 1,
                "error": str(exc),
            })
            continue
        summaries.append({
            "organization_id": result.organization_id,
            "fetched": result.fetched,
            "created": result.created,
            "updated": result.updated,
            "skipped": result.skipped,
            "errors": result.errors,
        })

    if not summaries:
        # No orgs configured. Log at INFO not WARNING — this is the
        # expected state for a fresh deploy where no org has clicked
        # Connect yet.
        logger.info("cff.poll: no organisations with live Wix CFF config.")

    return summaries
