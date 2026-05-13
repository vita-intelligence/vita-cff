"""Reset ``customer_sign_document_hash`` on every existing spec sheet row.

Mirror of ``proposals/migrations/0011_clear_legacy_document_hashes``.
The kiosk used to store a rendered-HTML hash on each signed spec
sheet; the new audit pipeline hashes a canonical contract payload
instead. Legacy hashes don't match the new scheme, so we wipe them
once and let future kiosk signs repopulate.

Other audit columns (``customer_sign_ip``, ``customer_sign_user_agent``,
plus the signature itself) are intentionally untouched.
"""

from __future__ import annotations

from django.db import migrations


def _reset_hashes_forward(apps, schema_editor):
    SpecificationSheet = apps.get_model(
        "specifications", "SpecificationSheet"
    )
    SpecificationSheet.objects.exclude(customer_sign_document_hash="").update(
        customer_sign_document_hash=""
    )


def _reset_hashes_reverse(apps, schema_editor):
    # No-op reverse — the original rendered-HTML hashes can't be
    # recomputed because the renderer that produced them is gone.
    pass


class Migration(migrations.Migration):

    dependencies = [
        (
            "specifications",
            "0013_specificationsheet_customer_sign_document_hash_and_more",
        ),
    ]

    operations = [
        migrations.RunPython(_reset_hashes_forward, _reset_hashes_reverse),
    ]
