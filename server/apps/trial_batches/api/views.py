"""Views for the trial-batches API."""

from __future__ import annotations

from dataclasses import asdict

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import PermissionLevel
from apps.trial_batches.api.serializers import (
    TrialBatchCreateSerializer,
    TrialBatchReadSerializer,
    TrialBatchUpdateSerializer,
)
from apps.trial_batches.services import (
    FormulationVersionNotInOrg,
    InvalidBatchSize,
    TrialBatchNotFound,
    compute_batch_scaleup,
    create_batch,
    get_batch,
    list_batches_for_formulation,
    update_batch,
)


class TrialBatchListCreateView(APIView):
    """``GET`` / ``POST`` scoped to one formulation.

    ``/api/organizations/<org>/formulations/<formulation_id>/trial-batches/``

    List returns every batch that targets any version of the
    requested formulation; create locks the new batch to a specific
    version the caller supplies.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_level = (
            PermissionLevel.WRITE
            if request.method == "POST"
            else PermissionLevel.READ
        )
        super().initial(request, *args, **kwargs)

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        queryset = list_batches_for_formulation(
            organization=self.organization,
            formulation_id=formulation_id,
        )
        serializer = TrialBatchReadSerializer(queryset, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        serializer = TrialBatchCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            batch = create_batch(
                organization=self.organization,
                actor=request.user,
                formulation_version_id=data["formulation_version_id"],
                batch_size_units=data["batch_size_units"],
                label=data.get("label", ""),
                notes=data.get("notes", ""),
            )
        except FormulationVersionNotInOrg:
            return Response(
                {
                    "formulation_version_id": [
                        "formulation_version_not_in_org"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidBatchSize:
            return Response(
                {"batch_size_units": ["invalid_batch_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            TrialBatchReadSerializer(batch).data,
            status=status.HTTP_201_CREATED,
        )


class TrialBatchDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE``
    ``/api/organizations/<org>/trial-batches/<id>/``.

    Lives at the org root (not nested under formulations) because the
    scientist reaches a batch by its own id — the link from the list
    page already encodes the formulation scope.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_level = PermissionLevel.READ
        elif request.method == "DELETE":
            self.required_level = PermissionLevel.ADMIN
        else:
            self.required_level = PermissionLevel.WRITE
        super().initial(request, *args, **kwargs)

    def _load(self, batch_id: str):
        try:
            return get_batch(
                organization=self.organization, batch_id=batch_id
            )
        except TrialBatchNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, batch_id: str) -> Response:
        batch = self._load(batch_id)
        return Response(TrialBatchReadSerializer(batch).data)

    def patch(
        self, request: Request, org_id: str, batch_id: str
    ) -> Response:
        batch = self._load(batch_id)
        serializer = TrialBatchUpdateSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_batch(
                batch=batch,
                actor=request.user,
                **serializer.validated_data,
            )
        except InvalidBatchSize:
            return Response(
                {"batch_size_units": ["invalid_batch_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(TrialBatchReadSerializer(updated).data)

    def delete(
        self, request: Request, org_id: str, batch_id: str
    ) -> Response:
        batch = self._load(batch_id)
        batch.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class TrialBatchRenderView(APIView):
    """``GET`` ``/.../trial-batches/<id>/render/``.

    Computes the scaled-up BOM fresh each request from the frozen
    :class:`FormulationVersion` snapshot. No catalogue edits downstream
    can rewrite what procurement sees for a planned batch.
    """

    permission_classes = (HasFormulationsPermission,)
    required_level = PermissionLevel.READ

    def get(self, request: Request, org_id: str, batch_id: str) -> Response:
        try:
            batch = get_batch(
                organization=self.organization, batch_id=batch_id
            )
        except TrialBatchNotFound as exc:
            raise NotFound() from exc
        result = compute_batch_scaleup(batch)
        payload = asdict(result)
        # asdict() returns Decimals as Decimal instances; DRF's JSON
        # renderer serialises them fine, but we stringify for
        # symmetry with every other decimal-carrying payload the
        # frontend consumes (render_context etc.).
        payload = _stringify_decimals(payload)
        return Response(payload, status=status.HTTP_200_OK)


def _stringify_decimals(value):
    from decimal import Decimal

    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, list):
        return [_stringify_decimals(v) for v in value]
    if isinstance(value, dict):
        return {k: _stringify_decimals(v) for k, v in value.items()}
    return value
