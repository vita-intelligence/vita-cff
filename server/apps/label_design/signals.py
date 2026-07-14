"""Signal wiring for the label-design workflow.

We bootstrap **one** :class:`LabelDesign` per formulation. The
trigger is the customer signing a **final** spec sheet, which is
the moment that product is authorised for production. Revised
final specs on the same project don't spawn a second workflow —
:func:`bootstrap_for_spec` upserts on formulation.

Two signals keep the bootstrap reactive to either side:

1. ``SpecificationSheet`` ``post_save`` — fires on the spec the
   moment the customer's signature lands. Idempotent because
   :func:`bootstrap_for_spec` short-circuits when a LabelDesign
   already exists for the formulation, and the unique constraint
   ``label_design_unique_per_formulation`` prevents duplicates at
   the DB layer.
2. ``Formulation`` ``post_save`` — defensive fallback for projects
   where the customer signed the spec BEFORE the project reached
   APPROVED (rare race: scientist marks approved retroactively).
   Walks every customer-signed final spec on the project and
   upserts.
"""

from __future__ import annotations

import logging

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.formulations.models import Formulation, ProjectStatus
from apps.label_design.services import (
    bootstrap_for_spec,
    _find_signed_spec_sheet,
)
from apps.specifications.models import SpecificationSheet


logger = logging.getLogger(__name__)


@receiver(post_save, sender=SpecificationSheet)
def _bootstrap_on_customer_spec_sign(
    sender, instance: SpecificationSheet, **kwargs
) -> None:
    """Create a LabelDesign the moment a customer signs the spec.

    Skips when the customer signature column is still null OR the
    parent project hasn't reached APPROVED yet (the bootstrap
    service double-checks the project state and returns None in
    that case). Failures are logged but never raised so the
    original spec save is not undone by a bootstrap problem.
    """

    if instance.customer_signed_at is None:
        return

    try:
        bootstrap_for_spec(instance)
    except Exception:  # pragma: no cover - defence in depth
        logger.exception(
            "label_design bootstrap failed for spec %s", instance.pk
        )


@receiver(post_save, sender=Formulation)
def _backfill_label_designs_on_approval(
    sender, instance: Formulation, **kwargs
) -> None:
    """Fallback bootstrap for a freshly-APPROVED project.

    Handles the race where the customer's spec signature landed
    BEFORE the project itself flipped to APPROVED — the spec-side
    signal short-circuited (project not approved yet) and would
    never re-fire on its own. Walks every customer-signed spec on
    the project and lets the per-spec bootstrap upsert each one.
    """

    if instance.project_status != ProjectStatus.APPROVED:
        return

    try:
        sheet = _find_signed_spec_sheet(instance)
        if sheet is None:
            return
        # Walk every signed spec — the helper above only returns
        # one, so iterate explicitly to cover multi-spec projects.
        from apps.specifications.models import SpecificationSheet

        signed = SpecificationSheet.objects.filter(
            formulation_version__formulation=instance,
            customer_signed_at__isnull=False,
        )
        for s in signed:
            bootstrap_for_spec(s)
    except Exception:  # pragma: no cover - defence in depth
        logger.exception(
            "label_design backfill failed for formulation %s", instance.pk
        )
