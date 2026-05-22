"""Integration tests for the R&D pipeline classifier + board endpoint.

Two layers:

* Classifier unit tests — every stage transition triggers the right
  bucket, including the rejected-proposal fallback and the multi-doc
  "max reached stage" rule.
* Endpoint tests — scope=mine narrowing is silent, scope=all without
  the capability is a 403, discontinued projects are hidden.
"""

from __future__ import annotations

from typing import Any

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.formulations.models import ProjectStatus
from apps.formulations.rd_pipeline import (
    STAGE_BUILDER,
    STAGE_CLOSED,
    STAGE_PROPOSAL,
    STAGE_SPEC_APPROVED,
    STAGE_SPEC_DRAFTING,
    classify_stage,
)
from apps.formulations.services import save_version
from apps.formulations.tests.factories import FormulationFactory
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import MembershipFactory
from apps.proposals.tests.factories import ProposalFactory
from apps.specifications.tests.factories import SpecificationSheetFactory

pytestmark = pytest.mark.django_db


def _board_url(org_id: str) -> str:
    return reverse(
        "formulations:formulation-rd-pipeline",
        kwargs={"org_id": org_id},
    )


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


# ---------------------------------------------------------------------------
# Classifier — pure-Python stage detection
# ---------------------------------------------------------------------------


class TestClassifyStage:
    def test_empty_project_is_builder(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Builder Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )

        assert classify_stage(formulation) == STAGE_BUILDER

    def test_draft_spec_is_spec_drafting(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Drafting Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        SpecificationSheetFactory(
            organization=org,
            formulation_version=version,
            status="draft",
        )

        assert classify_stage(formulation) == STAGE_SPEC_DRAFTING

    def test_approved_spec_is_spec_approved(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Approved Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        SpecificationSheetFactory(
            organization=org,
            formulation_version=version,
            status="approved",
        )

        assert classify_stage(formulation) == STAGE_SPEC_APPROVED

    def test_live_proposal_is_proposal_stage(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Proposal Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        SpecificationSheetFactory(
            organization=org, formulation_version=version, status="approved"
        )
        ProposalFactory(
            organization=org, formulation_version=version, status="sent"
        )

        assert classify_stage(formulation) == STAGE_PROPOSAL

    def test_accepted_proposal_is_closed(self) -> None:
        owner = UserFactory()
        org = create_organization(user=owner, name="Closed Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        ProposalFactory(
            organization=org, formulation_version=version, status="accepted"
        )

        assert classify_stage(formulation) == STAGE_CLOSED

    def test_rejected_proposal_falls_back_to_spec_approved(self) -> None:
        # Rejected = dead deal. Spec is still good. Project should
        # drop back so the scientist can spawn a fresh attempt.
        owner = UserFactory()
        org = create_organization(user=owner, name="Rejected Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        SpecificationSheetFactory(
            organization=org, formulation_version=version, status="approved"
        )
        ProposalFactory(
            organization=org, formulation_version=version, status="rejected"
        )

        assert classify_stage(formulation) == STAGE_SPEC_APPROVED

    def test_rejected_proposal_with_no_approved_spec_falls_back(self) -> None:
        # Edge case: spec was draft, proposal rejected. Project should
        # still classify as Spec drafting (next-highest reached stage).
        owner = UserFactory()
        org = create_organization(user=owner, name="Drafty Rejected Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        SpecificationSheetFactory(
            organization=org, formulation_version=version, status="draft"
        )
        ProposalFactory(
            organization=org, formulation_version=version, status="rejected"
        )

        assert classify_stage(formulation) == STAGE_SPEC_DRAFTING

    def test_max_reached_stage_with_mixed_specs(self) -> None:
        # Mixed bag: one approved spec, one draft spec, one live
        # proposal. Project should classify as Proposal (the highest
        # reached stage). Double-counting would be a bug.
        owner = UserFactory()
        org = create_organization(user=owner, name="Mixed Co")
        formulation = FormulationFactory(
            organization=org, created_by=owner, updated_by=owner
        )
        version = save_version(formulation=formulation, actor=owner)
        SpecificationSheetFactory(
            organization=org, formulation_version=version, status="approved"
        )
        SpecificationSheetFactory(
            organization=org, formulation_version=version, status="draft"
        )
        ProposalFactory(
            organization=org, formulation_version=version, status="sent"
        )

        assert classify_stage(formulation) == STAGE_PROPOSAL


# ---------------------------------------------------------------------------
# Endpoint — scope + capability gating
# ---------------------------------------------------------------------------


class TestPipelineBoard:
    def test_default_scope_only_shows_my_projects(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Self Scope Co")
        teammate = UserFactory()
        MembershipFactory(user=teammate, organization=org)

        mine = FormulationFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            lead_scientist=owner,
        )
        theirs = FormulationFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            lead_scientist=teammate,
        )
        _login(api_client, owner)

        response = api_client.get(_board_url(str(org.id)))

        assert response.status_code == status.HTTP_200_OK
        all_card_ids: set[str] = set()
        for column in response.data["columns"]:
            for card in column["cards"]:
                all_card_ids.add(card["id"])
        assert str(mine.id) in all_card_ids
        assert str(theirs.id) not in all_card_ids

    def test_scope_all_without_capability_is_forbidden(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory()
        scientist = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Locked Co")
        MembershipFactory(
            user=scientist,
            organization=org,
            permissions={"formulations": ["view"]},
        )
        _login(api_client, scientist)

        response = api_client.get(_board_url(str(org.id)) + "?scope=all")

        assert response.status_code == status.HTTP_403_FORBIDDEN

    def test_scope_all_with_capability_returns_everyones(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Whole Team Co")
        teammate = UserFactory()
        MembershipFactory(user=teammate, organization=org)

        FormulationFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            lead_scientist=owner,
        )
        theirs = FormulationFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            lead_scientist=teammate,
        )
        # Owners bypass capability checks, so `owner` always passes
        # the scope=all gate without an explicit grant.
        _login(api_client, owner)

        response = api_client.get(_board_url(str(org.id)) + "?scope=all")

        assert response.status_code == status.HTTP_200_OK
        all_card_ids: set[str] = set()
        for column in response.data["columns"]:
            for card in column["cards"]:
                all_card_ids.add(card["id"])
        assert str(theirs.id) in all_card_ids

    def test_discontinued_projects_are_hidden(
        self, api_client: APIClient
    ) -> None:
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Graveyard Co")
        FormulationFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            lead_scientist=owner,
            project_status=ProjectStatus.DISCONTINUED.value,
        )
        live = FormulationFactory(
            organization=org,
            created_by=owner,
            updated_by=owner,
            lead_scientist=owner,
        )
        _login(api_client, owner)

        response = api_client.get(_board_url(str(org.id)))

        assert response.status_code == status.HTTP_200_OK
        all_card_ids: set[str] = set()
        for column in response.data["columns"]:
            for card in column["cards"]:
                all_card_ids.add(card["id"])
        assert str(live.id) in all_card_ids
        # Discontinued project should not appear anywhere on the board.
        assert len(all_card_ids) == 1

    def test_scope_capabilities_flag_present(
        self, api_client: APIClient
    ) -> None:
        # The FE relies on ``scope_capabilities.can_view_all`` to
        # decide whether to render the "All" toggle. Owners always
        # hold it (capability bypass).
        owner = UserFactory(password=DEFAULT_TEST_PASSWORD)
        org = create_organization(user=owner, name="Toggle Co")
        _login(api_client, owner)

        response = api_client.get(_board_url(str(org.id)))

        assert response.status_code == status.HTTP_200_OK
        assert response.data["scope"] == "mine"
        assert response.data["scope_capabilities"]["can_view_all"] is True
