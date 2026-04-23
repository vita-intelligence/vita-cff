"""Backfill a single :class:`ProposalLine` per existing proposal.

The new multi-product data model puts pricing on ``ProposalLine``
rows rather than directly on the :class:`Proposal` envelope. Every
pre-migration proposal already carries a formulation_version + unit
price + quantity, so we convert each into a default line (display
order 0) and leave the old Proposal-level columns in place for one
release cycle so any in-flight reads keep working.
"""

from __future__ import annotations

from django.db import migrations


def _forward(apps, schema_editor) -> None:
    Proposal = apps.get_model("proposals", "Proposal")
    ProposalLine = apps.get_model("proposals", "ProposalLine")

    for proposal in Proposal.objects.all().iterator():
        if proposal.lines.exists():
            # Safety: migration is idempotent. If someone re-ran it
            # (rare but possible in dev) we skip rather than duplicate.
            continue
        version = proposal.formulation_version
        metadata = {}
        formulation_code = ""
        formulation_name = ""
        if version is not None:
            metadata = version.snapshot_metadata or {}
            formulation_code = (
                metadata.get("code") or version.formulation.code or ""
            )
            formulation_name = (
                metadata.get("name") or version.formulation.name or ""
            )

        ProposalLine.objects.create(
            proposal=proposal,
            formulation_version=version,
            specification_sheet=proposal.specification_sheet,
            product_code=formulation_code,
            description=formulation_name,
            quantity=proposal.quantity or 1,
            unit_cost=proposal.material_cost_per_pack,
            unit_price=proposal.unit_price,
            display_order=0,
        )


def _reverse(apps, schema_editor) -> None:
    # Reversible-only in the sense that we clear the backfilled rows;
    # we cannot restore pre-backfill state precisely because the
    # Proposal columns stay populated on forward. Safe because a
    # second forward run is idempotent.
    ProposalLine = apps.get_model("proposals", "ProposalLine")
    ProposalLine.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("proposals", "0002_proposalline"),
    ]

    operations = [migrations.RunPython(_forward, _reverse)]
