"""``manage.py merge_customer_duplicates`` — sweep email-duplicate
groups by ``(organization, LOWER(email))``.

Scans the ``customers_customer`` table for every group of two-or-more
rows that share an email under the same org, picks a canonical via
:func:`apps.customers.services.pick_merge_canonical` (activated
portal login wins, then Dataverse-anchored, then oldest), and runs
:func:`apps.customers.services.merge_customers` on each remaining
row. One transaction per group so a single bad pair never blocks
the rest of the sweep.

Always supports ``--dry-run`` which prints the plan without writing
anything — operators are expected to read the output, confirm the
canonical choices, then re-run without the flag. ``--org-id`` scopes
the sweep to one organisation; ``--email`` further narrows to a
single email cluster (useful for replaying a single case post-deploy
when the auto-merger fired correctly going forward but the legacy
row still needs sweeping).

This command supersedes the hand-curated
``scripts/consolidate_customer_dupes.py``. That file is preserved as
a thin wrapper for one-off non-email-keyed groups (company-only
ghosts) but every routine email-cluster cleanup now lives here.
"""

from __future__ import annotations

from typing import Any

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.db.models import Count
from django.db.models.functions import Lower

from apps.customers.models import Customer
from apps.customers.services import (
    CustomerMergeError,
    merge_customers,
    pick_merge_canonical,
)


class Command(BaseCommand):
    help = (
        "Merge duplicate Customer rows that share (organization, "
        "LOWER(email)). Use --dry-run first."
    )

    def add_arguments(self, parser) -> None:
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help=(
                "Print the planned merges without writing. Pair with "
                "--org-id / --email to narrow the plan."
            ),
        )
        parser.add_argument(
            "--org-id",
            type=str,
            default=None,
            help="Limit to one organisation id (UUID).",
        )
        parser.add_argument(
            "--email",
            type=str,
            default=None,
            help=(
                "Limit to one email cluster (case-insensitive). Useful "
                "for replaying a single known case."
            ),
        )
        parser.add_argument(
            "--actor-id",
            type=str,
            default=None,
            help=(
                "Optional staff user id to attribute the merge audit "
                "rows to. Defaults to NULL (system-initiated)."
            ),
        )

    def handle(self, *args: Any, **opts: Any) -> None:
        dry_run = bool(opts.get("dry_run"))
        org_id = opts.get("org_id") or None
        email = (opts.get("email") or "").strip().lower() or None
        actor_id = opts.get("actor_id") or None

        actor = None
        if actor_id:
            from apps.accounts.models import User

            actor = User.objects.filter(pk=actor_id).first()
            if actor is None:
                raise CommandError(f"actor id {actor_id} not found")

        groups = self._discover_groups(org_id=org_id, email=email)
        if not groups:
            self.stdout.write(self.style.SUCCESS("No duplicate groups found."))
            return

        self.stdout.write("=" * 70)
        self.stdout.write(
            f"{'DRY RUN — ' if dry_run else ''}"
            f"Found {len(groups)} duplicate group(s)."
        )
        self.stdout.write("=" * 70)

        total_merges = 0
        total_failures = 0
        for idx, group in enumerate(groups, start=1):
            org_pk = group["organization_id"]
            email_value = group["email"]
            count = group["count"]
            self.stdout.write("")
            self.stdout.write(
                f"--- group {idx}/{len(groups)} · org={org_pk} · "
                f"email={email_value!r} · rows={count}"
            )

            # Wrap the whole group in one transaction so the
            # ``select_for_update`` row-lock is honoured on Postgres
            # (SQLite silently ignores it). Each merge inside the
            # group runs in its own savepoint so a single bad pair
            # never poisons the rest of the group.
            try:
                with transaction.atomic():
                    rows = list(
                        Customer.objects.select_for_update()
                        .filter(
                            organization_id=org_pk,
                            email__iexact=email_value,
                        )
                        .order_by("created_at")
                    )
                    if len(rows) < 2:
                        self.stdout.write(
                            "  skipped — fewer than 2 rows after "
                            "select_for_update"
                        )
                        continue

                    try:
                        canonical, duplicates = pick_merge_canonical(rows)
                    except CustomerMergeError as exc:
                        self.stdout.write(
                            self.style.WARNING(
                                f"  canonical-pick failed: {exc}"
                            )
                        )
                        continue

                    self.stdout.write(
                        f"  canonical : {canonical.pk} "
                        f"({canonical.company or canonical.name or '-'})"
                    )
                    for dup in duplicates:
                        self.stdout.write(
                            f"  duplicate : {dup.pk} "
                            f"({dup.company or dup.name or '-'})"
                        )

                    if dry_run:
                        # Roll back the outer transaction so the dry-run
                        # leaves no row-locks behind.
                        transaction.set_rollback(True)
                        continue

                    for dup in duplicates:
                        # Capture pk before merge — ``duplicate.delete()``
                        # clears the in-memory pk after the row is gone.
                        dup_pk = dup.pk
                        try:
                            with transaction.atomic():
                                merge_customers(
                                    canonical=canonical,
                                    duplicate=dup,
                                    actor=actor,
                                    reason=(
                                        "merge_customer_duplicates sweep"
                                        f" (org={org_pk}, "
                                        f"email={email_value})"
                                    ),
                                )
                            total_merges += 1
                            self.stdout.write(
                                self.style.SUCCESS(
                                    f"  merged {dup_pk} → {canonical.pk}"
                                )
                            )
                        except CustomerMergeError as exc:
                            total_failures += 1
                            self.stdout.write(
                                self.style.WARNING(
                                    f"  REFUSED {dup_pk}: {exc}"
                                )
                            )
            except Exception as exc:  # noqa: BLE001
                self.stdout.write(
                    self.style.ERROR(f"  group aborted: {exc}")
                )
                total_failures += 1
                continue

        self.stdout.write("")
        self.stdout.write("=" * 70)
        if dry_run:
            self.stdout.write(
                "Dry-run complete. Re-run without --dry-run to apply."
            )
        else:
            self.stdout.write(
                f"DONE. merged={total_merges} refused={total_failures}"
            )
        self.stdout.write("=" * 70)

    def _discover_groups(
        self, *, org_id: str | None, email: str | None,
    ) -> list[dict[str, Any]]:
        """Return ``[{organization_id, email, count}, …]`` for every
        (org, LOWER(email)) cluster with 2+ rows.

        ``email`` is returned as the canonical lowercase form; the
        merge step re-resolves rows via ``email__iexact`` against the
        DB so a mixed-case row still matches.
        """

        qs = (
            Customer.objects
            .exclude(email="")
            .annotate(_email_lower=Lower("email"))
            .values("organization_id", "_email_lower")
            .annotate(count=Count("id"))
            .filter(count__gte=2)
            .order_by("organization_id", "_email_lower")
        )
        if org_id:
            qs = qs.filter(organization_id=org_id)
        if email:
            qs = qs.filter(_email_lower=email)

        return [
            {
                "organization_id": row["organization_id"],
                "email": row["_email_lower"],
                "count": row["count"],
            }
            for row in qs
        ]
