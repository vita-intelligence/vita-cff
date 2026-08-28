"""Split PspProductionStatus into one row per (formulation, PSP CO).

Custom projects still live 1:1 with the formulation (they'll fold
into the same slot until Custom re-order lands). RTG catalog products
can be ordered N times and each order needs its own status row so
the customer's second-order portal page reflects THAT order's phase
rather than showing the first order's cached "paid, MO ready" state.

Data migration: existing rows keep their current
``psp_customer_order_uuid`` (already populated by the PSP pusher —
NPD just ignored it before this fix). No back-fill needed.
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('psp', '0005_add_dispatch_progress'),
        ('formulations', '0001_initial'),
    ]

    operations = [
        migrations.AlterField(
            model_name='pspproductionstatus',
            name='formulation',
            field=models.ForeignKey(
                on_delete=models.deletion.CASCADE,
                related_name='psp_production_statuses',
                to='formulations.formulation',
            ),
        ),
        migrations.AddConstraint(
            model_name='pspproductionstatus',
            constraint=models.UniqueConstraint(
                fields=('formulation', 'psp_customer_order_uuid'),
                name='pspproductionstatus_formulation_co_uuid_unique',
            ),
        ),
        migrations.AddIndex(
            model_name='pspproductionstatus',
            index=models.Index(fields=('formulation',), name='psp_pspprod_formul_9d5e83_idx'),
        ),
        migrations.AddIndex(
            model_name='pspproductionstatus',
            index=models.Index(fields=('psp_customer_order_uuid',), name='psp_pspprod_psp_cus_e6c92a_idx'),
        ),
    ]
