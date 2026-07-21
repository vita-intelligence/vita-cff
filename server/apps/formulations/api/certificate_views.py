"""Views for FormulationCertificate — the per-formulation
certificate attach panel that mirrors PSP's item-detail Certificates
section.

Lifecycle:
    1. GET  /formulations/:id/certificates/  → list attached rows.
    2. GET  /formulations/:id/certificates/catalog/ → PSP registry
       (proxies the integration ``/certificates`` endpoint) so the FE
       renders a picker of certs the operator is allowed to attach.
    3. POST /formulations/:id/certificates/  → attach one. Persists
       locally + best-effort attach on PSP; response carries the
       stored ``psp_attachment_uuid`` so the FE knows it landed.
    4. PATCH /formulations/:id/certificates/:cert_id/ → edit the
       per-attachment fields (number, valid_from, valid_until). PSP
       doesn't support in-place edit via the integration surface, so
       an edit becomes detach + reattach — same visible outcome for
       the operator.
    5. DELETE /formulations/:id/certificates/:cert_id/ → detach
       locally + best-effort detach on PSP.
"""

from __future__ import annotations

import logging
from datetime import date
from typing import Any

from django.db import transaction
from django.utils.dateparse import parse_date
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.models import (
    Formulation,
    FormulationCertificate,
)
from apps.formulations.services import (
    FormulationNotFound,
    get_formulation,
)
from apps.organizations.modules import FormulationsCapability

logger = logging.getLogger(__name__)


def _cert_payload(row: FormulationCertificate) -> dict[str, Any]:
    return {
        "id": str(row.id),
        "psp_certificate_uuid": str(row.psp_certificate_uuid),
        "psp_certificate_name": row.psp_certificate_name,
        "psp_certificate_type": row.psp_certificate_type,
        "psp_issuing_body": row.psp_issuing_body,
        "certificate_number": row.certificate_number,
        "valid_from": row.valid_from.isoformat() if row.valid_from else None,
        "valid_until": row.valid_until.isoformat() if row.valid_until else None,
        "psp_attachment_uuid": (
            str(row.psp_attachment_uuid)
            if row.psp_attachment_uuid
            else None
        ),
        "attached_at": row.attached_at.isoformat(),
    }


def _psp_client_for(formulation: Formulation):
    """Return a PspClient for the org, or ``None`` when PSP isn't
    live. Same shape as ``photo_file_views._psp_client_for``."""

    from apps.psp.services import (
        PspInvalidConfig,
        _client_factory,
        get_psp_config,
        is_psp_live,
    )

    if not is_psp_live(formulation.organization):
        return None
    try:
        config = get_psp_config(organization=formulation.organization)
        return _client_factory(config)
    except PspInvalidConfig:
        return None


def _attach_on_psp(
    formulation: Formulation,
    row: FormulationCertificate,
) -> None:
    """Best-effort attach — cascade continues on any PSP failure."""

    client = _psp_client_for(formulation)
    if client is None or not formulation.psp_finished_product_uuid:
        return
    from apps.psp.services import PspError

    valid_from = row.valid_from.isoformat() if row.valid_from else None
    valid_until = row.valid_until.isoformat() if row.valid_until else None
    try:
        response = client.attach_item_certificate(
            str(formulation.psp_finished_product_uuid),
            certificate_uuid=str(row.psp_certificate_uuid),
            certificate_number=row.certificate_number or None,
            valid_from=valid_from,
            valid_until=valid_until,
        )
    except PspError as exc:
        logger.info("cert attach: soft-fail: %s", exc)
        return
    if response and response.get("uuid"):
        row.psp_attachment_uuid = str(response["uuid"])
        row.save(update_fields=["psp_attachment_uuid"])


def _detach_on_psp(
    formulation: Formulation, attachment_uuid: str
) -> None:
    client = _psp_client_for(formulation)
    if client is None or not formulation.psp_finished_product_uuid:
        return
    client.detach_item_certificate(
        str(formulation.psp_finished_product_uuid), attachment_uuid
    )


def _parse_optional_date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        parsed = parse_date(value)
        if parsed is not None:
            return parsed
    return None


class FormulationCertificatesView(APIView):
    """``GET`` list + ``POST`` attach for a formulation's certificates."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request, *args, **kwargs):  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _get_formulation(self, formulation_id: str) -> Formulation:
        try:
            return get_formulation(
                organization=self.organization,
                formulation_id=formulation_id,
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._get_formulation(formulation_id)
        rows = formulation.certificates.all()
        return Response({"items": [_cert_payload(r) for r in rows]})

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._get_formulation(formulation_id)
        data = request.data
        cert_uuid = str(data.get("psp_certificate_uuid") or "").strip()
        if not cert_uuid:
            return Response(
                {
                    "error": "missing_certificate",
                    "detail": "psp_certificate_uuid is required.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        # Reject duplicates locally — PSP would reject it too since
        # the ``(item_id, certificate_id)`` pair is unique there, but
        # a clean 400 up front saves a round-trip.
        if formulation.certificates.filter(
            psp_certificate_uuid=cert_uuid
        ).exists():
            return Response(
                {
                    "error": "already_attached",
                    "detail": (
                        "This certificate is already attached to the "
                        "formulation."
                    ),
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        name = str(data.get("psp_certificate_name") or "").strip()[:200]
        cert_type = str(data.get("psp_certificate_type") or "").strip()[:64]
        issuing = str(data.get("psp_issuing_body") or "").strip()[:200]
        number = str(data.get("certificate_number") or "").strip()[:200]
        valid_from = _parse_optional_date(data.get("valid_from"))
        valid_until = _parse_optional_date(data.get("valid_until"))
        with transaction.atomic():
            row = FormulationCertificate.objects.create(
                formulation=formulation,
                psp_certificate_uuid=cert_uuid,
                psp_certificate_name=name or "(unnamed)",
                psp_certificate_type=cert_type,
                psp_issuing_body=issuing,
                certificate_number=number,
                valid_from=valid_from,
                valid_until=valid_until,
                attached_by=request.user,
            )
        _attach_on_psp(formulation, row)
        row.refresh_from_db()
        return Response(
            {"certificate": _cert_payload(row)},
            status=status.HTTP_201_CREATED,
        )


class FormulationCertificateDetailView(APIView):
    """``PATCH`` edit + ``DELETE`` detach one attached certificate."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def _get_row(
        self, formulation_id: str, cert_id: str
    ) -> tuple[Formulation, FormulationCertificate]:
        try:
            formulation = get_formulation(
                organization=self.organization,
                formulation_id=formulation_id,
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        row = formulation.certificates.filter(id=cert_id).first()
        if row is None:
            raise NotFound()
        return formulation, row

    def patch(
        self,
        request: Request,
        org_id: str,
        formulation_id: str,
        cert_id: str,
    ) -> Response:
        formulation, row = self._get_row(formulation_id, cert_id)
        data = request.data
        # PATCH updates local fields immediately. If the row already
        # landed on PSP (has ``psp_attachment_uuid``), replay the
        # attach — detach the old, attach a new. PSP-side attachments
        # aren't editable through the integration surface, so this
        # is the cleanest way to keep both sides in sync without a
        # new endpoint.
        changed = False
        if "certificate_number" in data:
            row.certificate_number = str(
                data.get("certificate_number") or ""
            ).strip()[:200]
            changed = True
        if "valid_from" in data:
            row.valid_from = _parse_optional_date(data.get("valid_from"))
            changed = True
        if "valid_until" in data:
            row.valid_until = _parse_optional_date(data.get("valid_until"))
            changed = True
        if not changed:
            return Response({"certificate": _cert_payload(row)})
        with transaction.atomic():
            row.save(
                update_fields=[
                    "certificate_number",
                    "valid_from",
                    "valid_until",
                ]
            )
        # Replay attach on PSP: detach the stale attachment, then
        # re-attach with the new fields so the PSP row reflects the
        # edit. Silent-degrade — the local edit sticks regardless.
        if row.psp_attachment_uuid:
            _detach_on_psp(formulation, str(row.psp_attachment_uuid))
            row.psp_attachment_uuid = None
            row.save(update_fields=["psp_attachment_uuid"])
        _attach_on_psp(formulation, row)
        row.refresh_from_db()
        return Response({"certificate": _cert_payload(row)})

    def delete(
        self,
        request: Request,
        org_id: str,
        formulation_id: str,
        cert_id: str,
    ) -> Response:
        formulation, row = self._get_row(formulation_id, cert_id)
        psp_attachment = (
            str(row.psp_attachment_uuid) if row.psp_attachment_uuid else None
        )
        with transaction.atomic():
            row.delete()
        if psp_attachment:
            _detach_on_psp(formulation, psp_attachment)
        return Response(status=status.HTTP_204_NO_CONTENT)


class FormulationCertificateCatalogView(APIView):
    """Proxy the PSP certificate registry to the FE picker. Empty
    list when PSP isn't live so the FE renders "no certs yet" the
    same way as a genuinely empty catalog."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization,
                formulation_id=formulation_id,
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        client = _psp_client_for(formulation)
        if client is None:
            return Response({"items": []})
        rows = client.list_certificates()
        # Pass through what PSP emits; the FE filters + renders it.
        return Response({"items": rows})
