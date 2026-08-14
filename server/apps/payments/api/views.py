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
from apps.payments.broadcast import schedule_payment_changed_broadcast
from apps.audit.services import record as record_audit
from apps.payments.api.serializers import (
    AssignPaymentFinanceOfficerSerializer,
    PaymentCreateSerializer,
    PaymentEditSerializer,
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
        from apps.organizations.services import get_membership, has_capability
        from django.db.models import Q

        qs = (
            Payment.objects.filter(organization=self.organization)
            .select_related(
                "formulation",
                "customer",
                "recorded_by",
                "approved_by",
                "assigned_finance_officer",
            )
            # Prefetch the reverse relations the serializer walks per
            # row — ``PaymentReadSerializer`` reads ``.lines.all()`` and
            # ``.invoices.all()`` on every payment to compute aggregates
            # (total lines, invoice fan-out). Without these two prefetches
            # the list view is O(N) queries per page — a 200-payment
            # page is 400+ extra queries, which is the exact anti-pattern
            # that stalls the finance dashboard at 10× load.
            .prefetch_related("lines", "invoices")
            .order_by("-paid_at")
        )
        status_filter = request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)

        finance_officer_filter = request.query_params.get("finance_officer")
        if finance_officer_filter:
            qs = qs.filter(assigned_finance_officer_id=finance_officer_filter)

        # ``scope=mine|all`` — same pattern as the labelling queue
        # and the R&D pipeline. A finance team member sees only the
        # payments they own (plus unassigned ones waiting for triage)
        # by default; a manager (the ``finance.assign_officer`` cap
        # holder) DEFAULTS to ``all`` because the whole point of
        # holding that grant is to see the whole team's queue.
        # Either side can override with ``?scope=`` if they need
        # the other view temporarily.
        membership = get_membership(request.user, self.organization)
        can_view_all = bool(
            membership
            and has_capability(
                membership,
                "finance",
                FinanceCapability.ASSIGN_OFFICER,
            )
        )
        default_scope = "all" if can_view_all else "mine"
        raw_scope = (
            request.query_params.get("scope") or default_scope
        ).strip().lower()
        if raw_scope not in {"mine", "all"}:
            raw_scope = default_scope
        if raw_scope == "all" and not can_view_all:
            raw_scope = "mine"
        if raw_scope == "mine":
            qs = qs.filter(
                Q(assigned_finance_officer_id=request.user.id)
                | Q(assigned_finance_officer__isnull=True)
            )

        data = PaymentReadSerializer(qs, many=True).data
        return Response(
            {
                "items": data,
                "scope": raw_scope,
                "scope_capabilities": {"can_view_all": can_view_all},
            }
        )

    def post(self, request: Request, **kwargs) -> Response:
        from apps.payments.constants import PaymentKind
        from apps.proposals.models import Proposal

        serializer = PaymentCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data

        kind = payload.get("kind", PaymentKind.FINAL)
        formulation = None
        proposal = None

        if kind == PaymentKind.DEPOSIT:
            proposal = Proposal.objects.filter(
                organization=self.organization,
                id=payload["proposal"],
            ).first()
            if proposal is None:
                raise NotFound()
        else:
            formulation = Formulation.objects.filter(
                organization=self.organization,
                id=payload["formulation"],
            ).first()
            if formulation is None:
                raise NotFound()

        payment = record_payment(
            kind=kind,
            formulation=formulation,
            proposal=proposal,
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


class PaymentDetailView(APIView):
    """``GET / PATCH /api/organizations/<org>/payments/<id>/``.

    ``GET`` returns the full payment row for the detail page,
    gated by ``finance.view``.

    ``PATCH`` edits the mutable subset (amount, currency, method,
    external reference, invoice number, paid date, notes) gated by
    ``finance.record_payment``. Only allowed while the payment is
    still ``pending`` — once approved or voided the row is locked
    and the correct workflow is to void and re-record so the audit
    trail stays clean.
    """

    permission_classes = [HasFinancePermission]

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "PATCH":
            self.required_capability = FinanceCapability.RECORD_PAYMENT
        else:
            self.required_capability = FinanceCapability.VIEW
        super().initial(request, *args, **kwargs)

    def _load(self, payment_id) -> Payment:
        payment = (
            Payment.objects.filter(
                organization=self.organization, id=payment_id
            )
            .select_related(
                "formulation",
                "customer",
                "recorded_by",
                "approved_by",
                "assigned_finance_officer",
                "label_design",
            )
            .first()
        )
        if payment is None:
            raise NotFound()
        return payment

    def get(self, request: Request, **kwargs) -> Response:
        return Response(PaymentReadSerializer(self._load(kwargs["payment_id"])).data)

    def patch(self, request: Request, **kwargs) -> Response:
        payment = self._load(kwargs["payment_id"])
        if payment.status != PaymentStatus.PENDING:
            raise ValidationError(
                {
                    "detail": (
                        "Cannot edit a payment once it has been approved or "
                        "voided. Void this row and record a fresh one to "
                        "make corrections."
                    ),
                    "code": "payment_locked",
                }
            )
        serializer = PaymentEditSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        before = {
            field: getattr(payment, field)
            for field in serializer.validated_data.keys()
        }
        for field, value in serializer.validated_data.items():
            setattr(payment, field, value)
        payment.save(
            update_fields=[*serializer.validated_data.keys(), "updated_at"]
        )

        record_audit(
            organization=payment.organization,
            actor=request.user,
            action="payment.edit",
            target=payment,
            before={k: str(v) for k, v in before.items()},
            after={k: str(getattr(payment, k)) for k in serializer.validated_data},
        )
        # Live push — amount / method / invoice-number edits should
        # ripple to every open finance tab, not just the tab that made
        # the edit.
        schedule_payment_changed_broadcast(payment, "updated")
        return Response(PaymentReadSerializer(payment).data)


class PaymentPspInvoicesView(APIView):
    """``GET /api/organizations/<org>/payments/<id>/psp-invoices/``.

    Lists CustomerInvoices raised on PSP for the CO that mirrors
    this payment. Read-only, silent-degrade: unknown formulation,
    PSP integration off, or transport failure all return
    ``{"invoices": [], "supported": true/false}`` so the FE
    always renders "no PSP invoices yet" instead of an error.

    ``supported`` tells the FE whether the invoice-mirror path
    applies at all — false on deposit payments (no direct CO
    mapping) so the FE can hide the card entirely.
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.VIEW

    def get(self, request: Request, org_id, payment_id) -> Response:
        payment = (
            Payment.objects.filter(
                organization=self.organization, id=payment_id
            )
            .select_related("formulation", "organization")
            .first()
        )
        if payment is None:
            raise NotFound()

        # Local imports — keeps the PSP client out of the hot import
        # graph for the rest of the payments API.
        from apps.payments.constants import PaymentKind
        from apps.psp.services import list_psp_invoices_for_payment

        # ``supported`` = "we know how to map this Payment kind to a
        # PSP CO uuid". Currently true for kind=FINAL only (deposit
        # payments span multiple COs via the proposal, unsupported).
        supported = payment.kind == PaymentKind.FINAL
        invoices = list_psp_invoices_for_payment(payment=payment) if supported else []
        return Response({"invoices": invoices, "supported": supported})


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
            .select_related("formulation", "customer", "label_design")
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


class PaymentAssignFinanceOfficerView(APIView):
    """``POST .../payments/<id>/assign-finance-officer/`` — assign
    or clear the finance-officer pointer on the payment row.

    Gated by ``finance.assign_officer``. Pointer-only: being
    assigned grants no extra capabilities, mirrors how
    ``sales_person`` works on a project. Drives the ``scope=mine``
    filter on the finance queue (``?finance_officer=<id>``).
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.ASSIGN_OFFICER

    def post(self, request: Request, **kwargs) -> Response:
        payment = Payment.objects.filter(
            organization=self.organization, id=kwargs["payment_id"]
        ).first()
        if payment is None:
            raise NotFound()

        serializer = AssignPaymentFinanceOfficerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        finance_officer_id = serializer.validated_data.get("finance_officer_id")

        if finance_officer_id is None:
            payment.assigned_finance_officer = None
        else:
            from apps.accounts.models import User
            from apps.organizations.services import get_membership

            user = User.objects.filter(pk=finance_officer_id).first()
            if user is None or get_membership(user, self.organization) is None:
                raise ValidationError(
                    {
                        "finance_officer_id": (
                            "user is not a member of this organization"
                        )
                    }
                )
            payment.assigned_finance_officer = user
        payment.save(update_fields=["assigned_finance_officer", "updated_at"])

        record_audit(
            organization=payment.organization,
            actor=request.user,
            action="payment.assign_finance_officer",
            target=payment,
            before=None,
            after={
                "assigned_finance_officer_id": (
                    str(finance_officer_id) if finance_officer_id else None
                )
            },
        )
        # Live push — assigning changes which finance officer's
        # ``scope=mine`` bucket the row belongs to, so every open tab
        # (including the newly-assigned officer's) needs to invalidate
        # to move the card into the right lane.
        schedule_payment_changed_broadcast(payment, "assigned")
        return Response(PaymentReadSerializer(payment).data)


class PaymentVoidView(APIView):
    """``POST /api/organizations/<org>/payments/<id>/void/`` —
    mark a payment as VOIDED. Forward-only on the LabelDesign side.
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.APPROVE_PAYMENT

    def post(self, request: Request, **kwargs) -> Response:
        payment = (
            Payment.objects.select_related(
                "formulation",
                "customer",
                "label_design",
                "recorded_by",
                "approved_by",
                "assigned_finance_officer",
            )
            .filter(organization=self.organization, id=kwargs["payment_id"])
            .first()
        )
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


class AwaitingDepositsView(APIView):
    """``GET /api/organizations/<org>/payments/awaiting-deposits/``.

    Deposits side of the "Awaiting payment" queue: accepted proposals
    with ``deposit_percent > 0`` that don't yet have an approved
    DEPOSIT ``Payment``. Signing a proposal no longer materialises a
    placeholder Payment row — finance records the deposit off this
    queue once the money lands.

    Same pagination + search shape as ``PendingPaymentProjectsView``.
    Search covers proposal ``code``, customer name/company (denormalised
    columns + FK), and the first bundled formulation's ``code`` / ``name``.
    """

    permission_classes = [HasFinancePermission]
    required_capability = FinanceCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        from decimal import ROUND_HALF_UP, Decimal

        from django.db.models import Q

        from apps.payments.constants import PaymentKind
        from apps.proposals.models import ProposalStatus
        from apps.trial_batches.models import TrialBatch

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

        paid_proposal_ids = set(
            Payment.objects.filter(
                organization=self.organization,
                kind=PaymentKind.DEPOSIT,
                status=PaymentStatus.APPROVED,
            ).values_list("proposal_id", flat=True)
        )
        # Formulations that have already moved past the deposit gate.
        # If any of these are true the deposit is moot and the row
        # would be stale noise on the queue:
        #  * A TrialBatch has been created — the gate was bypassed /
        #    satisfied before this feature existed, so surfacing the
        #    proposal now would ask finance to chase money for work
        #    that already ran.
        #  * A FINAL Payment has been approved — the project is
        #    already at labelling, deposits are ancient history.
        formulations_past_gate = set(
            TrialBatch.objects.filter(
                organization=self.organization,
            ).values_list("formulation_version__formulation_id", flat=True)
        ) | set(
            Payment.objects.filter(
                organization=self.organization,
                kind=PaymentKind.FINAL,
                status=PaymentStatus.APPROVED,
            )
            .exclude(formulation__isnull=True)
            .values_list("formulation_id", flat=True)
        )

        qs = (
            Proposal.objects.filter(
                organization=self.organization,
                status=ProposalStatus.ACCEPTED,
                deposit_percent__gt=0,
            )
            .exclude(id__in=paid_proposal_ids)
            .select_related("customer")
            .prefetch_related("lines__formulation_version__formulation")
        )
        if formulations_past_gate:
            qs = qs.exclude(
                lines__formulation_version__formulation_id__in=formulations_past_gate
            )
        if search:
            qs = qs.filter(
                Q(code__icontains=search)
                | Q(customer__company__icontains=search)
                | Q(customer__name__icontains=search)
                | Q(customer_company__icontains=search)
                | Q(customer_name__icontains=search)
                | Q(
                    lines__formulation_version__formulation__code__icontains=search
                )
                | Q(
                    lines__formulation_version__formulation__name__icontains=search
                )
            ).distinct()
        qs = qs.order_by("updated_at")
        total = qs.count()
        page = list(qs[offset : offset + limit])

        items: list[dict] = []
        for proposal in page:
            first_line = next(iter(proposal.lines.all()), None)
            formulation = (
                first_line.formulation_version.formulation
                if first_line and first_line.formulation_version
                else None
            )
            customer = getattr(proposal, "customer", None)
            customer_name = (
                (getattr(customer, "name", "") if customer else "")
                or (getattr(proposal, "customer_name", "") or "")
            )
            customer_company = (
                (getattr(customer, "company", "") if customer else "")
                or (getattr(proposal, "customer_company", "") or "")
            )
            customer_email = (
                getattr(customer, "email", "") if customer else ""
            )
            subtotal = getattr(proposal, "subtotal", None)
            percent = Decimal(proposal.deposit_percent or 0)
            deposit_amount = None
            if subtotal is not None:
                try:
                    deposit_amount = str(
                        (Decimal(subtotal) * percent / Decimal("100")).quantize(
                            Decimal("0.01"), rounding=ROUND_HALF_UP
                        )
                    )
                except Exception:  # pragma: no cover - defensive
                    deposit_amount = None
            items.append(
                {
                    "proposal_id": str(proposal.id),
                    "proposal_code": proposal.code,
                    "proposal_accepted_at": (
                        proposal.updated_at.isoformat()
                        if proposal.updated_at
                        else None
                    ),
                    "deposit_percent": str(proposal.deposit_percent),
                    "deposit_amount": deposit_amount,
                    "currency": (getattr(proposal, "currency", "") or "").strip(),
                    "formulation_id": str(formulation.id) if formulation else None,
                    "formulation_code": getattr(formulation, "code", "") if formulation else "",
                    "formulation_name": getattr(formulation, "name", "") if formulation else "",
                    "line_count": len(list(proposal.lines.all())),
                    "customer_name": customer_name,
                    "customer_company": customer_company,
                    "customer_email": customer_email,
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
