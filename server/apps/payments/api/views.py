"""Views for the payments API."""

from __future__ import annotations

from decimal import Decimal

from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.models import Formulation
from apps.label_design.constants import LabelDesignStatus
from apps.label_design.models import LabelDesign
from apps.organizations.modules import FinanceCapability
from apps.payments.api.permissions import HasFinancePermission
from apps.payments.api.serializers import (
    PaymentCreateSerializer,
    PaymentReadSerializer,
    PaymentVoidSerializer,
)
from apps.payments.constants import PaymentStatus
from apps.payments.models import Payment
from apps.payments.services import (
    PaymentAlreadyApproved,
    PaymentAlreadyVoided,
    approve_payment,
    record_payment,
    void_payment,
)
from apps.proposals.models import Proposal


class PaymentListCreateView(APIView):
    """``GET /api/organizations/<org>/payments/`` — list, optionally
    filtered by ``status`` query param.

    ``POST`` — record a new payment in ``PENDING`` status.
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.VIEW

    def initial(self, request: Request, *args, **kwargs) -> None:
        # Bump the required capability for POST so RECORD_PAYMENT is
        # required to write a row. List GET stays on plain VIEW.
        if request.method == "POST":
            self.required_capability = FinanceCapability.RECORD_PAYMENT
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, **kwargs) -> Response:
        qs = (
            Payment.objects.filter(organization=self.organization)
            .select_related("formulation", "recorded_by", "approved_by")
            .order_by("-paid_at")
        )
        status_filter = request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)

        data = PaymentReadSerializer(qs, many=True).data
        return Response({"items": data})

    def post(self, request: Request, **kwargs) -> Response:
        serializer = PaymentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data

        formulation = Formulation.objects.filter(
            organization=self.organization,
            id=payload["formulation"],
        ).first()
        if formulation is None:
            raise NotFound()

        payment = record_payment(
            formulation=formulation,
            actor=request.user,
            amount=payload["amount"],
            paid_at=payload["paid_at"],
            method=payload["method"],
            currency=payload["currency"],
            external_reference=payload["external_reference"],
            invoice_number=payload["invoice_number"],
            notes=payload["notes"],
        )
        return Response(
            PaymentReadSerializer(payment).data, status=status.HTTP_201_CREATED
        )


class PaymentApproveView(APIView):
    """``POST /api/organizations/<org>/payments/<id>/approve/`` —
    flip a PENDING payment to APPROVED. Side-effect: drives the
    matching LabelDesign forward off ``PAYMENT_PENDING``.
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.APPROVE_PAYMENT

    def post(self, request: Request, **kwargs) -> Response:
        payment = (
            Payment.objects.filter(
                organization=self.organization,
                id=kwargs["payment_id"],
            )
            .select_related("formulation", "label_design")
            .first()
        )
        if payment is None:
            raise NotFound()

        try:
            payment = approve_payment(payment=payment, actor=request.user)
        except PaymentAlreadyApproved:
            raise ValidationError(
                {"detail": "Payment already approved.", "code": "already_approved"}
            )
        except PaymentAlreadyVoided:
            raise ValidationError(
                {"detail": "Payment is voided.", "code": "voided"}
            )

        return Response(PaymentReadSerializer(payment).data)


class PaymentVoidView(APIView):
    """``POST /api/organizations/<org>/payments/<id>/void/`` —
    mark a payment as VOIDED. Forward-only on the LabelDesign side.
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.APPROVE_PAYMENT

    def post(self, request: Request, **kwargs) -> Response:
        payment = Payment.objects.filter(
            organization=self.organization, id=kwargs["payment_id"]
        ).first()
        if payment is None:
            raise NotFound()

        serializer = PaymentVoidSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            payment = void_payment(
                payment=payment,
                actor=request.user,
                notes=serializer.validated_data["notes"],
            )
        except PaymentAlreadyVoided:
            raise ValidationError(
                {"detail": "Payment already voided.", "code": "already_voided"}
            )

        return Response(PaymentReadSerializer(payment).data)


class PendingPaymentProjectsView(APIView):
    """``GET /api/organizations/<org>/payments/pending-projects/``.

    Returns the slice of projects sitting at
    :data:`LabelDesignStatus.PAYMENT_PENDING` that the finance team
    needs to record a payment on. Paginated + searchable so an org
    with thousands of pending rows doesn't blow up either the JSON
    payload size or the dropdown DOM.

    Query params:

    * ``search`` — case-insensitive ICONTAINS across
      ``formulation.code``, ``formulation.name``, the linked customer's
      ``company``, the linked customer's ``name``, and the proposal
      ``code``. Each token is OR-joined.
    * ``limit``  — page size, capped at 100 (default 20).
    * ``offset`` — zero-based offset for the next page.

    Response shape:

    .. code-block:: json

       {
         "items": [...],
         "total": 1234,
         "has_more": true,
         "next_offset": 20
       }
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        # ---- query-param parsing --------------------------------------
        search = (request.query_params.get("search") or "").strip()
        try:
            limit = int(request.query_params.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20
        limit = max(1, min(limit, 100))
        try:
            offset = int(request.query_params.get("offset") or 0)
        except (TypeError, ValueError):
            offset = 0
        offset = max(0, offset)

        from django.db.models import Exists, OuterRef, Q

        # ---- base queryset --------------------------------------------
        # Subquery that detects an already-approved Payment for this
        # formulation so we can subtract those rows at the DB level
        # rather than walking N queries in Python.
        approved_payment = Payment.objects.filter(
            organization=self.organization,
            formulation_id=OuterRef("formulation_id"),
            status=PaymentStatus.APPROVED,
        )

        # Latest-updated proposal per project for the customer display
        # column. We annotate via a correlated subquery against
        # ``Proposal`` so the headline name / company can drive search
        # without an N+1.
        latest_proposal_pk = (
            Proposal.objects.filter(
                organization=self.organization,
                formulation_version__formulation_id=OuterRef("formulation_id"),
            )
            .order_by("-updated_at")
            .values("pk")[:1]
        )

        qs = (
            LabelDesign.objects.filter(
                organization=self.organization,
                status=LabelDesignStatus.PAYMENT_PENDING,
            )
            .annotate(_has_approved_payment=Exists(approved_payment))
            .filter(_has_approved_payment=False)
            .select_related("formulation")
        )

        if search:
            # OR-join across the searchable columns. Walking the
            # Proposal join via ``formulation__proposal_set__...`` would
            # explode the row count via the M2M-like join; we use the
            # latest_proposal_pk subquery instead so the search stays
            # one-row-per-project.
            matching_proposal_ids = (
                Proposal.objects.filter(
                    organization=self.organization,
                )
                .filter(
                    Q(code__icontains=search)
                    | Q(customer__company__icontains=search)
                    | Q(customer__name__icontains=search)
                    | Q(customer_company__icontains=search)
                    | Q(customer_name__icontains=search)
                )
                .values_list(
                    "formulation_version__formulation_id", flat=True
                )
            )
            qs = qs.filter(
                Q(formulation__code__icontains=search)
                | Q(formulation__name__icontains=search)
                | Q(formulation_id__in=matching_proposal_ids)
            )

        qs = qs.order_by("created_at")
        total = qs.count()
        page = list(qs[offset : offset + limit])

        formulation_ids = [ld.formulation_id for ld in page]

        # Pull one representative proposal per formulation for the
        # page only — single query, then a dict lookup.
        anchor_proposals: dict = {}
        if formulation_ids:
            for proposal in (
                Proposal.objects.filter(
                    organization=self.organization,
                    formulation_version__formulation_id__in=formulation_ids,
                )
                .select_related("customer", "formulation_version")
                .order_by("-updated_at")
            ):
                form_id = proposal.formulation_version.formulation_id
                anchor_proposals.setdefault(form_id, proposal)

        items: list[dict] = []
        for ld in page:
            anchor = anchor_proposals.get(ld.formulation_id)
            customer = getattr(anchor, "customer", None) if anchor else None
            customer_name = (
                getattr(customer, "name", "") or ""
            ) if customer else ""
            if not customer_name and anchor is not None:
                customer_name = getattr(anchor, "customer_name", "") or ""
            customer_company = (
                getattr(customer, "company", "") or ""
            ) if customer else ""
            if not customer_company and anchor is not None:
                customer_company = getattr(anchor, "customer_company", "") or ""
            # Pre-compute the amount due from the linked proposal so
            # the finance dialog can pre-populate it. We use the
            # proposal's ``subtotal`` property (which sums line items
            # and falls back to the legacy ``unit_price × quantity``
            # envelope) — that matches what the customer was quoted.
            # Quantize to 2 decimal places — ``Payment.amount`` is
            # ``DecimalField(decimal_places=2)`` but proposal
            # ``unit_price`` carries 4 places, so a raw str() can
            # 400 the create serializer with ``max_decimal_places``.
            proposal_amount = None
            proposal_currency = ""
            if anchor is not None:
                try:
                    sub = anchor.subtotal
                    if sub is not None:
                        from decimal import ROUND_HALF_UP, Decimal

                        proposal_amount = str(
                            Decimal(sub).quantize(
                                Decimal("0.01"), rounding=ROUND_HALF_UP
                            )
                        )
                except Exception:  # pragma: no cover - defence in depth
                    proposal_amount = None
                proposal_currency = (
                    getattr(anchor, "currency", "") or ""
                ).strip()

            items.append(
                {
                    "formulation_id": str(ld.formulation_id),
                    "formulation_code": ld.formulation.code,
                    "formulation_name": ld.formulation.name,
                    "label_design_id": str(ld.id),
                    "label_design_created_at": ld.created_at.isoformat(),
                    "proposal_code": getattr(anchor, "code", "") if anchor else "",
                    "proposal_id": str(anchor.id) if anchor else None,
                    "proposal_amount": proposal_amount,
                    "proposal_currency": proposal_currency,
                    "customer_name": customer_name,
                    "customer_company": customer_company,
                    "customer_email": (
                        getattr(customer, "email", "") if customer else ""
                    ),
                }
            )

        next_offset = offset + limit
        has_more = next_offset < total
        return Response(
            {
                "items": items,
                "total": total,
                "has_more": has_more,
                "next_offset": next_offset if has_more else None,
            }
        )
