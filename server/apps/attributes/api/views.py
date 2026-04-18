"""Views for the attributes API."""

from __future__ import annotations

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.attributes.api.permissions import HasAttributePermission
from apps.attributes.api.serializers import (
    AttributeDefinitionCreateSerializer,
    AttributeDefinitionReadSerializer,
    AttributeDefinitionUpdateSerializer,
)
from apps.attributes.services import (
    AttributeDefinitionInvalidKey,
    AttributeDefinitionInvalidOptions,
    AttributeDefinitionKeyConflict,
    AttributeDefinitionNotFound,
    create_definition,
    get_definition,
    list_definitions,
    update_definition,
)
from apps.organizations.modules import CataloguesCapability


class AttributeDefinitionListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/.../catalogues/<slug>/attributes/``."""

    permission_classes = (HasAttributePermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            CataloguesCapability.MANAGE_FIELDS
            if request.method == "POST"
            else CataloguesCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str, slug: str) -> Response:
        include_archived = (
            request.query_params.get("include_archived", "").lower() == "true"
        )
        definitions = list_definitions(
            catalogue=self.catalogue,
            include_archived=include_archived,
        )
        return Response(
            AttributeDefinitionReadSerializer(definitions, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request, org_id: str, slug: str) -> Response:
        serializer = AttributeDefinitionCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            definition = create_definition(
                catalogue=self.catalogue,
                actor=request.user,
                key=serializer.validated_data["key"],
                label=serializer.validated_data["label"],
                data_type=serializer.validated_data["data_type"],
                required=serializer.validated_data.get("required", False),
                options=serializer.validated_data.get("options", []),
                display_order=serializer.validated_data.get("display_order", 0),
            )
        except AttributeDefinitionInvalidKey:
            return Response(
                {"key": ["attribute_key_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except AttributeDefinitionKeyConflict:
            return Response(
                {"key": ["attribute_key_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except AttributeDefinitionInvalidOptions:
            return Response(
                {"options": ["attribute_options_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            AttributeDefinitionReadSerializer(definition).data,
            status=status.HTTP_201_CREATED,
        )


class AttributeDefinitionDetailView(APIView):
    """``PATCH`` / ``DELETE`` ``/api/.../catalogues/<slug>/attributes/<id>/``."""

    permission_classes = (HasAttributePermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = CataloguesCapability.MANAGE_FIELDS
        super().initial(request, *args, **kwargs)

    def _load_definition(self, definition_id: str):
        try:
            return get_definition(
                catalogue=self.catalogue, definition_id=definition_id
            )
        except AttributeDefinitionNotFound as exc:
            raise NotFound() from exc

    def patch(
        self,
        request: Request,
        org_id: str,
        slug: str,
        definition_id: str,
    ) -> Response:
        definition = self._load_definition(definition_id)
        serializer = AttributeDefinitionUpdateSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_definition(
                definition=definition,
                actor=request.user,
                label=serializer.validated_data.get("label"),
                required=serializer.validated_data.get("required"),
                options=serializer.validated_data.get("options"),
                display_order=serializer.validated_data.get("display_order"),
                is_archived=serializer.validated_data.get("is_archived"),
            )
        except AttributeDefinitionInvalidOptions:
            return Response(
                {"options": ["attribute_options_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            AttributeDefinitionReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self,
        request: Request,
        org_id: str,
        slug: str,
        definition_id: str,
    ) -> Response:
        definition = self._load_definition(definition_id)
        update_definition(
            definition=definition, actor=request.user, is_archived=True
        )
        return Response(status=status.HTTP_204_NO_CONTENT)
