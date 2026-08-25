"""Views for PaymentFile attachments (invoices).

Mirrors ``FormulationFilesView`` / ``FormulationFileDetailView`` — bytes
land on our storage, one row per attached file. No PSP push; payments
are a local-only concept.
"""

from __future__ import annotations

import mimetypes
from typing import Any

from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.organizations.modules import FinanceCapability
from apps.payments.api.permissions import HasFinancePermission
from apps.payments.api.serializers import PaymentFileReadSerializer
from apps.payments.broadcast import schedule_payment_changed_broadcast
from apps.payments.models import Payment, PaymentFile


_ALLOWED_MIMES = frozenset(
    (
        "application/pdf",
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/plain",
    )
)
_MAX_BYTES = 20 * 1024 * 1024


def _payload(row: PaymentFile) -> dict[str, Any]:
    return PaymentFileReadSerializer(row).data


class PaymentInvoicesView(APIView):
    """``GET`` list + ``POST`` upload for a payment's invoice files."""

    permission_classes = (HasFinancePermission,)
    parser_classes = (MultiPartParser, FormParser)

    def initial(self, request: Request, *args, **kwargs) -> None:
        # Uploading counts as a payment edit — same cap as recording.
        self.required_capability = (
            FinanceCapability.RECORD_PAYMENT
            if request.method == "POST"
            else FinanceCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _get_payment(self, payment_id: str) -> Payment:
        payment = (
            Payment.objects.filter(
                organization=self.organization, id=payment_id
            )
            .prefetch_related("invoices")
            .first()
        )
        if payment is None:
            raise NotFound()
        return payment

    def get(self, request: Request, org_id: str, payment_id: str) -> Response:
        payment = self._get_payment(payment_id)
        rows = payment.invoices.all()
        return Response({"items": [_payload(r) for r in rows]})

    def post(self, request: Request, org_id: str, payment_id: str) -> Response:
        payment = self._get_payment(payment_id)
        upload = request.FILES.get("file")
        if upload is None:
            return Response(
                {"error": "missing_file", "detail": "Send the file under `file`."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        mime = upload.content_type or mimetypes.guess_type(upload.name or "")[0]
        if not mime or mime not in _ALLOWED_MIMES:
            return Response(
                {
                    "error": "invalid_mime_type",
                    "detail": f"Unsupported file type ({mime or 'unknown'}).",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        if upload.size > _MAX_BYTES:
            return Response(
                {
                    "error": "file_too_large",
                    "detail": f"Max {_MAX_BYTES // 1024 // 1024} MB.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        row = PaymentFile.objects.create(
            payment=payment,
            file=upload,
            filename=upload.name or "invoice",
            mime=mime,
            byte_size=upload.size or 0,
            uploaded_by=request.user,
        )
        # Push the new file into PSP's CO detail card so the invoice
        # section stays in sync without waiting for the next Create-MO
        # click. Custom projects re-sync via the main formulation
        # sync's ``payments`` list; RTG stays on the sample-CO path.
        from apps.psp.services import maybe_resync_payment_to_psp
        maybe_resync_payment_to_psp(payment=payment)
        # Live push — the invoice-count paperclip on the payment card
        # bumps without a reload. Same channel the record/approve/void
        # paths use so the FE hook doesn't need to distinguish.
        schedule_payment_changed_broadcast(payment, "invoice_attached")
        return Response({"file": _payload(row)}, status=status.HTTP_201_CREATED)


class PaymentInvoiceDetailView(APIView):
    """``DELETE`` a specific invoice file off a payment."""

    permission_classes = (HasFinancePermission,)
    required_capability = FinanceCapability.RECORD_PAYMENT

    def delete(
        self,
        request: Request,
        org_id: str,
        payment_id: str,
        file_id: str,
    ) -> Response:
        payment = (
            Payment.objects.filter(
                organization=self.organization, id=payment_id
            )
            .first()
        )
        if payment is None:
            raise NotFound()
        row = payment.invoices.filter(id=file_id).first()
        if row is None:
            raise NotFound()
        row.file.delete(save=False)
        row.delete()
        # Drop the file from the PSP mirror too so the CO detail card
        # doesn't keep showing a filename whose bytes are gone. Custom
        # projects re-sync the whole payments list; RTG rides the
        # sample-CO sync path.
        from apps.psp.services import maybe_resync_payment_to_psp
        maybe_resync_payment_to_psp(payment=payment)
        # Same live push as attach — the paperclip / count updates
        # on every open finance tab.
        schedule_payment_changed_broadcast(payment, "invoice_attached")
        return Response(status=status.HTTP_204_NO_CONTENT)
