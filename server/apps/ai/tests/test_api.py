"""API tests for the formulation-draft endpoint.

We don't hit Ollama from tests — the ``OllamaProvider`` is monkey-
patched to a fake that returns whatever JSON the test supplies. That
keeps CI hermetic (no daemon required) and lets us hit every failure
path deterministically.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.accounts.tests.factories import DEFAULT_TEST_PASSWORD, UserFactory
from apps.ai.models import AIUsage
from apps.ai.providers.base import (
    AIProviderBadResponse,
    AIProviderResult,
    AIProviderTimeout,
    AIProviderUnreachable,
)
from apps.organizations.services import create_organization
from apps.organizations.tests.factories import (
    MembershipFactory,
    OrganizationFactory,
)

pytestmark = pytest.mark.django_db


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _login(client: APIClient, user: Any) -> APIClient:
    client.post(
        reverse("accounts:login"),
        {"email": user.email, "password": DEFAULT_TEST_PASSWORD},
        format="json",
    )
    return client


def _owner_client() -> tuple[APIClient, Any, Any]:
    user = UserFactory(password=DEFAULT_TEST_PASSWORD)
    org = create_organization(user=user, name="Owner Corp")
    client = _login(APIClient(), user)
    return client, user, org


def _draft_url(org_id: Any) -> str:
    return reverse("ai:formulation-draft", args=[str(org_id)])


def _valid_draft_payload() -> dict[str, Any]:
    """A minimal but well-formed formulation draft the provider mock returns."""

    return {
        "name": "Valley Fat Burner",
        "code": "VFB-001",
        "description": "Vegan fat burner capsule with caffeine.",
        "dosage_form": "capsule",
        "capsule_size": "double_00",
        "tablet_size": "",
        "serving_size": 1,
        "servings_per_pack": 60,
        "directions_of_use": "Take 1 capsule with meal",
        "suggested_dosage": "1 capsule per day",
        "appearance": "White vegan capsule",
        "disintegration_spec": "Disintegrate within 60 minutes",
        "ingredients": [
            {
                "name": "Caffeine",
                "label_claim_mg": 200,
                "notes": "Primary active",
            },
            {
                "name": "Green Tea Extract",
                "label_claim_mg": 500,
                "notes": "",
            },
        ],
    }


def _mock_provider_result(
    data: dict[str, Any] | None = None,
    *,
    model: str = "llama3.1:8b",
    prompt_tokens: int | None = 42,
    completion_tokens: int | None = 120,
) -> AIProviderResult:
    return AIProviderResult(
        data=data if data is not None else _valid_draft_payload(),
        model=model,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
    )


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


class TestFormulationDraftSuccess:
    def test_owner_gets_parsed_draft(self) -> None:
        client, _, org = _owner_client()

        with patch(
            "apps.ai.providers.ollama.OllamaProvider.generate_json",
            return_value=_mock_provider_result(),
        ):
            response = client.post(
                _draft_url(org.id),
                {"brief": "Vegan fat burner with caffeine, 60 caps"},
                format="json",
            )

        assert response.status_code == status.HTTP_200_OK
        body = response.json()
        assert body["name"] == "Valley Fat Burner"
        assert body["dosage_form"] == "capsule"
        assert body["serving_size"] == 1
        assert body["servings_per_pack"] == 60
        assert len(body["ingredients"]) == 2
        assert body["ingredients"][0]["name"] == "Caffeine"
        assert body["ingredients"][0]["label_claim_mg"] == 200.0

    def test_success_writes_one_usage_row(self) -> None:
        client, user, org = _owner_client()
        with patch(
            "apps.ai.providers.ollama.OllamaProvider.generate_json",
            return_value=_mock_provider_result(),
        ):
            client.post(
                _draft_url(org.id),
                {"brief": "Caffeine capsule"},
                format="json",
            )

        usages = AIUsage.objects.filter(organization=org)
        assert usages.count() == 1
        usage = usages.first()
        assert usage is not None
        assert usage.user == user
        assert usage.provider == "ollama"
        assert usage.model == "llama3.1:8b"
        assert usage.purpose == "formulation_draft"
        assert usage.success is True
        assert usage.prompt_tokens == 42
        assert usage.completion_tokens == 120
        assert usage.latency_ms >= 0


# ---------------------------------------------------------------------------
# Permission + validation paths
# ---------------------------------------------------------------------------


class TestFormulationDraftPermissions:
    def test_unauthenticated_is_401(self) -> None:
        org = OrganizationFactory()
        response = APIClient().post(
            _draft_url(org.id),
            {"brief": "anything"},
            format="json",
        )
        assert response.status_code == status.HTTP_401_UNAUTHORIZED

    def test_non_member_is_404(self) -> None:
        other_org = OrganizationFactory()
        stranger = UserFactory(password=DEFAULT_TEST_PASSWORD)
        client = _login(APIClient(), stranger)

        response = client.post(
            _draft_url(other_org.id),
            {"brief": "anything"},
            format="json",
        )
        assert response.status_code == status.HTTP_404_NOT_FOUND

    def test_member_without_edit_capability_is_forbidden(self) -> None:
        org = OrganizationFactory()
        user = UserFactory(password=DEFAULT_TEST_PASSWORD)
        # ``view`` only — not enough to draft (drafting implies
        # intent to create, same as the /formulations POST).
        MembershipFactory(
            user=user,
            organization=org,
            is_owner=False,
            permissions={"formulations": ["view"]},
        )
        client = _login(APIClient(), user)

        response = client.post(
            _draft_url(org.id),
            {"brief": "anything"},
            format="json",
        )
        assert response.status_code == status.HTTP_403_FORBIDDEN


class TestFormulationDraftValidation:
    def test_blank_brief_is_400(self) -> None:
        client, _, org = _owner_client()
        response = client.post(
            _draft_url(org.id),
            {"brief": "   "},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_missing_brief_is_400(self) -> None:
        client, _, org = _owner_client()
        response = client.post(_draft_url(org.id), {}, format="json")
        assert response.status_code == status.HTTP_400_BAD_REQUEST

    def test_unknown_provider_is_400(self) -> None:
        client, _, org = _owner_client()
        response = client.post(
            _draft_url(org.id),
            {"brief": "Anything", "provider": "not_a_real_provider"},
            format="json",
        )
        assert response.status_code == status.HTTP_400_BAD_REQUEST


# ---------------------------------------------------------------------------
# Provider failure paths
# ---------------------------------------------------------------------------


class TestProviderFailures:
    def test_unreachable_maps_to_503_and_records_failure(self) -> None:
        client, _, org = _owner_client()
        with patch(
            "apps.ai.providers.ollama.OllamaProvider.generate_json",
            side_effect=AIProviderUnreachable("ollama down"),
        ):
            response = client.post(
                _draft_url(org.id),
                {"brief": "anything"},
                format="json",
            )
        assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
        usage = AIUsage.objects.get(organization=org)
        assert usage.success is False
        assert usage.error_code == "provider_unreachable"

    def test_timeout_maps_to_504_and_records_failure(self) -> None:
        client, _, org = _owner_client()
        with patch(
            "apps.ai.providers.ollama.OllamaProvider.generate_json",
            side_effect=AIProviderTimeout("too slow"),
        ):
            response = client.post(
                _draft_url(org.id),
                {"brief": "anything"},
                format="json",
            )
        assert response.status_code == status.HTTP_504_GATEWAY_TIMEOUT
        usage = AIUsage.objects.get(organization=org)
        assert usage.success is False
        assert usage.error_code == "provider_timeout"

    def test_bad_provider_json_maps_to_502_and_records_failure(self) -> None:
        client, _, org = _owner_client()
        with patch(
            "apps.ai.providers.ollama.OllamaProvider.generate_json",
            side_effect=AIProviderBadResponse("not json"),
        ):
            response = client.post(
                _draft_url(org.id),
                {"brief": "anything"},
                format="json",
            )
        assert response.status_code == status.HTTP_502_BAD_GATEWAY
        usage = AIUsage.objects.get(organization=org)
        assert usage.success is False
        assert usage.error_code == "provider_bad_response"

    def test_schema_mismatch_maps_to_502_and_records_failure(self) -> None:
        """Provider returns JSON but missing required fields.

        The service layer catches this and raises ``AIResponseInvalid``,
        which is different from a transport failure — the usage row
        should capture the specific error code so the dashboard can
        distinguish "model behaved badly" from "network dropped".
        """

        client, _, org = _owner_client()
        bad_payload = {"name": "Only a name"}  # missing dosage_form etc.
        with patch(
            "apps.ai.providers.ollama.OllamaProvider.generate_json",
            return_value=_mock_provider_result(data=bad_payload),
        ):
            response = client.post(
                _draft_url(org.id),
                {"brief": "anything"},
                format="json",
            )
        assert response.status_code == status.HTTP_502_BAD_GATEWAY
        usage = AIUsage.objects.get(organization=org)
        assert usage.success is False
        assert usage.error_code == "ai_response_invalid"


# ---------------------------------------------------------------------------
# Direct unit test of the adapter's JSON parsing path
# ---------------------------------------------------------------------------


class TestOllamaAdapterJSON:
    """Exercises ``OllamaProvider.generate_json`` with a canned HTTP
    response so we cover the parse + envelope-extraction path without
    depending on a live daemon."""

    def test_parses_envelope_and_content(self) -> None:
        from io import BytesIO

        from apps.ai.providers.ollama import OllamaProvider

        content_json = json.dumps({"hello": "world"})
        envelope = json.dumps(
            {
                "message": {"content": content_json},
                "prompt_eval_count": 7,
                "eval_count": 11,
            }
        ).encode("utf-8")

        class _FakeResponse:
            def __init__(self, body: bytes) -> None:
                self._body = body

            def read(self) -> bytes:
                return self._body

            def __enter__(self):  # noqa: D401
                return self

            def __exit__(self, *args):  # noqa: D401
                return False

        with patch(
            "apps.ai.providers.ollama.urllib.request.urlopen",
            return_value=_FakeResponse(envelope),
        ):
            result = OllamaProvider().generate_json(
                system_prompt="sys",
                user_prompt="usr",
            )

        assert result.data == {"hello": "world"}
        assert result.prompt_tokens == 7
        assert result.completion_tokens == 11
