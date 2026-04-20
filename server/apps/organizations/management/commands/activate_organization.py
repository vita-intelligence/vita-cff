"""Flip ``Organization.is_active`` to ``True`` from the CLI.

Convenience wrapper around the Django admin toggle for the common
case where an operator just wants to unlock a workspace quickly
without browsing to the admin site. Accepts the UUID or the exact
name (case-insensitive) so it works with whatever the caller has
in front of them.
"""

from __future__ import annotations

import uuid

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from apps.organizations.models import Organization


class Command(BaseCommand):
    help = "Activate an organization (is_active=True) by id or name."

    def add_arguments(self, parser) -> None:  # noqa: ANN001
        parser.add_argument(
            "identifier",
            help=(
                "Organization UUID or exact case-insensitive name. "
                "Use quotes when the name contains spaces."
            ),
        )

    def handle(self, *args, identifier: str, **options) -> None:  # noqa: ANN001, ANN002, ANN003
        organization = _resolve_organization(identifier)
        if organization.is_active:
            self.stdout.write(
                self.style.WARNING(
                    f"Organization {organization.name!r} is already active."
                )
            )
            return
        organization.is_active = True
        organization.save(update_fields=["is_active", "updated_at"])
        self.stdout.write(
            self.style.SUCCESS(
                f"Activated {organization.name!r} ({organization.id})."
            )
        )


def _resolve_organization(identifier: str) -> Organization:
    """Return the single ``Organization`` matching ``identifier``.

    Raises :class:`CommandError` when nothing matches or when the
    identifier is ambiguous across multiple rows.
    """

    query = Q(name__iexact=identifier)
    try:
        query |= Q(id=uuid.UUID(identifier))
    except (ValueError, AttributeError):
        pass

    matches = list(Organization.objects.filter(query)[:2])
    if not matches:
        raise CommandError(f"No organization matched {identifier!r}.")
    if len(matches) > 1:
        raise CommandError(
            f"Multiple organizations matched {identifier!r}; pass a UUID instead."
        )
    return matches[0]
