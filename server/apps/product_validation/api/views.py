"""Views for the product-validation API."""

from __future__ import annotations

from dataclasses import asdict

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from apps.product_validation.api.serializers import (
    ProductValidationCreateSerializer,
    ProductValidationReadSerializer,
    ProductValidationStatusSerializer,
    ProductValidationUpdateSerializer,
)
from apps.product_validation.services import (
    InvalidValidationTransition,
    TrialBatchNotInOrg,
    ValidationAlreadyExists,
    ValidationNotFound,
    compute_stats,
    create_validation,
    get_validation,
    get_validation_for_batch,
    list_validations,
    transition_status,
    update_validation,
)


class ValidationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/product-validations/``.

    GET returns every validation in the org (newest-first). POST
    creates a new validation attached to the caller-supplied trial
    batch — batches live under ``/formulations/<id>/trial-batches/``
    but a validation is a first-class resource under the org root
    because it does not logically nest under a single formulation
    (one batch, one validation, many possible formulations).
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        formulation_id = request.query_params.get("formulation_id") or None
        queryset = list_validations(
            organization=self.organization,
            formulation_id=formulation_id,
        )
        serializer = ProductValidationReadSerializer(queryset, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def post(self, request: Request, org_id: str) -> Response:
        serializer = ProductValidationCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            validation = create_validation(
                organization=self.organization,
                actor=request.user,
                trial_batch_id=data["trial_batch_id"],
                notes=data.get("notes", ""),
            )
        except TrialBatchNotInOrg:
            return Response(
                {"trial_batch_id": ["trial_batch_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ValidationAlreadyExists:
            return Response(
                {"trial_batch_id": ["validation_already_exists"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            ProductValidationReadSerializer(validation).data,
            status=status.HTTP_201_CREATED,
        )


class ValidationDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE``
    ``/api/organizations/<org>/product-validations/<id>/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, validation_id: str):
        try:
            return get_validation(
                organization=self.organization,
                validation_id=validation_id,
            )
        except ValidationNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, validation_id: str) -> Response:
        validation = self._load(validation_id)
        return Response(ProductValidationReadSerializer(validation).data)

    def patch(
        self, request: Request, org_id: str, validation_id: str
    ) -> Response:
        validation = self._load(validation_id)
        serializer = ProductValidationUpdateSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        updated = update_validation(
            validation=validation,
            actor=request.user,
            **serializer.validated_data,
        )
        return Response(ProductValidationReadSerializer(updated).data)

    def delete(
        self, request: Request, org_id: str, validation_id: str
    ) -> Response:
        validation = self._load(validation_id)
        validation.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ValidationStatsView(APIView):
    """``GET`` ``/.../product-validations/<id>/stats/``.

    Computes the derived summary on-the-fly — nothing is stored in
    the DB. The scientist reads this every time they open the
    validation page to see the latest pass/fail roll-up against the
    raw samples they just typed.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str, validation_id: str) -> Response:
        try:
            validation = get_validation(
                organization=self.organization,
                validation_id=validation_id,
            )
        except ValidationNotFound as exc:
            raise NotFound() from exc
        stats = compute_stats(validation)
        return Response(asdict(stats), status=status.HTTP_200_OK)


class ValidationStatusView(APIView):
    """``POST`` ``/.../product-validations/<id>/status/``."""

    permission_classes = (HasFormulationsPermission,)
    # Status transitions (passed / failed) are formal QC sign-off,
    # not an edit — gated on ``approve``.
    required_capability = FormulationsCapability.APPROVE

    def post(self, request: Request, org_id: str, validation_id: str) -> Response:
        try:
            validation = get_validation(
                organization=self.organization,
                validation_id=validation_id,
            )
        except ValidationNotFound as exc:
            raise NotFound() from exc
        serializer = ProductValidationStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            updated = transition_status(
                validation=validation,
                actor=request.user,
                next_status=serializer.validated_data["status"],
            )
        except InvalidValidationTransition:
            return Response(
                {"status": ["invalid_validation_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(ProductValidationReadSerializer(updated).data)


class ValidationForBatchView(APIView):
    """``GET`` ``/api/organizations/<org>/trial-batches/<batchId>/validation/``.

    Convenience lookup so the batch detail page can ask "does this
    batch have a validation?" without guessing UUIDs. Returns 404
    when no validation exists yet — the frontend flips that into a
    "Start validation" CTA.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str, batch_id: str) -> Response:
        validation = get_validation_for_batch(
            organization=self.organization,
            batch_id=batch_id,
        )
        if validation is None:
            raise NotFound()
        return Response(ProductValidationReadSerializer(validation).data)
