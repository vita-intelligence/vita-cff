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
from apps.customers.dynamics import (
    DataverseAuthFailed,
    DataverseInvalidConfig,
    DataverseRateLimited,
    DataverseUnreachable,
    DynamicsContact,
)
from apps.customers.services import (
    CustomerCreationDisabledByDynamics,
    CustomerHasPortalAccount,
    CustomerNotFound,
    DataverseFailure,
    DynamicsConfigInvalid,
    DynamicsDecryptionFailed,
    DynamicsNotConfigured,
    clear_dynamics_config,
    create_customer,
    delete_customer,
    get_customer,
    import_customer_from_dynamics,
    list_customers,
    search_dynamics_contacts,
    serialize_dynamics_config_for_api,
    set_dynamics_config,
    test_dynamics_connection,
    update_customer,
)
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.models import Membership
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
        try:
            customer = create_customer(
                organization=self.organization,
                actor=request.user,
                **data,
            )
        except CustomerCreationDisabledByDynamics:
            # 409 (not 403) — the resource exists / is reachable, the
            # caller's permission isn't the problem. The org has
            # opted into Dynamics-managed customers and a manual row
            # would create a divergent source of truth. Codified
            # error so the frontend banner copy matches the wire
            # response when a stale client tries to POST anyway.
            return Response(
                {"code": "customer_creation_disabled_by_dynamics"},
                status=status.HTTP_409_CONFLICT,
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
        try:
            delete_customer(customer=customer, actor=request.user)
        except CustomerHasPortalAccount as exc:
            # 409 (not 400) because the row is well-formed — the
            # request is just impossible against the current state.
            # The error code lets the FE render a clear toast and
            # keep the row + delete button intact.
            return Response(
                {"detail": [exc.code]},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Microsoft Dynamics integration
# ---------------------------------------------------------------------------


def _dataverse_error_response(exc: Exception) -> Response:
    """Map a Dataverse-side failure onto a 4xx/5xx response with a
    machine-readable code the picker / settings UI can branch on."""

    code = getattr(exc, "code", "dynamics_unreachable")
    status_code = status.HTTP_502_BAD_GATEWAY
    if isinstance(exc, DataverseAuthFailed):
        status_code = status.HTTP_400_BAD_REQUEST
    elif isinstance(exc, DataverseRateLimited):
        status_code = status.HTTP_429_TOO_MANY_REQUESTS
    elif isinstance(exc, DataverseInvalidConfig):
        status_code = status.HTTP_400_BAD_REQUEST
    return Response(
        {"detail": [code], "message": str(exc)},
        status=status_code,
    )


class _OwnerOnly(HasFormulationsPermission):
    """The integration config holds credentials — only org owners can
    read / write / clear it. Non-owners get a 403 even if they're
    able to USE the integration via the customer picker."""

    def has_permission(self, request: Request, view: APIView) -> bool:  # type: ignore[override]
        if not super().has_permission(request, view):
            return False
        organization = getattr(view, "organization", None)
        if organization is None:
            return False
        is_owner = Membership.objects.filter(
            organization=organization,
            user=request.user,
            is_owner=True,
        ).exists()
        if not is_owner:
            # Surface as 403 so the frontend can render a "Owners
            # only" empty state on the settings page rather than a
            # generic "no permission" toast.
            return False
        return True


class DynamicsIntegrationView(APIView):
    """``GET`` / ``PUT`` / ``DELETE``
    ``/api/organizations/<org>/integrations/dynamics/``.

    Owner-only. The plaintext client secret is NEVER returned —
    the read shape carries a ``has_secret`` boolean instead so the
    form can render a "●●●●●●●" placeholder without leaking the
    value.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        return Response(
            serialize_dynamics_config_for_api(self.organization),
            status=status.HTTP_200_OK,
        )

    def put(self, request: Request, org_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        payload = set_dynamics_config(
            organization=self.organization,
            actor=request.user,
            enabled=bool(body.get("enabled", True)),
            dataverse_url=str(body.get("dataverse_url") or ""),
            tenant_id=str(body.get("tenant_id") or ""),
            client_id=str(body.get("client_id") or ""),
            client_secret=body.get("client_secret"),
        )
        return Response(payload, status=status.HTTP_200_OK)

    def delete(self, request: Request, org_id: str) -> Response:
        payload = clear_dynamics_config(
            organization=self.organization, actor=request.user
        )
        return Response(payload, status=status.HTTP_200_OK)


class DynamicsTestConnectionView(APIView):
    """``POST`` ``/api/organizations/<org>/integrations/dynamics/test/``.

    Owner-only. Runs a single ``WhoAmI`` round-trip against the
    org's configured Dataverse tenant. Returns 200 on success;
    400/429/502 with a code the settings UI maps to a specific
    failure message on the form.
    """

    permission_classes = (_OwnerOnly,)
    required_capability = FormulationsCapability.VIEW

    def post(self, request: Request, org_id: str) -> Response:
        try:
            test_dynamics_connection(
                organization=self.organization, actor=request.user
            )
        except DynamicsNotConfigured:
            return Response(
                {"detail": ["dynamics_not_configured"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except DynamicsDecryptionFailed:
            return Response(
                {"detail": ["dynamics_decryption_failed"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except DataverseFailure as exc:
            return _dataverse_error_response(exc)
        return Response(
            serialize_dynamics_config_for_api(self.organization),
            status=status.HTTP_200_OK,
        )


class DynamicsCustomerSearchView(APIView):
    """``GET`` ``/api/organizations/<org>/dynamics/customers/search/?q=…``.

    Picker-facing. Any member who can read customers can call this;
    no owner gate so the day-to-day picker stays unblocked. Returns
    an empty list (silently) when the integration is off or
    Dynamics is unreachable so the picker never breaks the proposal
    flow.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        query = str(request.query_params.get("q") or "").strip()
        try:
            limit_raw = request.query_params.get("limit") or "10"
            limit = max(1, min(int(limit_raw), 25))
        except (TypeError, ValueError):
            limit = 10
        try:
            contacts = search_dynamics_contacts(
                organization=self.organization,
                query=query,
                limit=limit,
            )
        except (
            DynamicsNotConfigured,
            DynamicsDecryptionFailed,
            DataverseFailure,
        ) as exc:
            # Picker never blocks on Dynamics failure — return an
            # empty list so the local results render unaffected.
            # The settings page is the place to surface integration
            # health. The diagnostic ``reason`` field carries the
            # exception code so the picker's dropdown footer can
            # render a "Dynamics: {reason}" hint without a separate
            # endpoint, and the server log captures the full
            # exception type + message so an operator can debug.
            import logging

            logging.getLogger(__name__).warning(
                "Dynamics search failed silently for org %s: %s",
                self.organization.id,
                exc,
                exc_info=True,
            )
            return Response(
                {
                    "results": [],
                    "configured": False,
                    "reason": getattr(exc, "code", type(exc).__name__),
                    "message": str(exc),
                },
                status=status.HTTP_200_OK,
            )
        return Response(
            {
                "results": [
                    {
                        "dynamics_id": c.dynamics_id,
                        "name": c.name,
                        "company": c.company,
                        "email": c.email,
                        "phone": c.phone,
                        "address": c.address,
                    }
                    for c in contacts
                ],
                "configured": True,
            },
            status=status.HTTP_200_OK,
        )


class DynamicsCustomerImportView(APIView):
    """``POST``
    ``/api/organizations/<org>/customers/import-from-dynamics/``.

    Body: a single ``DynamicsContact``-shaped payload (the same
    record returned by ``DynamicsCustomerSearchView``). Idempotent
    on ``dynamics_id`` — second import of the same record returns
    the existing local Customer with refreshed identity fields.
    Returns the local Customer row so the picker can resolve to its
    Vita id without a follow-up GET.

    Capability is intentionally pinned to ``view`` — same as the
    search endpoint above. The picker lives on the proposal flow
    where the typical signed-in user is a commercial / sales role
    that holds ``proposals:edit`` + ``formulations:view`` but **not**
    ``formulations:edit``. Demanding ``edit`` here used to surface as
    a "permission denied" error the moment the user picked a Dynamics
    row, which broke the whole proposal-create flow for them. The
    Dataverse contact data is already exposed by the search endpoint
    so mirroring one of those rows into a local ``Customer`` does not
    grant any additional privilege — it just gives the picker a Vita
    id to bind to.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def post(self, request: Request, org_id: str) -> Response:
        body = request.data if isinstance(request.data, dict) else {}
        dynamics_id = str(body.get("dynamics_id") or "").strip()
        if not dynamics_id:
            return Response(
                {"dynamics_id": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        contact = DynamicsContact(
            dynamics_id=dynamics_id,
            name=str(body.get("name") or "").strip(),
            company=str(body.get("company") or "").strip(),
            email=str(body.get("email") or "").strip(),
            phone=str(body.get("phone") or "").strip(),
            address=str(body.get("address") or "").strip(),
        )
        try:
            customer = import_customer_from_dynamics(
                organization=self.organization,
                actor=request.user,
                contact=contact,
            )
        except DynamicsConfigInvalid:
            return Response(
                {"detail": ["dynamics_payload_invalid"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            CustomerReadSerializer(customer).data,
            status=status.HTTP_201_CREATED,
        )
