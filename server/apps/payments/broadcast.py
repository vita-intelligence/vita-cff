"""Payment-flavoured wrapper over the generic org live-feed.

The heavy lifting moved to :mod:`apps.organizations.live` (one
consumer per org, one WS route, one broadcaster) so every entity
kind — payment / cff / project / proposal / trial batch / label
design / specification — flows through the same pipe.

This module stays because the payment mutation sites already import
:func:`schedule_payment_changed_broadcast` and there's no upside to
churning them: the wrapper enriches the payload with ``status`` +
``kind`` (the extras the finance FE keys off for column routing)
and pins the entity name so a mis-typed call site can't accidentally
broadcast against the wrong entity family.
"""

from __future__ import annotations

from typing import Literal

from apps.organizations.live import schedule_org_broadcast
from apps.payments.models import Payment


PaymentChangeAction = Literal[
    "created",
    "updated",
    "approved",
    "voided",
    "assigned",
    "invoice_attached",
]


def schedule_payment_changed_broadcast(
    payment: Payment,
    action: PaymentChangeAction,
) -> None:
    """Enqueue a payment ``entity.changed`` broadcast on commit.

    The FE finance page reads the ``status`` + ``kind`` extras to
    decide which of the three columns needs to invalidate without a
    full detail-fetch first.
    """

    schedule_org_broadcast(
        organization_id=str(payment.organization_id),
        entity="payment",
        entity_id=str(payment.pk),
        action=action,
        extra={
            "status": payment.status,
            "kind": payment.kind,
        },
    )
