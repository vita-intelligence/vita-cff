"""Signal-based fan-out into the org-scoped live feed.

Six model classes participate: :class:`CFFSubmission`,
:class:`Formulation`, :class:`Proposal`, :class:`TrialBatch`,
:class:`LabelDesign`, :class:`SpecificationSheet`. Any save/delete
on those fires an ``entity.changed`` broadcast on the org feed
without every mutation call site having to remember to call
:func:`schedule_org_broadcast` manually.

Why signals instead of explicit calls at every service function:

* **Coverage.** A single ``.save()`` from an admin action, a data
  migration, a signal chain, or a rarely-touched service function
  still ends up on the feed. Explicit-call instrumentation is one
  ``git blame`` away from silently drifting.
* **Cost is negligible.** The signal handler shape is:
  ``if not organization_id: return`` guard, one ``schedule_``
  call that itself defers to ``transaction.on_commit`` — no
  synchronous WS traffic on the mutation path.
* **Idempotency.** The FE hook does a coarse-grained
  ``invalidateQueries`` per entity; duplicate events are harmless.

Payment stays on explicit :func:`apps.payments.broadcast.
schedule_payment_changed_broadcast` calls because the finance UI
keys off ``status`` + ``kind`` extras that the signal cannot cheaply
compute (the ``created`` vs ``updated`` distinction on
``post_save`` doesn't carry the "approved" vs "voided" verb the
finance columns route by). The Payment model is deliberately
excluded from the signal map so we do not double-broadcast.

Signals fire on ``update_fields=`` saves too — including "silent"
timestamp bumps. Extra invalidations there are cheap on the FE and
outweigh the risk of forgetting to broadcast when it does matter.
"""

from __future__ import annotations

import logging
from typing import Any

from django.db.models.signals import post_delete, post_save

from apps.organizations.live import schedule_org_broadcast


logger = logging.getLogger(__name__)


def _broadcast_from_signal(
    entity: str,
    instance: Any,
    action: str,
) -> None:
    """Best-effort emit — an exception here MUST NOT break the save.

    Failure modes we've thought about:

    * No ``organization_id`` on the instance — every one of the six
      models has one, but the guard keeps a future non-org-scoped
      model that we accidentally add to the map from 500-ing every
      mutation.
    * Broadcast helper raising — ``schedule_org_broadcast`` itself
      already does an ``on_commit`` deferral so the WS traffic does
      not happen synchronously. The ``except`` here is belt-and-
      braces for import-time / channel-layer issues.
    """

    organization_id = getattr(instance, "organization_id", None)
    if not organization_id:
        return
    entity_id = getattr(instance, "pk", None)
    if entity_id is None:
        return
    try:
        schedule_org_broadcast(
            organization_id=str(organization_id),
            entity=entity,
            entity_id=str(entity_id),
            action=action,
        )
    except Exception:  # noqa: BLE001 — never let a broadcast break a save
        logger.exception(
            "Failed to schedule org broadcast for %s.%s(%s)",
            entity,
            action,
            entity_id,
        )


def _make_post_save_handler(entity: str):
    def _handler(sender, instance, created, **kwargs):  # noqa: ARG001
        _broadcast_from_signal(
            entity, instance, "created" if created else "updated"
        )
    return _handler


def _make_post_delete_handler(entity: str):
    def _handler(sender, instance, **kwargs):  # noqa: ARG001
        _broadcast_from_signal(entity, instance, "deleted")
    return _handler


def connect_live_signals() -> None:
    """Wire ``post_save`` + ``post_delete`` for every model in the
    live-feed map. Called from :meth:`OrganizationsConfig.ready`.
    """

    # Deferred imports — models are unavailable until the app
    # registry is populated, which is what ``ready`` waits for.
    from apps.cff_submissions.models import CFFSubmission
    from apps.formulations.models import Formulation
    from apps.label_design.models import LabelDesign
    from apps.proposals.models import Proposal
    from apps.specifications.models import SpecificationSheet
    from apps.trial_batches.models import TrialBatch

    model_map: list[tuple[Any, str]] = [
        (CFFSubmission, "cff_submission"),
        (Formulation, "formulation"),
        (Proposal, "proposal"),
        (TrialBatch, "trial_batch"),
        (LabelDesign, "label_design"),
        (SpecificationSheet, "specification"),
    ]

    for model, entity in model_map:
        post_save.connect(
            _make_post_save_handler(entity),
            sender=model,
            weak=False,
            dispatch_uid=f"live_feed_post_save_{entity}",
        )
        post_delete.connect(
            _make_post_delete_handler(entity),
            sender=model,
            weak=False,
            dispatch_uid=f"live_feed_post_delete_{entity}",
        )
