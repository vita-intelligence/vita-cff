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
    KioskSignaturesPending,
    KioskSpecNotOnProposal,
    MissingRequiredFields,
    ProposalCodeConflict,
    ProposalLineNotFound,
    ProposalNotFound,
    ProposalPublicLinkNotEnabled,
    ProposalSalesPersonNotMember,
    SignatureRequired,
    SpecificationSheetNotInOrg,
    add_proposal_line,
    capture_customer_signature_on_attached_spec,
    capture_customer_signature_on_proposal,
    compute_material_cost_per_pack,
    create_proposal,
    delete_proposal,
    delete_proposal_line,
    finalize_proposal_kiosk,
    get_proposal,
    get_proposal_by_public_token,
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


# ---------------------------------------------------------------------------
# Proposal-centric kiosk (public, token-gated, no org auth)
#
# The client shares a proposal via its ``public_token`` — the URL is
# ``/p/proposal/<token>``. Each document on the proposal (the
# proposal itself + every attached specification sheet) is signed
# independently. Signatures are captured as they're drawn but nothing
# advances to ``accepted`` until the finalize call runs, which checks
# every document has been signed before flipping the lot atomically.
#
# These endpoints deliberately sit outside the org-scoped routes —
# the signer is not a member, only the token proves access. We still
# require a kiosk session cookie so the signer establishes identity
# (name / email / company) before their signature gets written, which
# also matches the existing ``/api/public/specifications/<token>/``
# contract.
# ---------------------------------------------------------------------------


from rest_framework.permissions import AllowAny


def _public_kiosk_identity(request: Request, token: str):
    """Resolve the kiosk-session identity for a public request or
    raise the matching 403 so views stay uniform."""

    from apps.comments.kiosk import (
        KioskSessionInvalid,
        KioskSessionRevoked,
        KioskTokenInvalid,
        resolve_from_request,
    )

    try:
        return resolve_from_request(request, token)
    except (
        KioskSessionInvalid,
        KioskSessionRevoked,
        KioskTokenInvalid,
    ):
        return None


def _render_public_proposal_payload(proposal) -> dict:
    """Shape the proposal kiosk JSON for the ``/p/proposal/<token>``
    page. Returns the proposal's top-level fields needed to paint
    the cover letter + price lines, plus a list of attached spec
    sheets with their public-facing identity and per-document sign
    status. The client uses this to know which signature pads to
    render and which ones are already complete."""

    # Local import avoids pulling proposals.services at module load —
    # keeps Django's app-ready order simple.
    from apps.proposals.services import _attached_spec_sheets

    attached = _attached_spec_sheets(proposal)
    specs_payload = [
        {
            "id": str(sheet.id),
            "code": sheet.code or "",
            "document_kind": sheet.document_kind,
            "formulation_name": (
                sheet.formulation_version.formulation.name
                if sheet.formulation_version_id
                else ""
            ),
            "formulation_version_number": (
                sheet.formulation_version.version_number
                if sheet.formulation_version_id
                else None
            ),
            "public_token": (
                str(sheet.public_token) if sheet.public_token else None
            ),
            "status": sheet.status,
            "customer_signed_at": (
                sheet.customer_signed_at.isoformat()
                if sheet.customer_signed_at is not None
                else None
            ),
            "has_signature": bool(sheet.customer_signature_image),
        }
        for sheet in attached
    ]

    return {
        "id": str(proposal.id),
        "code": proposal.code,
        "status": proposal.status,
        "customer_company": proposal.customer_company,
        "customer_name": proposal.customer_name,
        "reference": proposal.reference,
        "dear_name": proposal.dear_name,
        "currency": proposal.currency,
        "total_excl_vat": (
            str(proposal.total_excl_vat)
            if proposal.total_excl_vat is not None
            else None
        ),
        "customer_signed_at": (
            proposal.customer_signed_at.isoformat()
            if proposal.customer_signed_at is not None
            else None
        ),
        "has_signature": bool(proposal.customer_signature_image),
        "attached_specs": specs_payload,
    }


class PublicProposalKioskView(APIView):
    """``GET`` ``/api/public/proposals/<token>/``.

    Returns the JSON payload used by the kiosk page to render the
    proposal alongside every attached spec sheet. No kiosk session
    required on the GET — establishing identity is deferred until
    the client actually tries to sign something, so shareable links
    can be previewed before committing.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> Response:
        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc
        return Response(
            _render_public_proposal_payload(proposal),
            status=status.HTTP_200_OK,
        )


class PublicProposalSignProposalView(APIView):
    """``POST`` ``/api/public/proposals/<token>/sign/``.

    Captures the customer's signature on the proposal itself.
    Signature image + signer identity lands in the DB; proposal stays
    at ``sent`` until the finalize call fires. Identity is pulled off
    the kiosk session cookie — the signer must have completed the
    session-entry flow first so their name / email / company are
    bound to the token.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        from config.signatures import SignatureImageInvalid

        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        identity = _public_kiosk_identity(request, str(token))
        if identity is None:
            return Response(
                {"detail": ["kiosk_session_required"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        session = identity.session

        signature_image = (request.data or {}).get("signature_image") or ""
        try:
            updated = capture_customer_signature_on_proposal(
                proposal=proposal,
                signer_name=session.guest_name,
                signer_email=session.guest_email or "",
                signer_company=session.guest_org_label or "",
                signature_image=signature_image,
            )
        except InvalidProposalTransition:
            return Response(
                {"status": ["invalid_proposal_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except (SignatureRequired, SignatureImageInvalid):
            return Response(
                {"signature_image": ["signature_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {
                "customer_signed_at": (
                    updated.customer_signed_at.isoformat()
                    if updated.customer_signed_at is not None
                    else None
                ),
            },
            status=status.HTTP_200_OK,
        )


class PublicProposalSignSpecView(APIView):
    """``POST`` ``/api/public/proposals/<token>/specs/<sheet_id>/sign/``.

    Captures the customer's signature on a specification sheet
    attached to this proposal. Rejects sheets that aren't on this
    proposal so a crafted URL can't stamp a signature onto an
    unrelated document.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str, sheet_id: str) -> Response:
        from config.signatures import SignatureImageInvalid
        from apps.specifications.services import (
            InvalidStatusTransition as SpecInvalidStatusTransition,
        )

        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        identity = _public_kiosk_identity(request, str(token))
        if identity is None:
            return Response(
                {"detail": ["kiosk_session_required"]},
                status=status.HTTP_403_FORBIDDEN,
            )
        session = identity.session

        signature_image = (request.data or {}).get("signature_image") or ""
        try:
            updated = capture_customer_signature_on_attached_spec(
                proposal=proposal,
                sheet_id=sheet_id,
                signer_name=session.guest_name,
                signer_email=session.guest_email or "",
                signer_company=session.guest_org_label or "",
                signature_image=signature_image,
            )
        except KioskSpecNotOnProposal:
            # Same 404 shape as an unknown token — don't leak which
            # sheet ids do exist in the org.
            raise NotFound()
        except SpecInvalidStatusTransition:
            return Response(
                {"status": ["invalid_status_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except (SignatureRequired, SignatureImageInvalid):
            return Response(
                {"signature_image": ["signature_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {
                "id": str(updated.id),
                "customer_signed_at": (
                    updated.customer_signed_at.isoformat()
                    if updated.customer_signed_at is not None
                    else None
                ),
            },
            status=status.HTTP_200_OK,
        )


class PublicProposalFinalizeView(APIView):
    """``POST`` ``/api/public/proposals/<token>/finalize/``.

    Flips the proposal and every attached spec from ``sent`` to
    ``accepted`` — only succeeds when every document has a captured
    signature. Returns a ``kiosk_signatures_pending`` error carrying
    the list of still-pending document ids otherwise so the client
    can scroll back and collect the missing ones.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        identity = _public_kiosk_identity(request, str(token))
        if identity is None:
            return Response(
                {"detail": ["kiosk_session_required"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            result = finalize_proposal_kiosk(proposal=proposal)
        except InvalidProposalTransition:
            return Response(
                {"status": ["invalid_proposal_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except KioskSignaturesPending as exc:
            return Response(
                {
                    "detail": ["kiosk_signatures_pending"],
                    "pending": list(exc.args[0]) if exc.args else [],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(result, status=status.HTTP_200_OK)
