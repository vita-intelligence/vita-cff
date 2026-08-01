"""Add deposit vs final split to Payment.

- ``kind`` — DEPOSIT (bundle-level, unlocks trial batches) or FINAL
  (per-formulation, unlocks labelling). Every existing row is a FINAL
  payment (the label-design gate is the only one that existed
  pre-migration), so the default + backfill lands on ``final``.
- ``proposal`` — nullable FK, populated on DEPOSIT rows so the
  trial-batch gate can walk from formulation → linked proposal →
  approved deposit.
- ``formulation`` — nullable now (was NOT NULL). DEPOSIT rows leave
  it null; FINAL rows keep the old contract.
"""

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("payments", "0002_payment_assigned_finance_officer"),
        ("proposals", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="payment",
            name="kind",
            field=models.CharField(
                choices=[("deposit", "Deposit"), ("final", "Final")],
                db_index=True,
                default="final",
                max_length=16,
                verbose_name="kind",
            ),
        ),
        migrations.AddField(
            model_name="payment",
            name="proposal",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Set on DEPOSIT payments (per-proposal). Null on "
                    "FINAL payments. One deposit covers every "
                    "formulation on a bundled proposal — the trial-"
                    "batch gate for each formulation walks back to "
                    "its accepted proposal to check."
                ),
                null=True,
                on_delete=models.deletion.PROTECT,
                related_name="payments",
                to="proposals.proposal",
            ),
        ),
        migrations.AlterField(
            model_name="payment",
            name="formulation",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Set on FINAL payments (per-formulation). Null "
                    "on DEPOSIT payments — deposits are bundle-level "
                    "and identify their target via ``proposal`` "
                    "instead. PROTECT because a formulation that "
                    "received a payment cannot be silently deleted — "
                    "finance audit relies on the linkage."
                ),
                null=True,
                on_delete=models.deletion.PROTECT,
                related_name="payments",
                to="formulations.formulation",
            ),
        ),
    ]
