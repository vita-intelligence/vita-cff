"""Idempotency handle for the trial-batch → PSP MO create flow.

When the scientist clicks "Create MO on PSP" on the trial-batch
detail page, NPD calls PSP's ``POST /api/integration/
manufacturing-orders`` and stores the returned MO uuid here.
Nullable — every existing (pre-integration) trial batch stays
blank; a batch's row only picks up a uuid once the scientist
actually pushes to PSP.

Kept as a plain UUID field (not a proper FK): PSP is a separate
database, and the uuid is the stable cross-system handle we use
everywhere else the two systems reference each other
(psp_finished_product_uuid on Formulation, psp_source_uuid on
Item, etc.).
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("trial_batches", "0002_trialbatch_batch_size_mode"),
    ]

    operations = [
        migrations.AddField(
            model_name="trialbatch",
            name="psp_manufacturing_order_uuid",
            field=models.UUIDField(
                null=True,
                blank=True,
                help_text=(
                    "Cross-system handle for the PSP Manufacturing Order "
                    "this trial batch spawned. Populated by the "
                    "'Create MO on PSP' action; blank on every "
                    "pre-integration batch."
                ),
            ),
        ),
    ]
