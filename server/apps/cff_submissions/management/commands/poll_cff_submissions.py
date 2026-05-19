"""``manage.py poll_cff_submissions`` — manual CFF import.

Mirrors the Celery beat task so operators can run an import on
demand without a worker (handy in dev, on a fresh deploy before the
beat process has had a chance to fire, or during a backfill after
re-keying credentials).

Usage::

    python manage.py poll_cff_submissions                      # all orgs
    python manage.py poll_cff_submissions --org <uuid>         # one org
    python manage.py poll_cff_submissions --json
"""

from __future__ import annotations

import json

from django.core.management.base import BaseCommand, CommandError

from apps.cff_submissions.integration import (
    WixCFFDecryptionFailed,
    WixCFFNotConfigured,
    is_wix_cff_live,
)
from apps.cff_submissions.services import (
    import_cff_submissions_for_org,
    iter_orgs_with_live_wix_cff,
)
from apps.cff_submissions.wix_client import WixAPIError
from apps.organizations.models import Organization


class Command(BaseCommand):
    help = "Poll Wix for new / updated CFF submissions and upsert them."

    def add_arguments(self, parser) -> None:  # type: ignore[no-untyped-def]
        parser.add_argument(
            "--org",
            metavar="UUID",
            help="Run for a single organisation. Defaults to every org "
                 "with a live Wix CFF integration.",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Emit results as JSON instead of human lines.",
        )

    def handle(self, *args, **options) -> None:  # type: ignore[no-untyped-def]
        if options.get("org"):
            try:
                org = Organization.objects.get(pk=options["org"])
            except Organization.DoesNotExist as exc:
                raise CommandError(
                    f"Organization {options['org']} does not exist."
                ) from exc
            if not is_wix_cff_live(org):
                raise CommandError(
                    f"Organization {org.id} does not have a live Wix CFF "
                    "integration — enable it in the settings page first."
                )
            orgs = [org]
        else:
            orgs = list(iter_orgs_with_live_wix_cff())

        if not orgs:
            self.stdout.write(self.style.WARNING(
                "No organisations with a live Wix CFF integration."
            ))
            return

        summaries: list[dict[str, object]] = []
        for organization in orgs:
            try:
                result = import_cff_submissions_for_org(
                    organization=organization,
                )
            except (WixCFFNotConfigured, WixCFFDecryptionFailed) as exc:
                summaries.append({
                    "organization_id": str(organization.id),
                    "error": str(exc),
                })
                continue
            except WixAPIError as exc:
                raise CommandError(
                    f"Wix API error for org {organization.id} "
                    f"({exc.status_code}): {exc.body[:200]}"
                ) from exc

            summaries.append({
                "organization_id": result.organization_id,
                "fetched": result.fetched,
                "created": result.created,
                "updated": result.updated,
                "skipped": result.skipped,
                "errors": result.errors,
            })

        if options["json"]:
            self.stdout.write(json.dumps(summaries))
            return

        for entry in summaries:
            if "error" in entry:
                self.stdout.write(self.style.ERROR(
                    f"org={entry['organization_id']} error={entry['error']}"
                ))
            else:
                self.stdout.write(self.style.SUCCESS(
                    f"org={entry['organization_id']} "
                    f"fetched={entry['fetched']} "
                    f"created={entry['created']} "
                    f"updated={entry['updated']} "
                    f"skipped={entry['skipped']} "
                    f"errors={entry['errors']}"
                ))
