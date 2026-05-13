"""Reset ``customer_sign_document_hash`` on every existing proposal row.

Earlier versions of the sign endpoint stored the SHA-256 of the
rendered HTML at sign time. The audit endpoint then re-rendered the
HTML on demand and compared. That worked in isolation but turned
every cosmetic template tweak into a false-positive "Document has
changed since signing" badge on every prior signed proposal — exactly
the problem the audit trail is supposed to flag, only inverted.

The replacement hashes a canonical JSON payload of the proposal's
contract-bearing fields (customer info, pricing, lines, acks,
signature). Stable across deploys; only business-data edits move the
digest. None of the previously-stored hashes match the new scheme,
so we wipe them once and let new signs repopulate.

Audit metadata captured at sign time (IP / User-Agent / signer
identity / signed-at) is left untouched — the only thing legacy rows
lose is the hash badge. The next time a customer signs a proposal,
the canonical-payload hash lands and the badge re-arms.
"""

from __future__ import annotations

from django.db import migrations


def _reset_hashes_forward(apps, schema_editor):
    Proposal = apps.get_model("proposals", "Proposal")
    Proposal.objects.exclude(customer_sign_document_hash="").update(
        customer_sign_document_hash=""
    )


def _reset_hashes_reverse(apps, schema_editor):
    # Nothing to restore — the original rendered-HTML hashes are
    # lost. A reverse migration is a no-op rather than an error so
    # ``migrate proposals 0010`` still completes.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("proposals", "0010_proposal_customer_sign_document_hash_and_more"),
    ]

    operations = [
        migrations.RunPython(_reset_hashes_forward, _reset_hashes_reverse),
    ]
