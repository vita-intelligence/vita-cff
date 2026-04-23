"""API views for the proposals app.

Every endpoint is gated by :class:`HasFormulationsPermission` — the
proposal lives alongside the spec sheet inside a formulation project,
so it shares the same ``formulations.*`` capability surface.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from django.http import HttpResponse
from django.template.loader import render_to_string
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.proposals.render import render_docx_bytes, render_pdf_bytes

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from apps.proposals.api.serializers import (
    ProposalCreateSerializer,
    ProposalLineReadSerializer,
    ProposalLineWriteSerializer,
    ProposalReadSerializer,
    ProposalStatusSerializer,
    ProposalTransitionSerializer,
    ProposalUpdateSerializer,
)
from apps.proposals.services import (
    CustomerNotInOrg,
    FormulationVersionNotInOrg,
    InvalidProposalTransition,
    MissingRequiredFields,
    ProposalCodeConflict,
    ProposalLineNotFound,
    ProposalNotFound,
    ProposalSalesPersonNotMember,
    SignatureRequired,
    SpecificationSheetNotInOrg,
    add_proposal_line,
    compute_material_cost_per_pack,
    create_proposal,
    delete_proposal,
    delete_proposal_line,
    get_proposal,
    list_proposals,
    suggest_unit_price,
    transition_status,
    update_proposal,
    update_proposal_line,
)
from apps.formulations.models import FormulationVersion


class ProposalListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/proposals/``.

    Optional ``?formulation_id=<uuid>`` scopes the list down to one
    project's proposals so the project workspace panel doesn't have
    to filter client-side.
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
        formulation_id = request.query_params.get("formulation_id") or None
        queryset = list_proposals(
            organization=self.organization,
            formulation_id=formulation_id,
        )
        serializer = ProposalReadSerializer(queryset, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def post(self, request: Request, org_id: str) -> Response:
        serializer = ProposalCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            proposal = create_proposal(
                organization=self.organization,
                actor=request.user,
                formulation_version_id=data["formulation_version_id"],
                specification_sheet_id=data.get("specification_sheet_id"),
                customer_id=data.get("customer_id"),
                template_type=data.get("template_type"),
                code=data.get("code", ""),
                customer_name=data.get("customer_name", ""),
                customer_email=data.get("customer_email", ""),
                customer_phone=data.get("customer_phone", ""),
                customer_company=data.get("customer_company", ""),
                invoice_address=data.get("invoice_address", ""),
                delivery_address=data.get("delivery_address", ""),
                dear_name=data.get("dear_name", ""),
                reference=data.get("reference", ""),
                currency=data.get("currency", "GBP"),
                quantity=data.get("quantity", 1),
                unit_price=data.get("unit_price"),
                freight_amount=data.get("freight_amount"),
                margin_percent=data.get("margin_percent"),
                material_cost_per_pack=data.get("material_cost_per_pack"),
                cover_notes=data.get("cover_notes", ""),
                valid_until=data.get("valid_until"),
            )
        except FormulationVersionNotInOrg:
            return Response(
                {"formulation_version_id": ["formulation_version_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CustomerNotInOrg:
            return Response(
                {"customer_id": ["customer_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProposalCodeConflict:
            return Response(
                {"code": ["proposal_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            ProposalReadSerializer(proposal).data,
            status=status.HTTP_201_CREATED,
        )


class ProposalDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/api/organizations/<org>/proposals/<id>/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, proposal_id: str):
        try:
            return get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, proposal_id: str) -> Response:
        proposal = self._load(proposal_id)
        return Response(ProposalReadSerializer(proposal).data)

    def patch(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        proposal = self._load(proposal_id)
        serializer = ProposalUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_proposal(
                proposal=proposal,
                actor=request.user,
                **serializer.validated_data,
            )
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CustomerNotInOrg:
            return Response(
                {"customer_id": ["customer_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProposalSalesPersonNotMember:
            return Response(
                {"sales_person_id": ["sales_person_not_member"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(ProposalReadSerializer(updated).data)

    def delete(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        proposal = self._load(proposal_id)
        delete_proposal(proposal=proposal, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProposalStatusView(APIView):
    """``POST`` ``/.../proposals/<id>/status/`` — transition the sheet
    one step along its state machine."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

        serializer = ProposalStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        customer_info = {
            "name": data.get("customer_name", ""),
            "email": data.get("customer_email", ""),
            "company": data.get("customer_company", ""),
        }
        try:
            updated = transition_status(
                proposal=proposal,
                actor=request.user,
                to_status=data["status"],
                signature_image=data.get("signature_image", ""),
                customer_info=customer_info,
                notes=data.get("notes", ""),
            )
        except InvalidProposalTransition:
            return Response(
                {"status": ["invalid_proposal_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except MissingRequiredFields as exc:
            # Surface the exact list of missing fields so the client
            # can pop a "please fill these in" modal rather than a
            # generic error banner.
            return Response(
                {
                    "missing_required_fields": exc.missing,
                    "detail": ["missing_required_fields"],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SignatureRequired:
            return Response(
                {"signature_image": ["signature_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(ProposalReadSerializer(updated).data)


class ProposalTransitionsView(APIView):
    """``GET`` ``/.../proposals/<id>/transitions/`` — timeline of
    status changes used by the detail page's audit sidebar."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc
        rows = proposal.transitions.select_related("actor").all()
        return Response(
            ProposalTransitionSerializer(rows, many=True).data,
            status=status.HTTP_200_OK,
        )


class ProposalRenderView(APIView):
    """``GET`` ``/.../proposals/<id>/render/`` — inline preview of the
    proposal as PDF (converted from the original .docx template).

    Tries LibreOffice / Microsoft Word conversion first so the viewer
    sees the real Vita NPD letterhead byte-for-byte. Falls back to the
    HTML approximation only when no converter is available — lets the
    feature keep working on CI containers / Linux boxes without Word.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, proposal_id: str
    ) -> HttpResponse:
        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

        pdf_bytes = render_pdf_bytes(proposal)
        if pdf_bytes is not None:
            response = HttpResponse(pdf_bytes, content_type="application/pdf")
            filename = f"{proposal.code or 'proposal'}.pdf"
            disposition = (
                "attachment"
                if request.query_params.get("download") in {"1", "true"}
                else "inline"
            )
            response["Content-Disposition"] = (
                f'{disposition}; filename="{filename}"'
            )
            return response

        # Fallback HTML render — kept deliberately simple; scientists
        # on a Word-less box still see *something* legible.
        version = proposal.formulation_version
        metadata = version.snapshot_metadata or {}
        html = render_to_string(
            "proposals/sheet.html",
            {
                "proposal": proposal,
                "formulation": {
                    "code": metadata.get("code") or version.formulation.code,
                    "name": metadata.get("name") or version.formulation.name,
                },
                "subtotal": proposal.subtotal,
                "total_excl_vat": proposal.total_excl_vat,
            },
        )
        return HttpResponse(html)


class ProposalDocxView(APIView):
    """``GET`` ``/.../proposals/<id>/docx/`` — download the filled
    .docx so sales can email it or tweak the copy manually before
    sending."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, proposal_id: str
    ) -> HttpResponse:
        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc
        docx_bytes = render_docx_bytes(proposal)
        response = HttpResponse(
            docx_bytes,
            content_type=(
                "application/vnd.openxmlformats-officedocument"
                ".wordprocessingml.document"
            ),
        )
        filename = f"{proposal.code or 'proposal'}.docx"
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class ProposalLineListCreateView(APIView):
    """``GET`` / ``POST``
    ``/api/organizations/<org>/proposals/<id>/lines/``.

    Lists every product line on a proposal (ordered) and lets the
    scientist add a new one. Creating a line pinned to a formulation
    version resolves the catalogue snapshot into the line's
    ``product_code`` / ``description`` so the pricing table renders
    plausible values immediately.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.VIEW
            if request.method == "GET"
            else FormulationsCapability.EDIT
        )
        super().initial(request, *args, **kwargs)

    def _load(self, proposal_id: str):
        try:
            return get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        proposal = self._load(proposal_id)
        rows = proposal.lines.select_related(
            "formulation_version__formulation", "specification_sheet"
        ).all()
        return Response(
            ProposalLineReadSerializer(rows, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        proposal = self._load(proposal_id)
        serializer = ProposalLineWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            line = add_proposal_line(
                proposal=proposal,
                actor=request.user,
                formulation_version_id=data.get("formulation_version_id"),
                specification_sheet_id=data.get("specification_sheet_id"),
                product_code=data.get("product_code", ""),
                description=data.get("description", ""),
                quantity=data.get("quantity", 1),
                unit_cost=data.get("unit_cost"),
                unit_price=data.get("unit_price"),
                display_order=data.get("display_order"),
            )
        except FormulationVersionNotInOrg:
            return Response(
                {"formulation_version_id": ["formulation_version_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CustomerNotInOrg:
            return Response(
                {"customer_id": ["customer_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            ProposalLineReadSerializer(line).data,
            status=status.HTTP_201_CREATED,
        )


class ProposalLineDetailView(APIView):
    """``PATCH`` / ``DELETE``
    ``/api/organizations/<org>/proposals/<id>/lines/<line_id>/``."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def _load(self, proposal_id: str):
        try:
            return get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

    def patch(
        self,
        request: Request,
        org_id: str,
        proposal_id: str,
        line_id: str,
    ) -> Response:
        proposal = self._load(proposal_id)
        serializer = ProposalLineWriteSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        try:
            line = update_proposal_line(
                proposal=proposal,
                line_id=line_id,
                actor=request.user,
                **serializer.validated_data,
            )
        except ProposalLineNotFound as exc:
            raise NotFound() from exc
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CustomerNotInOrg:
            return Response(
                {"customer_id": ["customer_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            ProposalLineReadSerializer(line).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self,
        request: Request,
        org_id: str,
        proposal_id: str,
        line_id: str,
    ) -> Response:
        proposal = self._load(proposal_id)
        try:
            delete_proposal_line(
                proposal=proposal,
                line_id=line_id,
                actor=request.user,
            )
        except ProposalLineNotFound as exc:
            raise NotFound() from exc
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProposalCostPreviewView(APIView):
    """``GET`` ``/.../formulation-versions/<id>/cost-preview/``.

    Pure read — rolls the snapshot's raw-material costs into a
    per-pack number and returns a suggested unit price for a given
    ``?margin=<pct>``. The Create Proposal modal hits this to
    pre-fill the unit price field before the scientist clicks Submit.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, version_id: str
    ) -> Response:
        version = (
            FormulationVersion.objects.select_related("formulation")
            .filter(id=version_id)
            .first()
        )
        if (
            version is None
            or version.formulation.organization_id != self.organization.id
        ):
            raise NotFound()
        material_cost = compute_material_cost_per_pack(version)
        margin_raw = request.query_params.get("margin")
        margin: Decimal | None
        try:
            margin = Decimal(margin_raw) if margin_raw else None
        except Exception:
            margin = None
        suggested = suggest_unit_price(material_cost, margin)
        return Response(
            {
                "material_cost_per_pack": str(material_cost),
                "margin_percent": str(margin) if margin is not None else None,
                "suggested_unit_price": str(suggested),
                "currency": "GBP",
            },
            status=status.HTTP_200_OK,
        )
