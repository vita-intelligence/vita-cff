"""State-machine + bootstrap-signal tests for label_design."""

from __future__ import annotations

import pytest

from apps.formulations.models import ProjectStatus
from apps.formulations.tests.factories import FormulationFactory
from apps.label_design.constants import (
    ALLOWED_TRANSITIONS,
    MAX_CUSTOMER_REJECTIONS_BEFORE_HOLD,
    LabelDesignStatus,
)
from apps.label_design.models import LabelDesign, LabelDesignTransition
from apps.label_design.services import (
    InvalidStatusTransition,
    bootstrap_for_formulation,
    transition_status,
)


pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_client_account(label_design: LabelDesign):
    """Build a minimal :class:`ClientAccount` bound to a customer in
    ``label_design.organization``. Pre-activated so the FK is valid."""

    from datetime import datetime, timezone as dt_timezone

    from apps.client_portal.models import ClientAccount
    from apps.customers.models import Customer

    customer = Customer.objects.create(
        organization=label_design.organization,
        email=f"portal-{label_design.pk}@vita.test",
        name="Portal Tester",
        company="Test Co",
        created_by=label_design.formulation.created_by,
        updated_by=label_design.formulation.created_by,
    )
    account = ClientAccount.objects.create_account(
        email=customer.email,
        customer=customer,
        password="portal-password-12345",
    )
    ClientAccount.objects.filter(pk=account.pk).update(
        activated_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
    )
    return ClientAccount.objects.get(pk=account.pk)


def _make_label_design(status: str = LabelDesignStatus.PAYMENT_PENDING) -> LabelDesign:
    """Build a LabelDesign at an arbitrary status, bypassing the
    state machine. Used by tests that need to start mid-workflow.
    """
    formulation = FormulationFactory(project_status=ProjectStatus.APPROVED)
    label_design, _ = LabelDesign.objects.get_or_create(
        formulation=formulation,
        defaults={
            "organization": formulation.organization,
            "status": status,
        },
    )
    if label_design.status != status:
        # The post_save signal will have created it in PAYMENT_PENDING;
        # force the row into the requested starting state for the test.
        LabelDesign.objects.filter(pk=label_design.pk).update(status=status)
        label_design.refresh_from_db()
    return label_design


# ---------------------------------------------------------------------------
# Bootstrap signal
# ---------------------------------------------------------------------------


def _sign_final_spec(formulation, *, code_suffix="") -> "SpecificationSheet":
    """Build a customer-signed **final** spec sheet on ``formulation``.

    That's the trigger for the label-design bootstrap under the
    post-migration-0005 semantics: only a customer-signed final
    spec unlocks the label workflow (draft signatures authorise
    the proposal, not production).
    """

    from datetime import datetime, timezone as dt_timezone

    from apps.formulations.services import save_version
    from apps.specifications.models import (
        SpecificationDocumentKind,
        SpecificationSheet,
        SpecificationStatus,
    )

    version = save_version(
        formulation=formulation, actor=formulation.created_by
    )
    return SpecificationSheet.objects.create(
        organization=formulation.organization,
        formulation_version=version,
        code=f"SPEC-{formulation.pk.hex[:6]}{code_suffix}",
        document_kind=SpecificationDocumentKind.FINAL,
        status=SpecificationStatus.ACCEPTED,
        customer_signed_at=datetime(2026, 1, 1, tzinfo=dt_timezone.utc),
        created_by=formulation.created_by,
        updated_by=formulation.created_by,
    )


class TestBootstrapSignal:
    def test_signal_creates_label_design_when_final_spec_signed(self) -> None:
        formulation = FormulationFactory(
            project_status=ProjectStatus.APPROVED
        )
        _sign_final_spec(formulation)
        ld = LabelDesign.objects.filter(formulation=formulation).first()
        assert ld is not None
        assert ld.status == LabelDesignStatus.PAYMENT_PENDING
        # Bootstrap transition row is system-authored (actor + client null,
        # from_status blank).
        bootstrap_row = LabelDesignTransition.objects.filter(
            label_design=ld
        ).order_by("created_at").first()
        assert bootstrap_row is not None
        assert bootstrap_row.from_status == ""
        assert bootstrap_row.to_status == LabelDesignStatus.PAYMENT_PENDING
        assert bootstrap_row.actor is None
        assert bootstrap_row.actor_client_account is None

    def test_signal_is_idempotent_across_multiple_final_specs(self) -> None:
        """The regression this migration was born to fix: three
        signed final specs on the same formulation produce ONE
        LabelDesign, not three. Labels are per-product; spec
        revisions on the same product don't spawn additional
        workflows."""

        formulation = FormulationFactory(
            project_status=ProjectStatus.APPROVED
        )
        _sign_final_spec(formulation, code_suffix="-a")
        _sign_final_spec(formulation, code_suffix="-b")
        _sign_final_spec(formulation, code_suffix="-c")
        assert (
            LabelDesign.objects.filter(formulation=formulation).count() == 1
        )

    def test_signal_does_not_fire_for_draft_spec(self) -> None:
        """A customer signing a DRAFT spec authorises the proposal,
        not production. Draft signatures must not seed a label
        workflow."""

        from datetime import datetime, timezone as dt_timezone

        from apps.formulations.services import save_version
        from apps.specifications.models import (
            SpecificationDocumentKind,
            SpecificationSheet,
            SpecificationStatus,
        )

        formulation = FormulationFactory(
            project_status=ProjectStatus.APPROVED
        )
        version = save_version(
            formulation=formulation, actor=formulation.created_by
        )
        SpecificationSheet.objects.create(
            organization=formulation.organization,
            formulation_version=version,
            code=f"SPEC-{formulation.pk.hex[:6]}-draft",
            document_kind=SpecificationDocumentKind.DRAFT,
            status=SpecificationStatus.ACCEPTED,
            customer_signed_at=datetime(
                2026, 1, 1, tzinfo=dt_timezone.utc
            ),
            created_by=formulation.created_by,
            updated_by=formulation.created_by,
        )
        assert (
            LabelDesign.objects.filter(formulation=formulation).count() == 0
        )

    def test_signal_does_not_fire_for_non_approved_status(self) -> None:
        formulation = FormulationFactory(
            project_status=ProjectStatus.IN_DEVELOPMENT
        )
        _sign_final_spec(formulation)
        assert (
            LabelDesign.objects.filter(formulation=formulation).count() == 0
        )

    def test_bootstrap_service_is_idempotent(self) -> None:
        formulation = FormulationFactory(
            project_status=ProjectStatus.APPROVED
        )
        _sign_final_spec(formulation)
        # The signal already created one row; calling the service
        # again must return the existing instance.
        again = bootstrap_for_formulation(formulation)
        assert again is not None
        assert (
            LabelDesign.objects.filter(formulation=formulation).count() == 1
        )


# ---------------------------------------------------------------------------
# Allowed transitions matrix
# ---------------------------------------------------------------------------


def _all_status_pairs() -> list[tuple[str, str]]:
    """Cartesian product of every status pair (incl. self-loops)."""
    statuses = list(LabelDesignStatus.values)
    return [(a, b) for a in statuses for b in statuses]


class TestTransitionMatrix:
    @pytest.mark.parametrize("from_status, to_status", _all_status_pairs())
    def test_allowed_pairs_succeed_disallowed_pairs_raise(
        self, from_status: str, to_status: str
    ) -> None:
        ld = _make_label_design(status=from_status)
        previous_count = LabelDesignTransition.objects.filter(
            label_design=ld
        ).count()
        allowed = ALLOWED_TRANSITIONS.get(from_status, frozenset())
        if from_status == to_status:
            # No-op — no row written, no error.
            transition_status(ld, to_status=to_status)
            assert (
                LabelDesignTransition.objects.filter(label_design=ld).count()
                == previous_count
            )
            return
        if to_status in allowed:
            transition_status(ld, to_status=to_status)
            ld.refresh_from_db()
            assert ld.status == to_status
            # New transition row exists.
            assert (
                LabelDesignTransition.objects.filter(label_design=ld).count()
                == previous_count + 1
            )
        else:
            with pytest.raises(InvalidStatusTransition):
                transition_status(ld, to_status=to_status)
            ld.refresh_from_db()
            assert ld.status == from_status
            # Failed transition didn't write an audit row.
            assert (
                LabelDesignTransition.objects.filter(label_design=ld).count()
                == previous_count
            )

    def test_transition_writes_audit_row_with_metadata(self) -> None:
        ld = _make_label_design(status=LabelDesignStatus.PAYMENT_PENDING)
        transition_status(
            ld,
            to_status=LabelDesignStatus.LABEL_PATH_PENDING,
            notes="payment approved",
            metadata={"payment_id": "abc-123"},
        )
        latest = (
            LabelDesignTransition.objects.filter(label_design=ld)
            .order_by("-created_at")
            .first()
        )
        assert latest.from_status == LabelDesignStatus.PAYMENT_PENDING
        assert latest.to_status == LabelDesignStatus.LABEL_PATH_PENDING
        assert latest.notes == "payment approved"
        assert latest.metadata == {"payment_id": "abc-123"}


# ---------------------------------------------------------------------------
# Customer rejection bookkeeping
# ---------------------------------------------------------------------------


class TestRejectionBookkeeping:
    def test_customer_rejection_increments_counter(self) -> None:
        ld = _make_label_design(status=LabelDesignStatus.CUSTOMER_APPROVAL)
        client = _make_client_account(ld)
        transition_status(
            ld,
            to_status=LabelDesignStatus.DESIGN_IN_PROGRESS,
            actor_client=client,
            notes="not on brand",
        )
        ld.refresh_from_db()
        assert ld.rejection_count == 1
        assert ld.status == LabelDesignStatus.DESIGN_IN_PROGRESS

    def test_threshold_auto_routes_to_on_hold(self) -> None:
        ld = _make_label_design(status=LabelDesignStatus.CUSTOMER_APPROVAL)
        client = _make_client_account(ld)
        # First N-1 rejections bounce back to DESIGN_IN_PROGRESS.
        for _ in range(MAX_CUSTOMER_REJECTIONS_BEFORE_HOLD - 1):
            transition_status(
                ld,
                to_status=LabelDesignStatus.DESIGN_IN_PROGRESS,
                actor_client=client,
            )
            ld.refresh_from_db()
            # Need to re-enter CUSTOMER_APPROVAL to set up the next reject.
            LabelDesign.objects.filter(pk=ld.pk).update(
                status=LabelDesignStatus.CUSTOMER_APPROVAL
            )
            ld.refresh_from_db()

        # The Nth rejection should auto-route to ON_HOLD.
        transition_status(
            ld,
            to_status=LabelDesignStatus.DESIGN_IN_PROGRESS,
            actor_client=client,
        )
        ld.refresh_from_db()
        assert ld.rejection_count == MAX_CUSTOMER_REJECTIONS_BEFORE_HOLD
        assert ld.status == LabelDesignStatus.ON_HOLD

    def test_customer_approval_resets_counter(self) -> None:
        ld = _make_label_design(status=LabelDesignStatus.CUSTOMER_APPROVAL)
        # Pre-set the counter as if there had been a prior rejection.
        LabelDesign.objects.filter(pk=ld.pk).update(rejection_count=2)
        ld.refresh_from_db()
        transition_status(
            ld,
            to_status=LabelDesignStatus.LABEL_APPROVED,
        )
        ld.refresh_from_db()
        assert ld.status == LabelDesignStatus.LABEL_APPROVED
        assert ld.rejection_count == 0
