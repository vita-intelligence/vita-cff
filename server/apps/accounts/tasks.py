"""Celery tasks for the accounts app.

We dispatch the password-reset email through Celery so the request
thread that handled the user's "forgot my password" form returns
immediately — the SMTP round-trip happens in a worker process that
has no caller waiting on it. In eager mode (no broker configured),
the task body runs synchronously in the request just like before,
so the test suite and a fresh ``runserver`` don't need a worker.

Tasks here MUST accept primitives only (UUIDs, strings) — passing a
``User`` model instance would fail JSON serialization in real
broker mode and only "work" in eager mode, which is the classic
foot-gun.
"""

from __future__ import annotations

import logging
from typing import Any

from celery import shared_task
from django.contrib.auth import get_user_model

from apps.accounts.email import (
    PasswordResetEmailFailed,
    send_password_reset_email,
)

logger = logging.getLogger(__name__)
UserModel = get_user_model()


@shared_task(
    name="apps.accounts.tasks.send_password_reset_email_task",
    # Bounded retries with exponential backoff. SMTP outages and
    # transient relay errors are the common failure modes; a
    # one-shot dispatch would lose the reset email for any flapping
    # provider. Cap at 4 retries so a genuinely broken inbox or DNS
    # error doesn't pin a worker forever.
    autoretry_for=(PasswordResetEmailFailed,),
    retry_backoff=True,
    retry_backoff_max=300,
    max_retries=4,
    # Lower the per-task time limit: an email send should never
    # take more than the SMTP timeout. Anything longer is a stuck
    # connection and the worker is better freed.
    time_limit=60,
    soft_time_limit=45,
)
def send_password_reset_email_task(
    user_id: str, plaintext_token: str
) -> None:
    """Re-fetch the user and dispatch the reset link email.

    The plaintext token is passed through — it's already the one
    sensitive secret that has to exist between the issuer and the
    recipient's inbox, and Celery's broker (Redis) is part of our
    own infrastructure, not a third party. We never log or echo
    the token; the helper handles that contract.

    Silent on missing-user: if the row was deleted between dispatch
    and task execution (extremely rare race), there's no recipient
    to email — we drop the task instead of retrying.
    """

    user = UserModel.objects.filter(pk=user_id).first()
    if user is None:
        logger.warning(
            "send_password_reset_email_task: user_id=%s not found, skipping",
            user_id,
        )
        return
    send_password_reset_email(user=user, plaintext_token=plaintext_token)
