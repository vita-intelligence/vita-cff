"""Link SampleAllocation → Payment (deposit_payment FK).

Populated by ``ensure_bundled_deposit_payment_for_formulation`` on
sample-selection confirm so the allocation row knows which finance
invoice it produced. ``SET_NULL`` on delete so voiding the Payment
doesn't cascade-nuke the customer's choice record.
"""

from __future__ import annotations

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("payments", "0008_sample_allocation"),
    ]

    operations = [
        migrations.AddField(
            model_name="sampleallocation",
            name="deposit_payment",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="sample_allocation_source",
                to="payments.payment",
            ),
        ),
    ]
