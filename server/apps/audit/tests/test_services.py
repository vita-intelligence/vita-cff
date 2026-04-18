"""Tests for the audit capture helpers.

Exercise :func:`record` and :func:`snapshot` directly so we know
the foundation is solid before the product services lean on it.
Product-service-level instrumentation tests live under the apps
they audit so every module pins its own contract.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

import pytest

from apps.audit.models import AuditLog
from apps.audit.services import record, snapshot
from apps.formulations.models import Formulation
from apps.formulations.services import create_formulation
from apps.organizations.tests.factories import OrganizationFactory


pytestmark = pytest.mark.django_db


class TestSnapshot:
    def test_returns_none_for_none(self) -> None:
        assert snapshot(None) is None

    def test_captures_concrete_fields(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Snapshot Demo",
        )
        data = snapshot(formulation)
        assert data is not None
        assert data["name"] == "Snapshot Demo"
        assert data["project_status"] == "concept"
        # Timestamps polluted every diff — verify the skip list
        # actually strips them.
        assert "updated_at" not in data
        assert "updated_by_id" not in data

    def test_coerces_uuid_to_string(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="UUID Demo",
        )
        data = snapshot(formulation)
        assert data is not None
        # Primary key is a UUID — must come back JSON-safe.
        assert isinstance(data["id"], str)
        UUID(data["id"])  # parses cleanly

    def test_coerces_decimal_to_string(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Decimal Demo",
        )
        # Inject a Decimal-valued attribute via the extras channel
        # — mirrors how callers fold computed fields in.
        data = snapshot(formulation, extra={"total": Decimal("1.2345")})
        assert data is not None
        assert data["total"] == "1.2345"


class TestRecord:
    def test_writes_row_for_model_target(self) -> None:
        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Record Demo",
        )
        created = record(
            organization=org,
            actor=org.created_by,
            action="formulation.test_event",
            target=formulation,
            after={"ok": True},
        )
        assert isinstance(created, AuditLog)
        assert created.action == "formulation.test_event"
        assert created.target_type == "formulation"
        assert created.target_id == str(formulation.pk)
        assert created.after == {"ok": True}

    def test_tolerates_missing_target(self) -> None:
        """Delete paths still need to record a row after the target
        row is gone — caller supplies ``target_type`` and
        ``target_id`` explicitly."""

        org = OrganizationFactory()
        created = record(
            organization=org,
            actor=org.created_by,
            action="formulation.delete",
            target=None,
            target_type="formulation",
            target_id="deadbeef-0000-0000-0000-000000000000",
            before={"name": "already gone"},
        )
        assert created is not None
        assert created.target_type == "formulation"
        assert created.target_id == "deadbeef-0000-0000-0000-000000000000"

    def test_swallows_exception_and_returns_none(self) -> None:
        """Audit is observability; a broken log must never fail
        the surrounding transaction. Simulate a DB-level failure
        by stubbing ``AuditLog.objects.create`` and confirm the
        recorder returns ``None`` instead of re-raising."""

        from unittest.mock import patch

        org = OrganizationFactory()
        with patch(
            "apps.audit.services.AuditLog.objects.create",
            side_effect=RuntimeError("simulated DB failure"),
        ):
            result = record(
                organization=org,
                actor=None,
                action="test.broken",
                target=None,
                target_type="none",
                target_id="x",
            )
        assert result is None


class TestFormulationInstrumentation:
    """Service-layer writes must emit one audit row each.
    Covering the happy paths here; exceptional flows (duplicate
    code, invalid form) are covered inside the formulation tests."""

    def test_create_records_one_row(self) -> None:
        org = OrganizationFactory()
        create_formulation(
            organization=org,
            actor=org.created_by,
            name="Audit Create",
        )
        rows = list(AuditLog.objects.filter(organization=org))
        assert len(rows) == 1
        assert rows[0].action == "formulation.create"
        assert rows[0].after["name"] == "Audit Create"

    def test_update_records_before_and_after(self) -> None:
        from apps.formulations.services import update_formulation

        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Before",
        )
        AuditLog.objects.filter(action="formulation.create").delete()

        update_formulation(
            formulation=formulation,
            actor=org.created_by,
            name="After",
        )
        row = AuditLog.objects.get(action="formulation.update")
        assert row.before["name"] == "Before"
        assert row.after["name"] == "After"

    def test_version_save_records_row(self) -> None:
        from apps.formulations.services import save_version

        org = OrganizationFactory()
        formulation = create_formulation(
            organization=org,
            actor=org.created_by,
            name="Versioned",
        )
        save_version(
            formulation=formulation,
            actor=org.created_by,
            label="v1 test",
        )
        row = AuditLog.objects.get(action="formulation_version.save")
        assert row.after["version_number"] == 1
        assert row.after["label"] == "v1 test"
