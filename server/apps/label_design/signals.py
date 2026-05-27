"""Signal wiring for the label-design workflow.

The only signal we listen for in v1: a :class:`Formulation` save
that lands the row in ``APPROVED`` status. That's the moment a
project becomes eligible for the label-design phase, so we bootstrap
the :class:`LabelDesign` row with ``status=PAYMENT_PENDING`` and let
the finance team pick it up.

We listen on ``post_save`` (not ``pre_save``) so the bootstrap only
fires after the formulation row is durably persisted. The receiver
is idempotent — re-saving an APPROVED project won't create duplicate
``LabelDesign`` rows because the OneToOne FK enforces uniqueness AND
:func:`bootstrap_for_formulation` short-circuits when one already
exists.
"""

from __future__ import annotations

import logging

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.formulations.models import Formulation, ProjectStatus
from apps.label_design.services import bootstrap_for_formulation


logger = logging.getLogger(__name__)


@receiver(post_save, sender=Formulation)
def _bootstrap_label_design_on_approval(sender, instance: Formulation, **kwargs) -> None:
    """Create a LabelDesign row the moment a project hits APPROVED.

    Cheap on every formulation save — one indexed read against
    ``label_designs.formulation_id`` when the status is not
    APPROVED, plus one row when it is and the LabelDesign doesn't
    yet exist. Failures are logged but never raised so the original
    save is not undone by a bootstrap problem.
    """

    if instance.project_status != ProjectStatus.APPROVED:
        return

    try:
        spec_sheet = _find_signed_spec_sheet(instance)
        bootstrap_for_formulation(instance, spec_sheet=spec_sheet)
    except Exception:  # pragma: no cover - defence in depth
        logger.exception(
            "label_design bootstrap failed for formulation %s", instance.pk
        )


def _find_signed_spec_sheet(formulation: Formulation):
    """Locate the customer-signed final spec sheet for ``formulation``,
    if one exists.

    Returns ``None`` when no signed sheet is found — the LabelDesign
    is still created (the project is APPROVED for *some* reason),
    just without the spec FK pre-populated.
    """

    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
        SpecificationStatus,
    )

    sheet = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation,
            customer_signed_at__isnull=False,
        )
        .order_by("-customer_signed_at")
        .first()
    )
    if sheet is None:
        return None

    # Prefer a FINAL document if we can find one; ACCEPTED status is
    # the strongest signal the lifecycle reached customer approval.
    final_accepted = (
        SpecificationSheet.objects.filter(
            formulation_version__formulation=formulation,
            customer_signed_at__isnull=False,
            document_kind=SpecificationDocumentKind.FINAL,
            status=SpecificationStatus.ACCEPTED,
        )
        .order_by("-customer_signed_at")
        .first()
    )
    return final_accepted or sheet
