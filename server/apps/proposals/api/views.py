"""API views for the proposals app.

Every endpoint is gated by :class:`HasProposalsPermission` — proposals
carry their own capability surface (``proposals.*``) so commercial
roles can be granted the proposal pipeline without the broader
``formulations.*`` project-edit rights. A data migration mirrors any
pre-existing ``formulations.*`` grants onto the new module so members
do not lose access on upgrade.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any

from django.http import HttpResponse
from django.template.loader import render_to_string
from django.utils.decorators import method_decorator
from django.views.decorators.clickjacking import xframe_options_sameorigin
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView


def _client_ip(request: Request) -> str:
    """Return the caller's IP, honouring App Service's reverse proxy.

    Azure App Service rewrites ``REMOTE_ADDR`` to the front-door IP;
    the real client IP lands in ``X-Forwarded-For`` as a comma-separated
    chain (the left-most entry is the original client). We trust the
    left-most hop because in our hosting topology nothing untrusted
    sits in front of App Service. Strip a possible ``:port`` suffix
    that some proxies append for IPv4 entries.

    Falls back to ``REMOTE_ADDR`` for direct hits (local dev, health
    probes). Caps at 45 chars to match the DB column width (IPv6).
    """

    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            # Trim ``:port`` for IPv4-with-port (``a.b.c.d:1234``);
            # don't touch IPv6 which contains its own colons.
            if first.count(":") == 1:
                first = first.rsplit(":", 1)[0]
            return first[:45]
    remote = request.META.get("REMOTE_ADDR", "") or ""
    return remote[:45]


def _user_agent(request: Request) -> str:
    """Return the raw ``User-Agent`` header (empty string if absent)."""

    return request.META.get("HTTP_USER_AGENT", "") or ""


def _document_hash(payload: str) -> str:
    """Return the SHA-256 hex digest of a canonical payload string.

    Callers should pass the output of :func:`_canonical_proposal_payload`
    or :func:`_canonical_spec_payload` — a deterministic JSON
    serialisation of the **contract data** the signer agreed to (not
    the rendered HTML). Hashing structured data instead of rendered
    HTML means template / CSS / wording fixes ship through deploys
    without triggering false-positive "Document has changed since
    signing" badges on every prior signature.
    """

    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _canonical_proposal_payload(proposal) -> str:
    """Serialise the proposal's contract-bearing fields as canonical
    JSON for hashing.

    Includes only the things that legally constitute "what the
    customer agreed to": their contact info, the pricing, the line
    items, the acknowledgement boxes they ticked, and the signature
    block (signer identity + image + signed-at + source IP / UA).
    Excludes anything presentational (template_type-driven copy,
    rendered HTML, dates we display but don't store, etc.) so the
    digest is stable across template revisions.

    Decimals and dates are coerced to strings via Django's natural
    ``str()`` representation. ``sort_keys=True`` pins the field
    order so two equivalent dicts always serialise identically.
    """

    payload: dict[str, Any] = {
        "code": proposal.code or "",
        "template_type": proposal.template_type or "",
        "currency": proposal.currency or "",
        "customer_name": proposal.customer_name or "",
        "customer_company": proposal.customer_company or "",
        "customer_email": proposal.customer_email or "",
        "customer_phone": proposal.customer_phone or "",
        "invoice_address": proposal.invoice_address or "",
        "delivery_address": proposal.delivery_address or "",
        "reference": proposal.reference or "",
        "dear_name": proposal.dear_name or "",
        "quantity": proposal.quantity,
        "unit_price": (
            str(proposal.unit_price) if proposal.unit_price is not None else None
        ),
        "freight_amount": (
            str(proposal.freight_amount)
            if proposal.freight_amount is not None
            else None
        ),
        "subtotal": (
            str(proposal.subtotal) if proposal.subtotal is not None else None
        ),
        "total_excl_vat": (
            str(proposal.total_excl_vat)
            if proposal.total_excl_vat is not None
            else None
        ),
        "valid_until": (
            proposal.valid_until.isoformat()
            if proposal.valid_until is not None
            else None
        ),
        # Line ordering matches the template's ``display_order,
        # created_at`` rule so the hash matches the order the customer
        # saw on the kiosk.
        "lines": [
            {
                "product_code": line.product_code or "",
                "description": line.description or "",
                "quantity": line.quantity,
                "unit_cost": (
                    str(line.unit_cost) if line.unit_cost is not None else None
                ),
                "unit_price": (
                    str(line.unit_price) if line.unit_price is not None else None
                ),
                "subtotal": (
                    str(line.subtotal) if line.subtotal is not None else None
                ),
                "specification_sheet_id": (
                    str(line.specification_sheet_id)
                    if line.specification_sheet_id is not None
                    else None
                ),
                "formulation_version_id": (
                    str(line.formulation_version_id)
                    if line.formulation_version_id is not None
                    else None
                ),
            }
            for line in proposal.lines.all().order_by(
                "display_order", "created_at"
            )
        ],
        "acks": {
            "spec_signing": bool(proposal.ack_spec_signing),
            "lead_times": bool(proposal.ack_lead_times),
            "terms": bool(proposal.ack_terms),
            "rd_terms": bool(proposal.ack_rd_terms),
        },
        # Signature block — the signature itself is part of what the
        # audit attests to, so it goes into the hash. IP / UA are
        # captured at sign time and shouldn't change after; including
        # them in the hash flags tampering of the audit metadata too.
        "signature": {
            "signer_name": proposal.customer_signer_name or "",
            "signer_email": proposal.customer_signer_email or "",
            "signer_company": proposal.customer_signer_company or "",
            "signed_at": (
                proposal.customer_signed_at.isoformat()
                if proposal.customer_signed_at is not None
                else None
            ),
            "image": proposal.customer_signature_image or "",
            "ip": proposal.customer_sign_ip or "",
            "user_agent": proposal.customer_sign_user_agent or "",
        },
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _canonical_spec_payload(sheet) -> str:
    """Serialise a spec sheet's contract-bearing fields as canonical
    JSON for hashing.

    Same philosophy as :func:`_canonical_proposal_payload`. The
    formulation version is captured by ``formulation_version_id``,
    which is immutable on the version model — including the id is
    enough to fingerprint the entire recipe + nutrition + compliance
    payload without serialising the snapshot itself.
    """

    payload: dict[str, Any] = {
        "code": sheet.code or "",
        "document_kind": getattr(sheet, "document_kind", "") or "",
        "formulation_version_id": (
            str(sheet.formulation_version_id)
            if sheet.formulation_version_id is not None
            else None
        ),
        "customer_name": sheet.customer_name or "",
        "customer_email": sheet.customer_email or "",
        "customer_company": sheet.customer_company or "",
        "limits_override": sheet.limits_override or {},
        # Two staff-driven render overrides — included because they
        # change *what* the customer saw, not just *how* it looked.
        "section_visibility": sheet.section_visibility or {},
        "section_order": sheet.section_order or [],
        "signature": {
            "signed_at": (
                sheet.customer_signed_at.isoformat()
                if sheet.customer_signed_at is not None
                else None
            ),
            "image": sheet.customer_signature_image or "",
            "ip": sheet.customer_sign_ip or "",
            "user_agent": sheet.customer_sign_user_agent or "",
        },
    }
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))

def _render_proposal_html(proposal) -> str:
    """Render the proposal as a plain HTML document.

    Single source of truth for both the authenticated in-app
    preview endpoint and the public kiosk endpoint. Reused by
    :func:`_render_proposal_pdf` as the input to WeasyPrint, so any
    layout tweak applied to ``proposals/sheet.html`` flows through
    to both the HTML view and the PDF view.

    The signature pad is rendered as a separate React component
    above this iframe on the kiosk page, so a customer's sign-flow
    doesn't depend on anything in here.
    """

    version = proposal.formulation_version
    metadata = version.snapshot_metadata or {}
    # Effective sales-person name for the cover-letter signoff (same
    # fallback chain the read serializer + kiosk payload use).
    sales_person_user = (
        proposal.sales_person
        if proposal.sales_person_id
        else getattr(version.formulation, "sales_person", None)
    )
    sales_person_name = ""
    if sales_person_user is not None:
        sales_person_name = (
            sales_person_user.get_full_name() or sales_person_user.email or ""
        ).strip()
    return render_to_string(
        "proposals/sheet.html",
        {
            "proposal": proposal,
            "lines": list(proposal.lines.all()),
            "formulation": {
                "code": metadata.get("code") or version.formulation.code,
                "name": metadata.get("name") or version.formulation.name,
            },
            "subtotal": proposal.subtotal,
            "total_excl_vat": proposal.total_excl_vat,
            "sales_person_name": sales_person_name,
        },
    )


def _render_proposal_pdf(proposal) -> bytes:
    """Render the proposal to a PDF via WeasyPrint.

    Same HTML body as :func:`_render_proposal_html`, just fed
    through WeasyPrint's HTML→PDF engine. Critically, this is a
    pure-Python pipeline (cairo / pango / harfbuzz under the hood)
    that runs in-process — no subprocess, no LibreOffice, no risk
    of the OOM-kill loop the docx2pdf path used to cause. Same
    pipeline the spec-sheet renderer uses (``apps.specifications.
    services.render_pdf``), so the ops profile is identical:
    ~30-50 MB transient, ~500 ms typical.

    Lazy import on the WeasyPrint module so app collection stays
    clean on machines where libcairo/libpango aren't installed
    (e.g. some test runners).
    """

    from weasyprint import HTML  # noqa: WPS433

    html_string = _render_proposal_html(proposal)
    return HTML(string=html_string).write_pdf()

from apps.organizations.modules import ProposalsCapability
from apps.proposals.api.permissions import HasProposalsPermission
from config.pdf_cache import cached_render
from apps.proposals.api.serializers import (
    ProposalCreateSerializer,
    ProposalLineReadSerializer,
    ProposalLineWriteSerializer,
    ProposalListSerializer,
    ProposalReadSerializer,
    ProposalStatusSerializer,
    ProposalTransitionSerializer,
    ProposalUpdateSerializer,
)
from apps.proposals.services import (
    CustomerNotInOrg,
    FormulationVersionNotApproved,
    FormulationVersionNotInOrg,
    InvalidProposalTransition,
    KioskSignaturesPending,
    KioskSpecNotOnProposal,
    MissingRequiredFields,
    ProposalAcknowledgementsRequired,
    ProposalCodeConflict,
    ProposalLineNotFound,
    ProposalNotFound,
    ProposalNotMutable,
    ProposalPublicLinkNotEnabled,
    ProposalSalesPersonNotMember,
    SignatureRequired,
    SpecificationSheetNotApproved,
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

    permission_classes = (HasProposalsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            # The list endpoint serves three audiences and each unlocks
            # it with a different cap:
            #   * project workspace (``?formulation_id=…`` or no filter)
            #     — broad ``view``;
            #   * org-wide approval queue (``?status=in_review``) —
            #     narrow ``view_approvals``;
            #   * org-wide signed archive (``?status=sent|accepted``) —
            #     narrow ``view_signed``.
            # A caller with the broad ``view`` cap is implicitly allowed
            # to read any list shape, so it always remains in the
            # accepted set.
            from apps.proposals.models import ProposalStatus

            status_filter = request.query_params.get("status") or None
            if status_filter == ProposalStatus.IN_REVIEW:
                self.required_capability_any = (
                    ProposalsCapability.VIEW,
                    ProposalsCapability.VIEW_APPROVALS,
                )
            elif status_filter in {
                ProposalStatus.APPROVED,
                ProposalStatus.SENT,
                ProposalStatus.ACCEPTED,
            }:
                # ``approved`` is the post-director / pre-customer
                # window — surfaces on /signed under "Ready to send"
                # so commercial roles can sweep what still needs
                # mailing out. Same cap as the rest of the signed
                # archive surface.
                self.required_capability_any = (
                    ProposalsCapability.VIEW,
                    ProposalsCapability.VIEW_SIGNED,
                )
            else:
                self.required_capability = ProposalsCapability.VIEW
        else:
            self.required_capability = ProposalsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        from apps.proposals.models import ProposalStatus

        formulation_id = request.query_params.get("formulation_id") or None
        status_filter = request.query_params.get("status") or None
        # Reject unknown values rather than silently returning every
        # proposal — the inbox queue would otherwise show noise on a
        # typo, and the surface is gated by ``view`` so leaking a 400
        # carries no information.
        if status_filter and status_filter not in ProposalStatus.values:
            return Response(
                {"status": ["invalid_status"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        # ``statuses`` is the multi-select filter the org-wide list
        # bar uses; ``getlist`` returns ``[]`` when absent. Validate
        # each value individually so a typo surfaces as a focused
        # 400 instead of a silently-empty page.
        statuses = request.query_params.getlist("statuses") or None
        if statuses:
            invalid = [s for s in statuses if s and s not in ProposalStatus.values]
            if invalid:
                return Response(
                    {"statuses": ["invalid_status"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        search = request.query_params.get("search") or None
        sales_person_id = request.query_params.get("sales_person_id") or None
        # ISO ``YYYY-MM-DD`` date bounds. Django coerces to ``date``
        # on the queryset filter; a malformed string would surface
        # as a 500 from deeper down, so we validate up front and
        # treat garbage as "no bound" to keep the URL forgiving.
        from datetime import date as _date

        def _parse_date(raw: str | None) -> _date | None:
            if not raw:
                return None
            try:
                return _date.fromisoformat(raw.strip())
            except ValueError:
                return None

        valid_until_from = _parse_date(
            request.query_params.get("valid_until_from")
        )
        valid_until_to = _parse_date(
            request.query_params.get("valid_until_to")
        )
        queryset = list_proposals(
            organization=self.organization,
            formulation_id=formulation_id,
            status=status_filter,
            statuses=statuses,
            search=search,
            sales_person_id=sales_person_id,
            valid_until_from=valid_until_from,
            valid_until_to=valid_until_to,
        )
        # List variant blanks the three signature image blobs (the
        # row count + signed-by metadata stay; only the base64 PNG
        # bytes are stripped). The detail endpoint returns the
        # full payload so the audit panel sees everything.
        serializer = ProposalListSerializer(queryset, many=True)
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
        except FormulationVersionNotApproved:
            return Response(
                {"formulation_version_id": ["formulation_version_not_approved"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotApproved:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_approved"]},
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

    permission_classes = (HasProposalsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            # Reads are reachable from three surfaces — project
            # workspace, approvals queue, and signed archive — and
            # each surface is unlocked by a different cap. Accept any
            # of them on the detail read so a card the caller could
            # see on the approvals / signed page can still be opened.
            self.required_capability_any = (
                ProposalsCapability.VIEW,
                ProposalsCapability.VIEW_APPROVALS,
                ProposalsCapability.VIEW_SIGNED,
            )
        elif request.method == "DELETE":
            self.required_capability = ProposalsCapability.DELETE
        else:
            self.required_capability = ProposalsCapability.EDIT
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
        except ProposalNotMutable:
            return Response(
                {"code": "proposal_not_mutable"},
                status=status.HTTP_409_CONFLICT,
            )
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotApproved:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_approved"]},
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
        try:
            delete_proposal(proposal=proposal, actor=request.user)
        except ProposalNotMutable:
            return Response(
                {"code": "proposal_not_mutable"},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(status=status.HTTP_204_NO_CONTENT)


class ProposalStatusView(APIView):
    """``POST`` ``/.../proposals/<id>/status/`` — transition the sheet
    one step along its state machine.

    Capability depends on the target status: a sales rep can submit
    a draft for review (``edit``), but only an approver can flip a
    proposal to ``approved`` (``approve``), and only a manual-close
    role can override a customer outcome from the staff UI
    (``manual_close``). Mirrors the role-split the user requested:
    one person edits, a different person signs off, a third person
    declares the deal won or lost.
    """

    permission_classes = (HasProposalsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        # Inspect the requested target status so the permission
        # check can pick the right capability *before* the view's
        # ``post`` body runs. The middleware enforces
        # ``required_capability`` against the org membership on
        # entry; setting it lazily lets one endpoint host four
        # gates.
        from apps.proposals.models import ProposalStatus

        target = ""
        if isinstance(request.data, dict):
            target = str(request.data.get("status") or "")
        if target == ProposalStatus.APPROVED.value:
            # Director sign-off. Reuses the existing ``approve``
            # capability that was previously dead code.
            self.required_capability = ProposalsCapability.APPROVE
        elif target in (
            ProposalStatus.ACCEPTED.value,
            ProposalStatus.REJECTED.value,
        ):
            # Manual close — overriding the kiosk-driven outcome.
            # Separate cap so an approver isn't automatically a
            # closer.
            self.required_capability = ProposalsCapability.MANUAL_CLOSE
        else:
            # ``draft``, ``in_review``, ``sent`` — workflow edges
            # the sales rep with edit rights drives day-to-day.
            self.required_capability = ProposalsCapability.EDIT
        super().initial(request, *args, **kwargs)

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


class ProposalSendToClientView(APIView):
    """``POST`` ``/.../proposals/<id>/send-to-client/``.

    Atomic "email + flip-to-sent" for an approved proposal. The body
    accepts ``recipient`` (defaults to ``proposal.customer_email`` when
    omitted), ``subject``, ``body_text``, ``body_html``, and optional
    ``cc`` / ``bcc`` lists. Either the email lands AND the proposal
    moves to ``sent``, or neither does — the service wraps the SMTP
    send + the transition in one transaction.
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.EDIT

    def post(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        from apps.proposals.services import (
            ProposalEmailRecipientRequired,
            ProposalEmailSendFailed,
            send_proposal_to_client,
        )

        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

        data = request.data if isinstance(request.data, dict) else {}
        recipient = str(
            data.get("recipient") or proposal.customer_email or ""
        ).strip()
        subject = str(data.get("subject") or "").strip()
        body_text = str(data.get("body_text") or "")
        cc_raw = data.get("cc") or []
        bcc_raw = data.get("bcc") or []
        cc = (
            [str(x) for x in cc_raw if isinstance(x, str)]
            if isinstance(cc_raw, list)
            else []
        )
        bcc = (
            [str(x) for x in bcc_raw if isinstance(x, str)]
            if isinstance(bcc_raw, list)
            else []
        )

        try:
            updated = send_proposal_to_client(
                proposal=proposal,
                actor=request.user,
                recipient=recipient,
                subject=subject,
                body_text=body_text,
                cc=cc,
                bcc=bcc,
            )
        except ProposalEmailRecipientRequired:
            return Response(
                {"recipient": ["proposal_email_recipient_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidProposalTransition:
            return Response(
                {"status": ["invalid_proposal_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except MissingRequiredFields as exc:
            return Response(
                {
                    "missing_required_fields": exc.missing,
                    "detail": ["missing_required_fields"],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProposalEmailSendFailed as exc:
            # SMTP layer rejected the message. Surface the underlying
            # error code so the modal can show "Couldn't send: <why>"
            # rather than a generic banner; the status stayed at
            # ``approved`` thanks to the atomic block in the service.
            return Response(
                {
                    "detail": ["proposal_email_send_failed"],
                    "error": str(exc),
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(ProposalReadSerializer(updated).data)


class ProposalSendTestEmailView(APIView):
    """``POST`` ``/.../proposals/<id>/send-test-email/``.

    Sends a preview of the same email the ``send-to-client`` endpoint
    would dispatch, but to a test recipient (defaults to the caller's
    own email). The proposal status is **not** changed. Used by the
    "Send test to me" affordance in the compose modal so sales staff
    can eyeball the final layout before committing to a customer-
    facing send.

    Available regardless of the proposal's current status — sales may
    want to preview an email on a draft, even though the real send
    requires ``approved``.
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.EDIT

    def post(
        self, request: Request, org_id: str, proposal_id: str
    ) -> Response:
        from apps.proposals.services import (
            ProposalEmailRecipientRequired,
            ProposalEmailSendFailed,
            send_proposal_test_email,
        )

        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

        data = request.data if isinstance(request.data, dict) else {}
        # Recipient defaults to the caller's own email so the most
        # common case ("send a test to myself") is a single click in
        # the modal. An optional ``recipient`` overrides this for
        # cases where the operator wants the preview in a different
        # inbox (e.g. a colleague's).
        recipient = str(
            data.get("recipient")
            or getattr(request.user, "email", "")
            or ""
        ).strip()
        subject = str(data.get("subject") or "").strip()
        body_text = str(data.get("body_text") or "")

        try:
            final_subject = send_proposal_test_email(
                proposal=proposal,
                actor=request.user,
                recipient=recipient,
                subject=subject,
                body_text=body_text,
            )
        except ProposalEmailRecipientRequired:
            return Response(
                {"recipient": ["proposal_email_recipient_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProposalEmailSendFailed as exc:
            return Response(
                {
                    "detail": ["proposal_email_send_failed"],
                    "error": str(exc),
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(
            {"recipient": recipient, "subject": final_subject},
            status=status.HTTP_200_OK,
        )


class ProposalTransitionsView(APIView):
    """``GET`` ``/.../proposals/<id>/transitions/`` — timeline of
    status changes used by the detail page's audit sidebar."""

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW

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


class ProposalPdfDownloadView(APIView):
    """``GET`` ``/.../proposals/<id>/download/`` — authenticated PDF
    download of the proposal for staff.

    Mirror of :class:`PublicProposalDownloadView` but gated on the
    standard staff capability check rather than a public token, so
    sales / scientists can grab a signed copy for their records
    without sharing a customer-facing link. Same WeasyPrint
    pipeline + same cache/render-lock plumbing — repeat clicks
    within the cache window reuse the bytes, concurrent clicks
    queue on the process-wide render lock.
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW

    def get(
        self, request: Request, org_id: str, proposal_id: str
    ) -> HttpResponse:
        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

        pdf_bytes = cached_render(
            f"proposal-pdf:{proposal.id}:{int(proposal.updated_at.timestamp())}",
            lambda: _render_proposal_pdf(proposal),
        )
        filename = f"{(proposal.code or 'proposal').strip().replace(' ', '-')}.pdf"
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class ProposalRenderView(APIView):
    """``GET`` ``/.../proposals/<id>/render/`` — inline preview of the
    proposal as PDF (converted from the original .docx template).

    Tries LibreOffice / Microsoft Word conversion first so the viewer
    sees the real Vita NPD letterhead byte-for-byte. Falls back to the
    HTML approximation only when no converter is available — lets the
    feature keep working on CI containers / Linux boxes without Word.
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW

    def get(
        self, request: Request, org_id: str, proposal_id: str
    ) -> HttpResponse:
        try:
            proposal = get_proposal(
                organization=self.organization, proposal_id=proposal_id
            )
        except ProposalNotFound as exc:
            raise NotFound() from exc

        # Serve the rendered HTML directly (no PDF conversion). The
        # same template feeds the customer-facing kiosk iframe, so
        # both surfaces show pixel-identical output and the kiosk
        # can attach a scroll listener to the iframe contentWindow
        # (same-origin) to gate the Sign button on "read to bottom".
        return HttpResponse(_render_proposal_html(proposal))


class ProposalLineListCreateView(APIView):
    """``GET`` / ``POST``
    ``/api/organizations/<org>/proposals/<id>/lines/``.

    Lists every product line on a proposal (ordered) and lets the
    scientist add a new one. Creating a line pinned to a formulation
    version resolves the catalogue snapshot into the line's
    ``product_code`` / ``description`` so the pricing table renders
    plausible values immediately.
    """

    permission_classes = (HasProposalsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            ProposalsCapability.VIEW
            if request.method == "GET"
            else ProposalsCapability.EDIT
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
        except ProposalNotMutable:
            return Response(
                {"code": "proposal_not_mutable"},
                status=status.HTTP_409_CONFLICT,
            )
        except FormulationVersionNotInOrg:
            return Response(
                {"formulation_version_id": ["formulation_version_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FormulationVersionNotApproved:
            return Response(
                {"formulation_version_id": ["formulation_version_not_approved"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotApproved:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_approved"]},
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

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.EDIT

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
        except ProposalNotMutable:
            return Response(
                {"code": "proposal_not_mutable"},
                status=status.HTTP_409_CONFLICT,
            )
        except ProposalLineNotFound as exc:
            raise NotFound() from exc
        except SpecificationSheetNotInOrg:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationSheetNotApproved:
            return Response(
                {"specification_sheet_id": ["specification_sheet_not_approved"]},
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
        except ProposalNotMutable:
            return Response(
                {"code": "proposal_not_mutable"},
                status=status.HTTP_409_CONFLICT,
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

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW

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


class ProposalAuditView(APIView):
    """``GET`` ``/api/organizations/<org>/proposals/<id>/audit/``.

    Staff-side view of the e-signature audit trail captured at kiosk
    sign time. For the proposal and every attached spec sheet we
    return:

    * Signer identity (name / email / company)
    * Signed-at timestamp
    * Source IP (``X-Forwarded-For``-aware)
    * Raw User-Agent string
    * Stored SHA-256 hash of the rendered HTML at sign time
    * ``current_hash`` — freshly computed from the document **right
      now**
    * ``hash_matches`` — ``True`` iff the two hashes agree

    The hash mismatch flag is the load-bearing piece for a legal
    dispute: if it ever goes red, something in the document or its
    underlying data has changed since signing, and the contract in
    the DB no longer matches what the customer agreed to. The
    backend re-renders both documents on every request rather than
    caching, so the answer is always live.

    Gated on ``proposals:view_signed`` — same capability that opens
    the "signed deals" inbox. Customers never hit this; the public
    kiosk has no audit surface.
    """

    permission_classes = (HasProposalsPermission,)
    required_capability = ProposalsCapability.VIEW_SIGNED

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
        from apps.proposals.services import _attached_spec_sheets

        proposal = self._load(proposal_id)

        # Proposal block — only meaningful once the customer has
        # signed. Pre-signature reads return empty strings so the
        # frontend can show "not signed yet" without crashing on
        # null fields.
        proposal_stored_hash = proposal.customer_sign_document_hash or ""
        if proposal.customer_signed_at is not None:
            proposal_current_hash = _document_hash(
                _canonical_proposal_payload(proposal)
            )
        else:
            proposal_current_hash = ""
        proposal_block = {
            "signer_name": proposal.customer_signer_name or "",
            "signer_email": proposal.customer_signer_email or "",
            "signer_company": proposal.customer_signer_company or "",
            "signed_at": (
                proposal.customer_signed_at.isoformat()
                if proposal.customer_signed_at is not None
                else None
            ),
            "ip": proposal.customer_sign_ip or "",
            "user_agent": proposal.customer_sign_user_agent or "",
            "stored_hash": proposal_stored_hash,
            "current_hash": proposal_current_hash,
            "hash_matches": (
                proposal_stored_hash != ""
                and proposal_current_hash != ""
                and proposal_stored_hash == proposal_current_hash
            ),
        }

        specs_block = []
        for sheet in _attached_spec_sheets(proposal):
            sheet_stored_hash = sheet.customer_sign_document_hash or ""
            if sheet.customer_signed_at is not None:
                sheet_current_hash = _document_hash(
                    _canonical_spec_payload(sheet)
                )
            else:
                sheet_current_hash = ""
            specs_block.append(
                {
                    "id": str(sheet.id),
                    "code": sheet.code or "",
                    "formulation_name": (
                        sheet.formulation_version.formulation.name
                        if sheet.formulation_version_id
                        else ""
                    ),
                    "signer_name": sheet.customer_name or "",
                    "signer_email": sheet.customer_email or "",
                    "signer_company": sheet.customer_company or "",
                    "signed_at": (
                        sheet.customer_signed_at.isoformat()
                        if sheet.customer_signed_at is not None
                        else None
                    ),
                    "ip": sheet.customer_sign_ip or "",
                    "user_agent": sheet.customer_sign_user_agent or "",
                    "stored_hash": sheet_stored_hash,
                    "current_hash": sheet_current_hash,
                    "hash_matches": (
                        sheet_stored_hash != ""
                        and sheet_current_hash != ""
                        and sheet_stored_hash == sheet_current_hash
                    ),
                }
            )

        return Response(
            {"proposal": proposal_block, "specs": specs_block},
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

    # Local imports avoid pulling proposals.services at module load —
    # keeps Django's app-ready order simple. The
    # ``spec_render_context`` builds the same JSON the standalone
    # spec kiosk receives so the proposal kiosk can render each
    # attached spec inline (React component, not iframe) — keeps
    # the WeasyPrint PDF render off the hot path of opening the
    # proposal page.
    from apps.proposals.services import _attached_spec_sheets
    from apps.specifications.services import render_context as spec_render_context

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
            # Inline render data — drives the React ``SpecSheetContent``
            # component on the proposal kiosk. Same payload the
            # standalone spec kiosk uses at ``/p/<token>``. Cheap
            # JSON serialization (no WeasyPrint), so opening the
            # proposal kiosk no longer fans out N parallel PDF
            # renders just to paint the page.
            "render_context": spec_render_context(sheet),
        }
        for sheet in attached
    ]

    # Customer-facing line rows — same data the printable proposal
    # iterates over in the pricing table, plus a per-line subtotal
    # for the React reading panel that replaces the PDF iframe on
    # the kiosk. ``str(...)`` on every Decimal so the wire payload
    # stays JSON-safe.
    lines_payload = []
    for line in proposal.lines.order_by("display_order", "id"):
        subtotal = line.subtotal
        lines_payload.append(
            {
                "id": str(line.id),
                "product_code": line.product_code or "",
                "description": line.description or "",
                "quantity": line.quantity,
                "unit_price": (
                    str(line.unit_price) if line.unit_price is not None else None
                ),
                "subtotal": str(subtotal) if subtotal is not None else None,
            }
        )

    # Effective sales-person name for the cover-letter signoff —
    # same fallback chain the proposal read serializer uses: a
    # proposal-level override wins, otherwise the project's
    # ``sales_person`` is inherited. Empty string when neither slot
    # is filled; the reading panel falls back to a generic label.
    sales_person_user = (
        proposal.sales_person
        if proposal.sales_person_id
        else getattr(
            getattr(proposal.formulation_version, "formulation", None),
            "sales_person",
            None,
        )
    )
    sales_person_name = ""
    if sales_person_user is not None:
        sales_person_name = (
            sales_person_user.get_full_name() or sales_person_user.email or ""
        ).strip()

    return {
        "id": str(proposal.id),
        "code": proposal.code,
        "status": proposal.status,
        "template_type": proposal.template_type,
        "sales_person_name": sales_person_name,
        "customer_company": proposal.customer_company,
        "customer_name": proposal.customer_name,
        # Full customer-info block — used to drive the "Customer
        # Information" table on the React reading panel so the
        # signer can confirm the details before agreeing.
        "customer_email": proposal.customer_email,
        "customer_phone": proposal.customer_phone,
        "invoice_address": proposal.invoice_address,
        "delivery_address": proposal.delivery_address,
        "reference": proposal.reference,
        "dear_name": proposal.dear_name,
        "currency": proposal.currency,
        "quantity": proposal.quantity,
        "unit_price": (
            str(proposal.unit_price)
            if proposal.unit_price is not None
            else None
        ),
        "freight_amount": (
            str(proposal.freight_amount)
            if proposal.freight_amount is not None
            else None
        ),
        "subtotal": (
            str(proposal.subtotal)
            if proposal.subtotal is not None
            else None
        ),
        "total_excl_vat": (
            str(proposal.total_excl_vat)
            if proposal.total_excl_vat is not None
            else None
        ),
        "valid_until": (
            proposal.valid_until.isoformat()
            if proposal.valid_until is not None
            else None
        ),
        "lines": lines_payload,
        "customer_signed_at": (
            proposal.customer_signed_at.isoformat()
            if proposal.customer_signed_at is not None
            else None
        ),
        "has_signature": bool(proposal.customer_signature_image),
        # Customer-facing ack state — drives the kiosk's three
        # required tickboxes. Frontend disables the Sign button
        # until all three are ticked, matching the consent model
        # the printable proposal carries.
        "ack_spec_signing": bool(proposal.ack_spec_signing),
        "ack_lead_times": bool(proposal.ack_lead_times),
        "ack_terms": bool(proposal.ack_terms),
        # Custom-template-only R&D ack. Ready-to-Go proposals skip
        # this tickbox (no R&D phase), so the frontend hides the row
        # unconditionally on those — but we still send the boolean so
        # a refresh after signing keeps the rendered HTML's ☑ in sync.
        "ack_rd_terms": bool(proposal.ack_rd_terms),
        "attached_specs": specs_payload,
    }


@method_decorator(xframe_options_sameorigin, name="dispatch")
class PublicProposalPdfView(APIView):
    """``GET`` ``/api/public/proposals/<token>/pdf/``.

    Token-gated proposal preview the kiosk iframes so the signer can
    read the commercial terms before signing. Despite the historical
    ``/pdf/`` URL the response body is now **HTML**, not a PDF —
    LibreOffice was OOMing prod workers, and the team chose
    view-in-browser as the cleanest fix. Customers who specifically
    want a PDF copy use the browser's Print to PDF.

    Public access is intentional: no kiosk session required on the
    preview GET, only on the sign POSTs. A shareable link must be
    viewable even before the visitor clicks through the identity
    modal, so they can decide whether to proceed.

    The ``xframe_options_sameorigin`` decorator overrides Django's
    default ``X-Frame-Options: DENY`` so the kiosk iframe (which
    runs on the same origin as the API thanks to the Next.js
    ``/api/*`` rewrite) can embed the HTML. Without it the browser
    blocks the iframe content and the kiosk shows a broken-content
    placeholder in place of the proposal preview.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> HttpResponse:
        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        # Kiosk iframes this same endpoint. Returning HTML (instead
        # of WeasyPrint PDF) means the in-app preview and the
        # customer kiosk show pixel-identical output — both render
        # the same Django template via the same browser engine.
        return HttpResponse(_render_proposal_html(proposal))


class PublicProposalDownloadView(APIView):
    """``GET`` ``/api/public/proposals/<token>/download/``.

    Token-gated PDF download. Unlike :class:`PublicProposalPdfView`
    (which streams HTML for the kiosk iframe), this endpoint runs the
    HTML through WeasyPrint and streams a real ``application/pdf``
    blob with ``Content-Disposition: attachment`` so the customer's
    browser saves a file instead of rendering it inline. Mirrors the
    spec-sheet PDF download pattern.

    Public on purpose — same token that gates the preview gates the
    download, so anyone who can read the proposal can also save a
    portable copy for their records (matches the on-paper workflow
    sales teams expect).
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> HttpResponse:
        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        # Cached + render-locked. Repeat clicks within ``ttl``
        # return cached bytes; concurrent clicks queue on the
        # process-wide render lock so peak memory stays bounded
        # to one WeasyPrint call at a time per worker. See
        # :mod:`config.pdf_cache`.
        pdf_bytes = cached_render(
            f"proposal-pdf:{proposal.id}:{int(proposal.updated_at.timestamp())}",
            lambda: _render_proposal_pdf(proposal),
        )
        # Mirror the spec sheet's filename pattern (``<code>.pdf``).
        # Strip spaces so the suggested filename survives intact
        # through Content-Disposition's quoting rules.
        filename = f"{(proposal.code or 'proposal').strip().replace(' ', '-')}.pdf"
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        # 5-minute browser/CDN cache with revalidation — same
        # policy as the spec PDF endpoint. ``must-revalidate``
        # forces a refetch after edits.
        response["Cache-Control"] = "public, max-age=300, must-revalidate"
        return response


class PublicProposalIdentifyView(APIView):
    """``POST`` / ``DELETE`` ``/api/public/proposals/<token>/identify/``.

    Mirrors :class:`PublicSpecificationIdentifyView` for the
    proposal-centric kiosk: captures the visitor's name / email /
    optional company, writes a :class:`KioskSession`, and stamps the
    signed cookie that the sign / finalize endpoints rely on. Sharing
    the underlying :func:`identify_visitor` means a session row
    issued here is indistinguishable from one issued by the spec
    kiosk — it's just bound to the proposal's ``public_token`` UUID.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        from apps.comments.kiosk import (
            KioskTokenInvalid,
            attach_cookie,
            identify_visitor,
        )

        data = request.data if isinstance(request.data, dict) else {}
        name = str(data.get("name", "") or "").strip()
        email = str(data.get("email", "") or "").strip()
        company = str(data.get("company", "") or "").strip()

        if not name or not email:
            return Response(
                {
                    "name": [] if name else ["required"],
                    "email": [] if email else ["required"],
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            session, _token_uuid = identify_visitor(
                public_token=token,
                guest_name=name,
                guest_email=email,
                guest_org_label=company,
            )
        except KioskTokenInvalid:
            return Response(
                {"detail": ["kiosk_token_invalid"]},
                status=status.HTTP_404_NOT_FOUND,
            )

        response = Response(
            {
                "name": session.guest_name,
                "email": session.guest_email,
                "company": session.guest_org_label,
            },
            status=status.HTTP_200_OK,
        )
        attach_cookie(response, session)
        return response

    def delete(self, request: Request, token: str) -> Response:
        """Clear the session cookie and revoke the row.

        Parallels the spec-side DELETE — we treat sign-out as best
        effort: even when the cookie is already gone (or belongs to
        a rotated token) we still blank the browser state so the
        next visit starts clean.
        """

        from apps.comments.kiosk import (
            KioskSessionInvalid,
            KioskSessionRevoked,
            clear_cookie,
            resolve_from_request,
        )
        from django.utils import timezone

        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        try:
            identity = resolve_from_request(request, str(token))
        except (KioskSessionInvalid, KioskSessionRevoked):
            response = Response(status=status.HTTP_204_NO_CONTENT)
            clear_cookie(response, proposal.public_token)
            return response

        session = identity.session
        session.revoked_at = timezone.now()
        session.save(update_fields=["revoked_at"])
        response = Response(status=status.HTTP_204_NO_CONTENT)
        clear_cookie(response, proposal.public_token)
        return response


class PublicProposalKioskView(APIView):
    """``GET`` ``/api/public/proposals/<token>/``.

    Returns the JSON payload used by the kiosk page to render the
    proposal alongside every attached spec sheet. No kiosk session
    required on the GET — establishing identity is deferred until
    the client actually tries to sign something, so shareable links
    can be previewed before committing.

    Runs a best-effort backfill of the attached-specs'
    ``public_token`` when the proposal is ``SENT``: the preview
    iframes iframe each spec by its token, and bundles created
    before token-minting was wired in would otherwise render a blank
    preview. The helper is idempotent — already-tokened sheets are
    untouched — so it's safe to run on every load.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> Response:
        from apps.proposals.services import (
            ProposalStatus,
            _ensure_attached_spec_tokens,
            _promote_attached_specs_to_sent,
        )

        try:
            proposal = get_proposal_by_public_token(token)
        except ProposalPublicLinkNotEnabled as exc:
            raise NotFound() from exc

        # Always make sure every bundled spec carries a ``public_token``
        # so the kiosk preview iframes can load. Token minting used to
        # be coupled to the ``approved → sent`` promotion below, which
        # meant a proposal sitting at ``approved`` rendered the spec
        # card without its preview (the iframe URL needed a token the
        # spec didn't have). Now we mint up-front; the status
        # promotion is a separate concern.
        _ensure_attached_spec_tokens(
            proposal=proposal, actor=proposal.updated_by
        )

        if proposal.status == ProposalStatus.SENT.value:
            _promote_attached_specs_to_sent(
                proposal=proposal, actor=proposal.updated_by
            )

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

        payload = request.data or {}
        signature_image = payload.get("signature_image") or ""
        try:
            updated = capture_customer_signature_on_proposal(
                proposal=proposal,
                signer_name=session.guest_name,
                signer_email=session.guest_email or "",
                signer_company=session.guest_org_label or "",
                signature_image=signature_image,
                ack_spec_signing=bool(payload.get("ack_spec_signing")),
                ack_lead_times=bool(payload.get("ack_lead_times")),
                ack_terms=bool(payload.get("ack_terms")),
                ack_rd_terms=bool(payload.get("ack_rd_terms")),
                sign_ip=_client_ip(request),
                sign_user_agent=_user_agent(request),
                # Hash is filled in below from the *post-sign* render
                # because the rendered HTML embeds the signature image
                # and timestamp — hashing the pre-sign document would
                # produce a value that can never match a verifier's
                # re-render and the audit panel would always go red.
            )
        except InvalidProposalTransition:
            return Response(
                {"status": ["invalid_proposal_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProposalAcknowledgementsRequired:
            return Response(
                {
                    "acknowledgements": [
                        "proposal_acknowledgements_required"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except (SignatureRequired, SignatureImageInvalid):
            return Response(
                {"signature_image": ["signature_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Hash the canonical contract payload (customer info, pricing,
        # lines, acks, signature). Stable across deploys — only
        # business-data edits move the digest. See
        # :func:`_canonical_proposal_payload` for the field list.
        post_sign_hash = _document_hash(_canonical_proposal_payload(updated))
        updated.customer_sign_document_hash = post_sign_hash
        updated.save(update_fields=["customer_sign_document_hash"])

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
                sign_ip=_client_ip(request),
                sign_user_agent=_user_agent(request),
                # Hash is computed *post-sign* below for the same
                # reason as the proposal sign endpoint.
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

        # Canonical-payload hash on the spec sheet — mirrors the
        # proposal-sign path. See :func:`_canonical_spec_payload` for
        # field selection.
        post_sign_hash = _document_hash(_canonical_spec_payload(updated))
        updated.customer_sign_document_hash = post_sign_hash
        updated.save(update_fields=["customer_sign_document_hash"])

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


class PublicProposalRejectView(APIView):
    """``POST`` ``/api/public/proposals/<token>/reject/``.

    Customer-side "Decline this proposal" trigger. Flips the
    proposal from ``sent`` to ``rejected`` and stamps the optional
    free-text reason. A kiosk session is required so a bot can't
    walk through every public token and burn deals; the identity
    payload behind the cookie is the same one the sign endpoints
    enforce.

    The sales person is notified by email after the transaction
    commits — see :func:`_send_proposal_rejection_notification`.
    Best-effort delivery: SMTP failures do not roll back the
    rejection (the audit row + status are the source of truth).
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        from apps.proposals.services import (
            capture_customer_rejection_on_proposal,
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

        data = request.data if isinstance(request.data, dict) else {}
        reason = str(data.get("reason") or "")

        try:
            updated = capture_customer_rejection_on_proposal(
                proposal=proposal, reason=reason
            )
        except InvalidProposalTransition:
            return Response(
                {"status": ["invalid_proposal_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            {
                "status": updated.status,
                "customer_rejected_at": (
                    updated.customer_rejected_at.isoformat()
                    if updated.customer_rejected_at is not None
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
