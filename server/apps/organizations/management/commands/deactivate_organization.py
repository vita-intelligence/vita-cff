"""Flip ``Organization.is_active`` to ``False`` from the CLI."""

from __future__ import annotations

from django.core.management.base import BaseCommand

from apps.organizations.management.commands.activate_organization import (
    _resolve_organization,
)


class Command(BaseCommand):
    help = "Deactivate an organization (is_active=False) by id or name."

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
        if not organization.is_active:
            self.stdout.write(
                self.style.WARNING(
                    f"Organization {organization.name!r} is already inactive."
                )
            )
            return
        organization.is_active = False
        organization.save(update_fields=["is_active", "updated_at"])
        self.stdout.write(
            self.style.SUCCESS(
                f"Deactivated {organization.name!r} ({organization.id})."
            )
        )
