"""Portal endpoints for the label-design workflow.

Routes here are scoped to the logged-in :class:`ClientAccount` via
``customer_ids_for_account(request.user)``. A customer never sees a LabelDesign
attached to a project they don't own — even by guessing the UUID.
"""

from __future__ import annotations

import hashlib
from typing import Any

from django.http import HttpResponse
from django.template.loader import render_to_string
from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response

from apps.audit.services import record as record_audit
from apps.client_portal.api.views import PortalAPIView
from apps.client_portal.queries import customer_ids_for_account
from apps.label_design.api.serializers import (
    ChoosePathSerializer,
    CustomerApproveSerializer,
    CustomerRejectSerializer,
    CustomerUploadArtworkSerializer,
    LabelDesignReadSerializer,
    SubmitPreferencesSerializer,
)
from apps.label_design.constants import (
    LabelDesignPath,
    LabelDesignStatus,
    RevisionSource,
)
from apps.label_design.content_block import (
    compute_content_block,
    render_content_block_html,
    render_content_block_pdf,
    render_content_block_png,
    render_content_block_text,
)
from apps.label_design.models import (
    LabelDesign,
    LabelDesignPreferences,
    LabelDesignRevision,
)
from apps.label_design.services import (
    InvalidStatusTransition,
    transition_status,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _label_designs_for_customer(customer_ids):
    """All LabelDesign rows owned by the customer rows in ``customer_ids``.

    Ownership is established by walking through any proposal that
    belongs to the customer: a project becomes "owned" by the
    customer when at least one proposal pinned to one of its
    formulation versions references the customer.

    ``customer_ids`` is the email-union from
    :func:`apps.client_portal.queries.customer_ids_for_account` so
    duplicate-customer rows that share an email all contribute
    their label-design rows to the same portal surface.
    """

    from apps.client_portal.queries import formulation_ids_for_customer

    # Walks both anchor proposals AND line-derived projects so
    # a customer-owned multi-project proposal still surfaces every
    # label-design row.
    return (
        LabelDesign.objects.filter(
            formulation_id__in=formulation_ids_for_customer(customer_ids)
        )
        .select_related(
            "formulation",
            "organization",
            "current_revision",
            "preferences",
        )
        .prefetch_related("preferences__inspiration_files")
    )


def _get_label_design_for_customer(label_design_id, customer_ids) -> LabelDesign:
    label_design = (
        _label_designs_for_customer(customer_ids)
        .filter(id=label_design_id)
        .first()
    )
    if label_design is None:
        raise NotFound()
    return label_design


def _ensure_status(label_design: LabelDesign, *allowed: str) -> None:
    if label_design.status not in allowed:
        raise ValidationError(
            {
                "detail": (
                    f"label design status is {label_design.status}; "
                    f"expected one of {sorted(allowed)}"
                ),
                "code": "wrong_status",
            }
        )


def _sign_document_hash(html: str) -> str:
    return hashlib.sha256(html.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# List + detail
# ---------------------------------------------------------------------------


class PortalLabelDesignListView(PortalAPIView):
    def get(self, request: Request) -> Response:
        rows = _label_designs_for_customer(customer_ids_for_account(request.user)).order_by(
            "-updated_at"
        )
        return Response({"items": LabelDesignReadSerializer(rows, many=True).data})


class PortalLabelDesignDetailView(PortalAPIView):
    def get(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        return Response(LabelDesignReadSerializer(ld).data)


# ---------------------------------------------------------------------------
# Choose path + preferences submission
# ---------------------------------------------------------------------------


class PortalLabelDesignChoosePathView(PortalAPIView):
    def post(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _ensure_status(ld, LabelDesignStatus.LABEL_PATH_PENDING)

        serializer = ChoosePathSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        path = serializer.validated_data["path"]

        ld.design_path = path
        ld.save(update_fields=["design_path", "updated_at"])

        # design_by_us goes through a paid gate when the org has a
        # ``label_design_fee_amount > 0``. Creating the payment is
        # part of the same transaction as the transition so a hiccup
        # rolls both back — the customer can retry cleanly instead of
        # ending up in DESIGN_FEE_PENDING with no invoice on finance's
        # queue.
        if path == LabelDesignPath.DESIGN_BY_US:
            from apps.payments.services import (
                ensure_label_design_payment_for_formulation,
            )

            payment = ensure_label_design_payment_for_formulation(
                formulation=ld.formulation,
                # Scope the invoice to THIS label's order so RTG
                # multi-order customers each get their own design-fee
                # invoice rather than adopting whichever formulation-
                # wide invoice happened to be sitting on the queue.
                proposal=ld.proposal,
                actor=None,
            )
            target = (
                LabelDesignStatus.DESIGN_FEE_PENDING
                if payment is not None
                else LabelDesignStatus.DESIGN_PREFERENCES_PENDING
            )
            notes = (
                "customer chose design_by_us — LABEL_DESIGN fee invoice raised"
                if payment is not None
                else "customer chose design_by_us — no design fee configured, skipping gate"
            )
        elif path == LabelDesignPath.NO_LABEL:
            # Opt-out — customer doesn't want a label on this order.
            # Skip the review chain entirely and land in the terminal
            # NO_LABEL_REQUIRED state. Downstream (portal pipeline,
            # PSP badge) treats this as "label stage complete, no
            # artwork will follow" so production doesn't wait.
            target = LabelDesignStatus.NO_LABEL_REQUIRED
            notes = "customer opted out — no label required for this order"
        else:
            target = LabelDesignStatus.DESIGN_IN_PROGRESS
            notes = f"customer chose {path}"

        try:
            transition_status(
                ld,
                to_status=target,
                actor_client=request.user,
                notes=notes,
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})
        return Response(LabelDesignReadSerializer(ld).data)


class PortalLabelDesignPreferencesView(PortalAPIView):
    parser_classes = (MultiPartParser, FormParser)

    def post(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _ensure_status(ld, LabelDesignStatus.DESIGN_PREFERENCES_PENDING)
        if ld.design_path != LabelDesignPath.DESIGN_BY_US:
            raise ValidationError(
                {"detail": "preferences only apply to DESIGN_BY_US path", "code": "wrong_path"}
            )

        serializer = SubmitPreferencesSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data

        # Declaration attribution — the FE may or may not send
        # ``declaration_name`` / ``declaration_position``. NPD's own
        # portal omits them (its rationale: the client account
        # already carries identity), so the payload defaults to "".
        # web-site's portal captures both as first-class inputs.
        # Prefer the payload when it's populated; otherwise stamp
        # from the authenticated client account so the compliance
        # audit trail always names a person, no matter which portal
        # the customer used.
        account = request.user
        customer = getattr(account, "customer", None)
        default_name = (
            (getattr(customer, "name", "") or "").strip()
            or (getattr(customer, "company", "") or "").strip()
        )
        declaration_name = (
            payload["declaration_name"].strip() or default_name
        )
        declaration_position = payload["declaration_position"].strip()

        preferences = LabelDesignPreferences.objects.create(
            submitted_by_client=request.user,
            company_name=payload["company_name"],
            brand_name=payload["brand_name"],
            product_names=payload["product_names"],
            product_codes=payload["product_codes"],
            brand_colours=payload["brand_colours"],
            inspiration_urls=payload["inspiration_urls"],
            elements_to_include=payload["elements_to_include"],
            design_style=payload["design_style"],
            material_type=payload["material_type"],
            additional_comments=payload["additional_comments"],
            declaration_signed_at=timezone.now(),
            declaration_signature_image=payload["declaration_signature_image"],
            declaration_name=declaration_name,
            declaration_position=declaration_position,
            raw_payload=request.data
            if isinstance(request.data, dict)
            else dict(request.data),
        )

        # Attach inspiration files if the request was multipart.
        # Defense-in-depth limits mirror the FE dropzone in
        # ``app/[locale]/portal/label-designs/[id]/preferences/page.tsx``
        # — the FE is the friendly first stop but a direct API call
        # mustn't be able to bypass them.
        ALLOWED_MIMES = {
            "image/jpeg",
            "image/jpg",
            "image/png",
            "image/gif",
            "image/webp",
            "image/heic",
            "image/heif",
            "application/pdf",
        }
        MAX_FILE_BYTES = 10 * 1024 * 1024
        MAX_TOTAL_BYTES = 50 * 1024 * 1024
        MAX_FILES = 10

        uploads = request.FILES.getlist("inspiration_files")
        if len(uploads) > MAX_FILES:
            raise ValidationError(
                {
                    "detail": f"At most {MAX_FILES} inspiration files are allowed.",
                    "code": "too_many_files",
                }
            )
        running_total = 0
        for upload in uploads:
            mime = (getattr(upload, "content_type", "") or "").lower()
            size = int(getattr(upload, "size", 0) or 0)
            if mime not in ALLOWED_MIMES:
                raise ValidationError(
                    {
                        "detail": (
                            f"{upload.name}: file type {mime or 'unknown'} is "
                            "not supported."
                        ),
                        "code": "file_type_not_allowed",
                    }
                )
            if size > MAX_FILE_BYTES:
                raise ValidationError(
                    {
                        "detail": (
                            f"{upload.name}: {size // (1024 * 1024)} MB is "
                            f"over the {MAX_FILE_BYTES // (1024 * 1024)} MB "
                            "per-file limit."
                        ),
                        "code": "file_too_large",
                    }
                )
            running_total += size
            if running_total > MAX_TOTAL_BYTES:
                raise ValidationError(
                    {
                        "detail": (
                            f"Total upload exceeds the "
                            f"{MAX_TOTAL_BYTES // (1024 * 1024)} MB limit."
                        ),
                        "code": "batch_too_large",
                    }
                )

        for upload in uploads:
            preferences.inspiration_files.create(
                file=upload,
                original_name=upload.name,
                content_type=(getattr(upload, "content_type", "") or "").lower(),
                size_bytes=getattr(upload, "size", 0) or 0,
            )

        ld.preferences = preferences
        ld.save(update_fields=["preferences", "updated_at"])

        try:
            transition_status(
                ld,
                to_status=LabelDesignStatus.DESIGN_IN_PROGRESS,
                actor_client=request.user,
                notes="design preferences submitted",
                metadata={"preferences_id": str(preferences.id)},
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})
        return Response(
            LabelDesignReadSerializer(ld).data, status=status.HTTP_201_CREATED
        )


# ---------------------------------------------------------------------------
# Content block exports (customer-side)
# ---------------------------------------------------------------------------


def _require_spec(ld: LabelDesign) -> None:
    if ld.specification_sheet is None:
        raise ValidationError(
            {"detail": "No spec sheet attached.", "code": "no_spec"}
        )


def _require_customer_content_block_access(ld: LabelDesign) -> None:
    """Gate the spec-derived content block behind:

    * an approved payment (i.e. status has moved past
      ``PAYMENT_PENDING``); and
    * the ``DESIGN_BY_CUSTOMER`` design path — only customers who
      chose to design the label themselves have any use for the
      content block.

    Both checks are enforced here (not just hidden in the FE) so a
    direct API call can't bypass them.
    """

    if ld.status == LabelDesignStatus.PAYMENT_PENDING:
        raise ValidationError(
            {
                "detail": (
                    "Payment is still pending — the content block "
                    "unlocks once finance confirms your payment."
                ),
                "code": "payment_pending",
            }
        )
    if ld.design_path != LabelDesignPath.DESIGN_BY_CUSTOMER:
        raise ValidationError(
            {
                "detail": (
                    "The content block is only available when you "
                    "choose to design the label yourself."
                ),
                "code": "wrong_path",
            }
        )


class PortalLabelDesignContentBlockJSONView(PortalAPIView):
    def get(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _require_customer_content_block_access(ld)
        _require_spec(ld)
        block = compute_content_block(ld.specification_sheet)
        return Response(block.to_dict())


class PortalLabelDesignContentBlockPDFView(PortalAPIView):
    def get(self, request: Request, label_design_id) -> HttpResponse:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _require_customer_content_block_access(ld)
        _require_spec(ld)
        block = compute_content_block(ld.specification_sheet)
        response = HttpResponse(
            render_content_block_pdf(block), content_type="application/pdf"
        )
        response["Content-Disposition"] = (
            f'inline; filename="content-block-{ld.id}.pdf"'
        )
        return response


class PortalLabelDesignContentBlockPNGView(PortalAPIView):
    def get(self, request: Request, label_design_id) -> HttpResponse:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _require_customer_content_block_access(ld)
        _require_spec(ld)
        try:
            dpi = int(request.query_params.get("dpi", "300"))
        except (TypeError, ValueError):
            dpi = 300
        dpi = max(72, min(dpi, 600))
        block = compute_content_block(ld.specification_sheet)
        response = HttpResponse(
            render_content_block_png(block, dpi=dpi), content_type="image/png"
        )
        response["Content-Disposition"] = (
            f'inline; filename="content-block-{ld.id}.png"'
        )
        return response


class PortalLabelDesignContentBlockHTMLView(PortalAPIView):
    """HTML mirror of the staff content-block preview.

    Same 9-region template, same render path — the customer
    workspace iframes this URL and drives ``html2canvas`` against
    it to produce per-region PDF / PNG downloads on the FE without
    a second server hit. Without this surface the customer side
    could only see JSON / text exports, missing the visual preview
    the staff already has.
    """

    def get(self, request: Request, label_design_id) -> HttpResponse:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _require_customer_content_block_access(ld)
        _require_spec(ld)
        block = compute_content_block(ld.specification_sheet)
        return HttpResponse(
            render_content_block_html(block), content_type="text/html"
        )


class PortalLabelDesignContentBlockTextView(PortalAPIView):
    def get(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _require_customer_content_block_access(ld)
        _require_spec(ld)
        block = compute_content_block(ld.specification_sheet)
        text = render_content_block_text(block)
        return Response({"full": text.full, "sections": text.sections})


# ---------------------------------------------------------------------------
# Customer self-design upload + approval / rejection
# ---------------------------------------------------------------------------


def _next_revision_number(label_design: LabelDesign) -> int:
    last = (
        LabelDesignRevision.objects.filter(label_design=label_design)
        .order_by("-revision_number")
        .values_list("revision_number", flat=True)
        .first()
    )
    return (last or 0) + 1


def _compliance_snapshot(label_design: LabelDesign) -> dict:
    if label_design.specification_sheet is None:
        return {}
    return compute_content_block(label_design.specification_sheet).to_dict()


def _esign_trio(request: Request) -> dict:
    from apps.client_portal.services import _extract_client_ip
    return {
        "ip": _extract_client_ip(request) or "",
        "user_agent": request.META.get("HTTP_USER_AGENT", ""),
    }


class PortalLabelDesignUploadArtworkView(PortalAPIView):
    parser_classes = (MultiPartParser, FormParser)

    def post(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        if ld.design_path != LabelDesignPath.DESIGN_BY_CUSTOMER:
            raise ValidationError(
                {"detail": "uploads only allowed on DESIGN_BY_CUSTOMER path", "code": "wrong_path"}
            )
        _ensure_status(ld, LabelDesignStatus.DESIGN_IN_PROGRESS)

        serializer = CustomerUploadArtworkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data

        revision = LabelDesignRevision.objects.create(
            label_design=ld,
            revision_number=_next_revision_number(ld),
            submitted_by_client=request.user,
            source=RevisionSource.CUSTOMER_UPLOAD,
            artwork_pdf=payload["artwork"],
            notes=payload["notes"],
            compliance_block_snapshot=_compliance_snapshot(ld),
            customer_approved_own_design=True,
        )
        # Attach any additional "back / side / mockup" views the
        # customer bundled in the same upload. Same shape as the
        # staff-side upload endpoint.
        from apps.label_design.api.views import _attach_additional_assets

        _attach_additional_assets(
            revision=revision,
            request=request,
            labels=payload.get("additional_file_labels", []),
        )
        ld.current_revision = revision
        ld.save(update_fields=["current_revision", "updated_at"])

        try:
            transition_status(
                ld,
                to_status=LabelDesignStatus.SCIENTIST_REVIEW,
                actor_client=request.user,
                notes="customer uploaded their own design",
                metadata={"revision_id": str(revision.id)},
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})

        record_audit(
            organization=ld.organization,
            actor=None,
            action="label_design.customer_upload_artwork",
            target=ld,
            before=None,
            after={
                "revision_id": str(revision.id),
                "signature_present": bool(payload["signature_image"]),
            },
        )
        return Response(LabelDesignReadSerializer(ld).data, status=status.HTTP_201_CREATED)


class PortalLabelDesignApproveView(PortalAPIView):
    def post(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _ensure_status(ld, LabelDesignStatus.CUSTOMER_APPROVAL)

        serializer = CustomerApproveSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        signature = serializer.validated_data["signature_image"]

        # Hash the on-screen approval HTML so we can prove which
        # rendering the customer saw at sign time. Uses the
        # content-block render as a stand-in for the approval page
        # itself; the FE page is also derived from the same block.
        try:
            preview_html = render_content_block_html(
                compute_content_block(ld.specification_sheet)
                if ld.specification_sheet
                else None
            ) if ld.specification_sheet else ""
        except Exception:
            preview_html = ""

        esign = _esign_trio(request)
        ld.customer_approved_at = timezone.now()
        ld.customer_approved_by = request.user
        ld.customer_approval_signature_image = signature
        ld.customer_sign_ip = esign["ip"][:45]
        ld.customer_sign_user_agent = esign["user_agent"]
        ld.customer_sign_document_hash = (
            _sign_document_hash(preview_html) if preview_html else ""
        )
        ld.save(
            update_fields=[
                "customer_approved_at",
                "customer_approved_by",
                "customer_approval_signature_image",
                "customer_sign_ip",
                "customer_sign_user_agent",
                "customer_sign_document_hash",
                "updated_at",
            ]
        )

        try:
            transition_status(
                ld,
                to_status=LabelDesignStatus.LABEL_APPROVED,
                actor_client=request.user,
                notes="customer approval signature captured",
                # Pair the approval to the artwork the customer
                # actually signed. See the reject endpoint for the
                # full reasoning — staff Versions tab uses this.
                metadata=(
                    {"revision_id": str(ld.current_revision_id)}
                    if ld.current_revision_id
                    else None
                ),
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})

        return Response(LabelDesignReadSerializer(ld).data)


class PortalLabelDesignRejectView(PortalAPIView):
    def post(self, request: Request, label_design_id) -> Response:
        ld = _get_label_design_for_customer(
            label_design_id, customer_ids_for_account(request.user)
        )
        _ensure_status(ld, LabelDesignStatus.CUSTOMER_APPROVAL)

        serializer = CustomerRejectSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        try:
            transition_status(
                ld,
                to_status=LabelDesignStatus.DESIGN_IN_PROGRESS,
                actor_client=request.user,
                notes=serializer.validated_data["reason"] or "customer rejected",
                # Pin the rejection to the revision the customer
                # was actually looking at. Without ``revision_id``
                # in the metadata the staff Versions tab couldn't
                # surface the customer's verdict next to the
                # artwork it referred to — the transition would
                # show up only in the bare Audit timeline.
                metadata=(
                    {"revision_id": str(ld.current_revision_id)}
                    if ld.current_revision_id
                    else None
                ),
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})

        return Response(LabelDesignReadSerializer(ld).data)
