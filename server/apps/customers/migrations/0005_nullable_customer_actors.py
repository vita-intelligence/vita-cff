"""Make ``Customer.created_by`` and ``Customer.updated_by`` nullable so
the portal self-registration flow can mint a Customer row without a
staff actor on the request.

Pre-self-registration every Customer creation path ran through a staff
user (manual page, Dynamics import). Self-registration originates from
an anonymous customer hitting ``/api/portal/register/`` — there is no
staff actor to attach. Allowing NULL on these columns lets the new
service write a row honestly instead of inventing a synthetic "system"
user. Existing rows keep their non-NULL actors untouched; the FK posture
stays ``PROTECT`` so a referenced staff user still can't be deleted.
"""

from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("customers", "0004_customer_dynamics_account_id_and_more"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AlterField(
            model_name="customer",
            name="created_by",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Staff user who created this row. NULL when the "
                    "customer created themselves via the self-"
                    "registration flow on the portal — that path has "
                    "no staff actor."
                ),
                null=True,
                on_delete=models.deletion.PROTECT,
                related_name="created_customers",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AlterField(
            model_name="customer",
            name="updated_by",
            field=models.ForeignKey(
                blank=True,
                help_text=(
                    "Staff user who last touched this row. NULL when "
                    "the most recent write came from the self-"
                    "registration path."
                ),
                null=True,
                on_delete=models.deletion.PROTECT,
                related_name="updated_customers",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
