"""Backfill PENDING deposit Payment rows for accepted proposals.

The kiosk-finalize hook auto-creates a deposit Payment on every new
``sent → accepted`` transition. This command covers the historical
window BEFORE the hook existed: it walks every accepted proposal
with ``deposit_percent > 0`` and calls
:func:`apps.payments.services.ensure_pending_deposit_payment` (which
is itself idempotent — safe to re-run).

Usage:

    ./manage.py backfill_deposit_payments              # all orgs
    ./manage.py backfill_deposit_payments --org <uuid> # scope to one org
    ./manage.py backfill_deposit_payments --dry-run    # report only
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from apps.payments.services import ensure_pending_deposit_payment
from apps.proposals.models import Proposal, ProposalStatus


class Command(BaseCommand):
    help = "Materialise PENDING deposit Payment rows for accepted proposals."

    def add_arguments(self, parser):
        parser.add_argument(
            "--org",
            help="Restrict to a single organization UUID.",
            default=None,
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be created without writing anything.",
        )

    def handle(self, *args, **options):
        qs = Proposal.objects.filter(status=ProposalStatus.ACCEPTED.value)
        if options["org"]:
            qs = qs.filter(organization_id=options["org"])
        qs = qs.select_related("organization", "updated_by", "created_by")

        total = qs.count()
        self.stdout.write(f"Scanning {total} accepted proposal(s)…")

        created = 0
        skipped = 0
        for proposal in qs.iterator():
            if options["dry_run"]:
                # Peek at the same guardrails ensure_pending_deposit_payment
                # applies, without writing.
                from apps.payments.constants import PaymentKind
                from apps.payments.models import Payment
                from apps.payments.services import deposit_required_for_proposal

                if not deposit_required_for_proposal(proposal):
                    skipped += 1
                    continue
                if Payment.objects.filter(
                    proposal=proposal, kind=PaymentKind.DEPOSIT
                ).exists():
                    skipped += 1
                    continue
                self.stdout.write(
                    f"  would create deposit for {proposal.code}"
                )
                created += 1
                continue

            result = ensure_pending_deposit_payment(
                proposal=proposal, actor=proposal.updated_by
            )
            if result is None:
                skipped += 1
            else:
                created += 1
                self.stdout.write(
                    f"  created {result.amount} {result.currency} deposit "
                    f"for {proposal.code}"
                )

        prefix = "[dry-run] " if options["dry_run"] else ""
        self.stdout.write(
            self.style.SUCCESS(
                f"{prefix}Done — created {created}, skipped {skipped}."
            )
        )
