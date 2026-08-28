"""Add ``npd_proposal_uuid`` to PspProductionStatus so the portal can
resolve a ``/portal/projects/<proposal_id>`` URL for an RTG order to
the right status row directly, without needing the PSP-side CO uuid
in the URL (which the customer's activity feed doesn't have until PSP
has pushed a status back at least once).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('psp', '0006_pspproductionstatus_per_customer_order'),
    ]

    operations = [
        migrations.AddField(
            model_name='pspproductionstatus',
            name='npd_proposal_uuid',
            field=models.UUIDField(blank=True, null=True),
        ),
        migrations.AddIndex(
            model_name='pspproductionstatus',
            index=models.Index(
                fields=('npd_proposal_uuid',),
                name='psp_pspprod_npd_pro_c04a58_idx',
            ),
        ),
    ]
