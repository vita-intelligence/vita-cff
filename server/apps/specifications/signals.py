"""Cache invalidation hooks for the specifications app.

The PDF render cache (:mod:`config.pdf_cache`) is keyed on the
sheet ID alone — *not* ``updated_at`` — so cached bytes survive
repeat downloads of the same revision regardless of which uvicorn
worker handled the request. The downside of dropping ``updated_at``
from the key is that the cache no longer self-invalidates on edit;
this module restores correctness by listening for the
``SpecificationSheet`` post-save signal and explicitly dropping
the entry whenever the row changes.

The hook is wired in :class:`SpecificationsConfig.ready`, not at
import time, so test environments can opt out by replacing the
config or the cache module without contorting module-load order.

Why a signal and not an explicit ``invalidate()`` call in every
``sheet.save()`` site: there are 12+ distinct save sites across
the services module (status transition, packaging set, customer
accept, override edits, kiosk token rotation, …) and missing one
silently serves stale PDF bytes. The signal makes correctness the
default and edits the exception — adding a new save site doesn't
need the developer to remember to invalidate.
"""

from __future__ import annotations

from typing import Any

from django.db.models.signals import post_save
from django.dispatch import receiver

from apps.specifications.models import SpecificationSheet
from config.pdf_cache import invalidate as invalidate_pdf_cache


@receiver(
    post_save,
    sender=SpecificationSheet,
    dispatch_uid="specifications.invalidate_pdf_cache_on_save",
)
def _drop_spec_pdf_cache(
    sender: type[SpecificationSheet],
    instance: SpecificationSheet,
    **kwargs: Any,
) -> None:
    """Invalidate the rendered-PDF cache entry for this sheet.

    Cheap operation (one dict pop under a short-lived lock) so it
    runs unconditionally on every save — including saves that only
    touch the signature columns or rotate the public token. Better
    to over-invalidate by ~50 bytes of saved CPU than to serve a
    stale PDF after an edit.

    No-op on unsaved (raw) reads: ``post_save`` only fires after a
    successful insert/update so there is always a real PK in the
    cache key.
    """

    invalidate_pdf_cache(f"spec-pdf:{instance.pk}")
