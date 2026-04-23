"""API views for the customers app.

Reuses :class:`HasFormulationsPermission` so anyone who can see the
project surface can also see / add customers — there's no separate
Customer capability today because the customer list is a sales tool
that the same roles always touch alongside proposals.
"""

from __future__ import annotations

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.customers.api.serializers import (
    CustomerReadSerializer,
    CustomerWriteSerializer,
)
from apps.customers.services import (
    CustomerNotFound,
    create_customer,
    delete_customer,
    get_customer,
    list_customers,
    update_customer,
)
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability


class CustomerListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/customers/``.

    ``?search=<term>`` filters by name / company / email so the
    proposal picker's typeahead lands on the right row without an
    extra field choice. Kept as a simple ``icontains`` for now —
    fancy ranking is premature with address-book sized datasets.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.VIEW
            if request.method == "GET"
            else FormulationsCapability.EDIT
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        search = request.query_params.get("search", "") or ""
        queryset = list_customers(
            organization=self.organization, search=search
        )
        return Response(
            CustomerReadSerializer(queryset, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request, org_id: str) -> Response:
        serializer = CustomerWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        customer = create_customer(
            organization=self.organization,
            actor=request.user,
            **data,
        )
        return Response(
            CustomerReadSerializer(customer).data,
            status=status.HTTP_201_CREATED,
        )


class CustomerDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE``
    ``/api/organizations/<org>/customers/<customer_id>/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, customer_id: str):
        try:
            return get_customer(
                organization=self.organization, customer_id=customer_id
            )
        except CustomerNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, customer_id: str
    ) -> Response:
        customer = self._load(customer_id)
        return Response(CustomerReadSerializer(customer).data)

    def patch(
        self, request: Request, org_id: str, customer_id: str
    ) -> Response:
        customer = self._load(customer_id)
        serializer = CustomerWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        updated = update_customer(
            customer=customer,
            actor=request.user,
            **serializer.validated_data,
        )
        return Response(CustomerReadSerializer(updated).data)

    def delete(
        self, request: Request, org_id: str, customer_id: str
    ) -> Response:
        customer = self._load(customer_id)
        delete_customer(customer=customer, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)
