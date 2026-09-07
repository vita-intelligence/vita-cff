"""E2E cross-system tenant seed.

Creates an isolated tenant used by the ``e2e-cross-system`` Playwright
suite. Every artifact carries a run-id suffix so parallel runs and
re-runs don't collide.

Emits a JSON payload on stdout (LAST line) with the ids/credentials
the TypeScript seed orchestrator needs to hand off to the PSP mix
task and then persist as `.tenant/current.json`.

Usage
-----
    ./.venv/bin/python manage.py e2e_seed_tenant --run-id abcd1234 --json

Notes on service calls:
  * ``apps.organizations.services.create_organization`` — takes a
    ``user`` (becomes owner) + name. Wraps in a transaction and
    seeds default spec limits. Owner bypasses every capability
    check, so the admin user is created first and owns the org.
  * ``apps.organizations.services.update_membership_permissions``
    grants capability sets to non-owner members. Membership rows
    for non-owners are created by ``get_membership`` on first
    access.
  * ``apps.customers.services.create_customer`` — atomic + audit-
    logged. Blocks when Dynamics is enabled on the org, which
    doesn't apply to fresh e2e tenants.
  * ``apps.client_portal.managers.ClientAccountManager.create_account``
    — accepts ``password=`` directly (hashed via ``make_password``).
  * ``apps.formulations.services.create_formulation`` — creates the
    Formulation row + its first FormulationVersion snapshot in one
    transaction; the RTG project_type triggers auto-code generation
    if code is omitted.
"""

from __future__ import annotations

import json
import secrets
from typing import Any

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

UserModel = get_user_model()


class Command(BaseCommand):
    help = "Seed an isolated tenant for cross-system Playwright tests."

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--run-id",
            required=True,
            help="8-hex run-id suffix appended to every artifact.",
        )
        parser.add_argument(
            "--json",
            action="store_true",
            help="Emit result as a single JSON line on stdout.",
        )

    def handle(self, *args: Any, **options: Any) -> None:
        run_id: str = options["run_id"]
        emit_json: bool = options["json"]

        if len(run_id) != 8 or not all(c in "0123456789abcdef" for c in run_id):
            raise CommandError("--run-id must be 8 hex chars")

        with transaction.atomic():
            result = _seed(run_id)

        if emit_json:
            self.stdout.write(json.dumps(result))
        else:
            self.stdout.write(self.style.SUCCESS(f"Seeded tenant {run_id}"))
            self.stdout.write(json.dumps(result, indent=2))


def _seed(run_id: str) -> dict:
    """Do the actual seeding. Called inside an atomic block by the
    caller so a mid-seed failure rolls back cleanly."""

    # Local imports keep the module cheap at Django startup — the
    # command is only ever invoked on-demand.
    from apps.client_portal.models import ClientAccount
    from apps.customers.services import create_customer
    from apps.formulations.models import (
        Formulation,
        FormulationVersion,
        ProjectStatus,
        ProjectType,
    )
    from apps.formulations.services import create_formulation
    from apps.organizations.modules import (
        FinanceCapability,
        FormulationsCapability,
        FINANCE_MODULE,
        FORMULATIONS_MODULE,
    )
    from apps.organizations.models import Membership
    from apps.organizations.services import (
        create_organization,
        update_membership_permissions,
    )
    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
        SpecificationStatus,
    )

    # ------------------------------------------------------------------
    # 1) Admin user (becomes org owner in step 2)
    # ------------------------------------------------------------------
    admin_email = f"admin-{run_id}@e2e.test"
    admin_password = _gen_password()
    admin_user = UserModel.objects.create_user(
        email=admin_email,
        first_name="Admin",
        last_name=f"Tester {run_id}",
        password=admin_password,
    )

    # ------------------------------------------------------------------
    # 2) Organization — admin_user becomes owner (bypasses capability
    #    checks for the entire org).
    # ------------------------------------------------------------------
    org = create_organization(user=admin_user, name=f"E2E Test Tenant {run_id}")

    # ------------------------------------------------------------------
    # 3) Finance officer + capabilities
    # ------------------------------------------------------------------
    finance_email = f"finance-{run_id}@e2e.test"
    finance_password = _gen_password()
    finance_user = UserModel.objects.create_user(
        email=finance_email,
        first_name="Finance",
        last_name=f"Officer {run_id}",
        password=finance_password,
    )
    # Direct-create the Membership rather than routing through the
    # invitation flow — same terminal state, one call. Same shape as
    # ``accept_invitation`` uses in production (services.py:367).
    finance_membership = Membership.objects.create(
        user=finance_user,
        organization=org,
        is_owner=False,
        permissions={},
    )
    update_membership_permissions(
        membership=finance_membership,
        permissions={
            FINANCE_MODULE: [
                FinanceCapability.VIEW,
                FinanceCapability.RECORD_PAYMENT,
                FinanceCapability.APPROVE_PAYMENT,
            ],
        },
    )

    # ------------------------------------------------------------------
    # 4) Scientist + capabilities (formulations + samples)
    # ------------------------------------------------------------------
    scientist_email = f"scientist-{run_id}@e2e.test"
    scientist_password = _gen_password()
    scientist_user = UserModel.objects.create_user(
        email=scientist_email,
        first_name="Lead",
        last_name=f"Scientist {run_id}",
        password=scientist_password,
    )
    scientist_membership = Membership.objects.create(
        user=scientist_user,
        organization=org,
        is_owner=False,
        permissions={},
    )
    update_membership_permissions(
        membership=scientist_membership,
        permissions={
            # Samples workflow is gated by FormulationsCapability —
            # there's no dedicated SAMPLES_MODULE in the current
            # capability grid.
            FORMULATIONS_MODULE: [
                FormulationsCapability.VIEW,
                FormulationsCapability.EDIT,
                FormulationsCapability.APPROVE,
            ],
        },
    )

    # ------------------------------------------------------------------
    # 5) Customer + ClientAccount (portal login for the customer)
    # ------------------------------------------------------------------
    customer_email = f"customer-{run_id}@e2e.test"
    customer_password = _gen_password()
    customer = create_customer(
        organization=org,
        actor=admin_user,
        name=f"E2E Customer {run_id}",
        company=f"E2E Co {run_id}",
        email=customer_email,
    )
    ClientAccount.objects.create_account(
        email=customer_email,
        customer=customer,
        password=customer_password,
    )

    # ------------------------------------------------------------------
    # 6) RTG catalog formulation the customer can order a sample of
    # ------------------------------------------------------------------
    # code is auto-generated for RTG when omitted — but we want a
    # deterministic prefix per run-id for easier debugging on the
    # PSP side.
    from decimal import Decimal

    formulation = create_formulation(
        organization=org,
        actor=scientist_user,
        name=f"E2E RTG Sample {run_id}",
        code=f"E2E-{run_id[:4].upper()}",
        project_type=ProjectType.READY_TO_GO.value,
        servings_per_pack=60,
        description="RTG catalog SKU seeded by e2e_seed_tenant",
    )
    # Promote to APPROVED + set sample_price so the storefront treats
    # it as buyable AND the customer's Request Sample flow can fire —
    # OrderModal's ``hasSample`` check keys off a non-zero
    # ``rtg_sample_price``. Also set ``rtg_unit_price`` + MOQ so a
    # full order path could exercise the same product later.
    formulation.project_status = ProjectStatus.APPROVED.value
    formulation.is_rtg_published = True
    formulation.rtg_sample_price = Decimal("30.00")
    formulation.save(
        update_fields=[
            "project_status",
            "is_rtg_published",
            "rtg_sample_price",
            "updated_at",
        ],
    )

    # create_formulation doesn't auto-spawn a FormulationVersion —
    # the "Save version" service does that once the scientist has
    # populated the builder. For an e2e seed we hand-roll a minimal
    # v1 snapshot so downstream flows (trial batch, PSP push) can
    # find a version to reference.
    version = FormulationVersion.objects.create(
        formulation=formulation,
        version_number=1,
        label="e2e seed v1",
        snapshot_metadata={},
        snapshot_lines=[],
        snapshot_stages=[],
        snapshot_totals={},
        snapshot_stage_boms={},
        is_auto=False,
        is_complete=True,
        created_by=scientist_user,
    )

    # Attach a FINAL, ACCEPTED spec sheet — portal storefront gate
    # requires at least one signed FINAL spec before rendering the
    # SKU as available.
    SpecificationSheet.objects.create(
        organization=org,
        formulation_version=version,
        document_kind=SpecificationDocumentKind.FINAL,
        status=SpecificationStatus.ACCEPTED,
        created_by=scientist_user,
        updated_by=scientist_user,
    )

    # ------------------------------------------------------------------
    # 7) PSP finished-product uuid — the PSP mix task will use this
    #    to persist the mirrored item under its own company_id. We
    #    generate a fresh uuid and pin it to the formulation so both
    #    sides agree without a round-trip during the actual test run.
    # ------------------------------------------------------------------
    import uuid as _uuid

    psp_item_uuid = str(_uuid.uuid4())
    formulation.psp_finished_product_uuid = psp_item_uuid
    formulation.save(
        update_fields=["psp_finished_product_uuid", "updated_at"],
    )

    return {
        "runId": run_id,
        "npdOrgId": str(org.id),
        "customerId": str(customer.id),
        "formulationId": str(formulation.id),
        "readyToGoTemplateId": None,
        "accounts": {
            "customer": {"email": customer_email, "password": customer_password},
            "financeOfficer": {
                "email": finance_email,
                "password": finance_password,
            },
            "scientist": {
                "email": scientist_email,
                "password": scientist_password,
            },
            "admin": {"email": admin_email, "password": admin_password},
        },
        "pspFinishedItemUuid": psp_item_uuid,
    }


def _gen_password() -> str:
    return f"E2E-{secrets.token_urlsafe(12)}"
