"""Views for the AI API."""

from __future__ import annotations

from rest_framework import status
from rest_framework.request import Request
from rest_framework.response import Response

from apps.ai.api.serializers import (
    FormulationDraftRequestSerializer,
    FormulationDraftResponseSerializer,
)
from apps.ai.providers import UnknownAIProvider
from apps.ai.providers.base import (
    AIProviderBadResponse,
    AIProviderError,
    AIProviderTimeout,
    AIProviderUnreachable,
)
from apps.ai.services import AIResponseInvalid, generate_formulation_draft
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from rest_framework.views import APIView


class FormulationDraftView(APIView):
    """``POST`` ``/api/organizations/<org_id>/ai/formulation-draft/``.

    Takes a natural-language brief and returns a structured formulation
    draft the frontend uses to pre-fill the New project modal. Gated
    on ``formulations.edit`` — drafting implies the caller is about to
    create a formulation, so the capability needed to save is the
    same one we require to ideate.

    Every call writes exactly one :class:`AIUsage` row — success or
    failure — so the owner-facing dashboard has a complete history.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(self, request: Request, org_id: str) -> Response:
        serializer = FormulationDraftRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        model_override = serializer.validated_data.get("model") or None

        try:
            draft = generate_formulation_draft(
                organization=self.organization,
                actor=request.user,
                brief=serializer.validated_data["brief"],
                provider_name=serializer.validated_data["provider"],
                model=model_override,
            )
        except UnknownAIProvider:
            return Response(
                {"provider": ["unknown_provider"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except AIProviderUnreachable as exc:
            # The model isn't running / the daemon isn't installed —
            # actionable on the client (show "start Ollama" hint)
            # rather than a 500.
            return Response(
                {"detail": [exc.code]},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except AIProviderTimeout as exc:
            return Response(
                {"detail": [exc.code]},
                status=status.HTTP_504_GATEWAY_TIMEOUT,
            )
        except (AIProviderBadResponse, AIResponseInvalid) as exc:
            # The provider returned something — it just wasn't what we
            # asked for. 502 keeps the semantics of "upstream was
            # unhappy" so the UI can retry or nudge the prompt.
            return Response(
                {"detail": [exc.code]},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except AIProviderError as exc:
            return Response(
                {"detail": [getattr(exc, "code", "provider_error")]},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response(
            FormulationDraftResponseSerializer(draft).data,
            status=status.HTTP_200_OK,
        )
