"""Live-feed broadcast helpers for the payments queue.

The finance ``/finance/payments/`` board (three-column pipeline in
:file:`client/app/[locale]/finance/payments/payments-list.tsx`) is a
real-time queue: a storefront checkout, a finance record/approve, a
void — every state change should light up the board without a page
reload. TanStack Query on the FE is configured with
``refetchOnWindowFocus: false`` and ``staleTime: 60s`` (see
``client/src/lib/query/client.ts``), so an already-open tab would not
otherwise learn about a payment that just landed via the ``portal``
checkout path (a different app entirely — no cache overlap).

Shape mirrors :mod:`apps.comments.broadcast`:

* One org-scoped Channels group per organisation (``payments.org.<uuid>``).
* One event type on the wire: ``payment.changed`` — payload names the
  affected row + the action so the FE can invalidate exactly the
  right query key. The payload is intentionally minimal (no serialised
  Payment) so a stale row in the payload never contradicts the
  refetched cache.
* Fires on ``transaction.on_commit`` from callers so a rollback in the
  same request never leaves the FE chasing a payment that isn't in the
  DB.
* Best-effort: an ``async_to_sync(group_send)`` failure is logged, not
  propagated — the payment row still lands and the 60 s query poll
  reconciles as a fallback.
"""

from __future__ import annotations

import logging
from typing import Literal

from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from django.db import transaction

from apps.payments.models import Payment


logger = logging.getLogger(__name__)


PaymentChangeAction = Literal[
    "created",
    "updated",
    "approved",
    "voided",
    "assigned",
    "invoice_attached",
]


def payments_org_group_name(organization_id: str) -> str:
    """Channels group every :class:`PaymentsFeedConsumer` for the org
    joins. Restricted to ``[A-Za-z0-9._-]`` per the Channels regex —
    the UUID stays hex + hyphens so the constructed name is always
    valid without an extra sanitisation hop.
    """

    return f"payments.org.{organization_id}"


def schedule_payment_changed_broadcast(
    payment: Payment,
    action: PaymentChangeAction,
) -> None:
    """Enqueue a ``payment.changed`` broadcast for the finance queue.

    Deferred to ``transaction.on_commit`` so a rolled-back write never
    reaches the wire — the queue would then invalidate against a
    payment id the API can't find and render as an orphaned "loading"
    card until the eventual 60 s poll reconciled. All three callers
    (record / approve / void) are inside ``@transaction.atomic`` blocks
    so the on-commit hook is the right join point.
    """

    payment_id = str(payment.pk)
    org_id = str(payment.organization_id)
    # Copy the two fields we broadcast so the closure captures values,
    # not a live ORM instance whose attrs could shift under a
    # concurrent update between now and on-commit.
    status = payment.status
    kind = payment.kind

    def _emit() -> None:
        broadcast_payment_changed_now(
            organization_id=org_id,
            payment_id=payment_id,
            action=action,
            status=status,
            kind=kind,
        )

    transaction.on_commit(_emit)


def broadcast_payment_changed_now(
    *,
    organization_id: str,
    payment_id: str,
    action: PaymentChangeAction,
    status: str,
    kind: str,
) -> None:
    """Direct (non-deferred) send — the caller has already crossed the
    commit boundary or is running outside a transaction (tests, admin
    scripts). :func:`schedule_payment_changed_broadcast` is the right
    hook for the normal REST + service paths.
    """

    channel_layer = get_channel_layer()
    if channel_layer is None:
        logger.debug(
            "No channel layer configured; skipping payment broadcast (%s).",
            action,
        )
        return

    group = payments_org_group_name(organization_id)
    message = {
        "type": "payment.changed",
        "payload": {
            "payment_id": payment_id,
            "action": action,
            # ``status`` + ``kind`` are enough for the FE to decide
            # which of the three columns needs re-fetching without
            # doing a full detail-fetch first. Deposit vs final routes
            # to different sub-sections; status routes to the column.
            "status": status,
            "kind": kind,
        },
    }
    try:
        async_to_sync(channel_layer.group_send)(group, message)
    except Exception:  # noqa: BLE001 — broadcasts are best-effort
        logger.exception(
            "Failed to broadcast payment.changed(%s) for %s to %s",
            action,
            payment_id,
            group,
        )
