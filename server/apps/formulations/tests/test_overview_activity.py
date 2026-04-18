"""Activity feed tests for the project overview.

Pins the post-Phase-B behaviour: the feed is now backed by
:class:`apps.audit.models.AuditLog` rather than the old direct
queries against version + transition tables. Every service write
lands as an entry automatically — here we assert the common
events render with the expected vocabulary.
"""

from __future__ import annotations

import pytest

from apps.formulations.overview import compute_project_overview
from apps.formulations.services import (
    create_formulation,
    save_version,
    update_formulation,
)
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


class TestProjectOverviewActivityFeed:
    def test_entries_are_newest_first(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Activity Demo",
        )
        # Generate a sequence of events — each records an
        # ``AuditLog`` row that the feed should pick up.
        save_version(
            formulation=formulation,
            actor=org.created_by,
            label="first",
        )
        update_formulation(
            formulation=formulation,
            actor=org.created_by,
            name="Activity Demo renamed",
        )

        overview = compute_project_overview(formulation)
        kinds = [entry.kind for entry in overview.activity]

        # Newest first — the rename came last, so it heads the feed.
        assert kinds[0] == "formulation.update"
        # Earlier events still appear, in chronological-descending
        # order. The ``formulation.create`` event from the create
        # service is also picked up.
        assert "formulation_version.save" in kinds
        assert "formulation.create" in kinds

    def test_version_save_renders_with_number_and_label(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Version Demo",
        )
        save_version(
            formulation=formulation,
            actor=org.created_by,
            label="caffeine bump",
        )

        overview = compute_project_overview(formulation)
        version_entries = [
            e
            for e in overview.activity
            if e.kind == "formulation_version.save"
        ]
        assert len(version_entries) == 1
        # Rendered text contains both the version number and the
        # label so the feed is readable at a glance.
        assert "v1" in version_entries[0].text
        assert "caffeine bump" in version_entries[0].text

    def test_actor_attribution_surfaces_in_feed(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Actor Demo",
        )
        overview = compute_project_overview(formulation)
        assert any(
            entry.actor_name == org.created_by.get_full_name()
            or entry.actor_name == org.created_by.email
            for entry in overview.activity
        )
