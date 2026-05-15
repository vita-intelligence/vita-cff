"""Celery tasks for the proposals app.

Two send paths in this app are *intentionally* synchronous and
stay that way:

* :func:`apps.proposals.services.send_proposal_to_client` runs the
  SMTP send inside ``@transaction.atomic`` so an SMTP failure rolls
  back the ``approved → sent`` status flip — the all-or-nothing
  contract a customer-facing dispatch requires.
* :func:`apps.proposals.services.send_proposal_test_email` returns
  the final subject so the compose modal can render "Sent test to
  …" — the operator wants real confirmation, not an enqueue ack.

Only the *rejection notification* is genuinely best-effort: it
nudges the sales team that the customer declined, and the rejection
itself is already durable when we dispatch. That's the one move to
Celery in this module — frees the request thread that handled the
customer's "Decline" click from waiting on SMTP.
"""

from __future__ import annotations

import logging
from typing import Any

from celery import shared_task

logger = logging.getLogger(__name__)


@shared_task(
    name="apps.proposals.tasks.send_proposal_rejection_notification_task",
    # Best-effort dispatch: bounded retries on transient SMTP
    # errors. After the cap we drop the email — the rejection has
    # already landed in the DB audit trail, so missing the email is
    # a notification gap, not a correctness gap.
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=300,
    max_retries=3,
    time_limit=60,
    soft_time_limit=45,
)
def send_proposal_rejection_notification_task(proposal_id: Any) -> None:
    """Re-fetch the proposal and notify the sales person it was
    rejected.

    The proposal is looked up fresh inside the task — the dispatcher
    only passed the ID, never the model instance. Same idempotency
    contract as the original ``_send_proposal_rejection_notification``
    helper: missing proposal / missing sales-person email is a
    silent no-op (logged), not an error.
    """

    # Local import to avoid an import-time circular: ``services.py``
    # imports from this module via ``transaction.on_commit`` callbacks.
    from apps.proposals.services import _send_proposal_rejection_notification

    _send_proposal_rejection_notification(proposal_id=proposal_id)
