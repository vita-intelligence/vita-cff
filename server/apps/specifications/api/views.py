"""Views for the specifications API."""

from __future__ import annotations

from django.http import HttpResponse
from django.template.loader import render_to_string
from django.utils.decorators import method_decorator
from django.views.decorators.clickjacking import xframe_options_sameorigin
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.organizations.modules import FormulationsCapability
from config.pdf_cache import cached_render
from apps.specifications.api.pagination import SpecificationCursorPagination
from apps.specifications.api.permissions import HasSpecificationsPermission
from apps.specifications.api.serializers import (
    SpecificationPackagingSerializer,
    SpecificationSheetCreateSerializer,
    SpecificationSheetListSerializer,
    SpecificationSheetReadSerializer,
    SpecificationSheetUpdateSerializer,
    SpecificationStatusSerializer,
    SpecificationCustomerAcceptSerializer,
)
from apps.catalogues.models import Catalogue, Item, PACKAGING_SLUG
from apps.specifications.models import SpecificationSheet
from apps.specifications.services import (
    FinalSpecAlreadyExists,
    FormulationVersionNotInOrg,
    InvalidSnapshotOverrides,
    InvalidSpecificationDocumentKind,
    InvalidStatusTransition,
    LiveDraftAlreadyExists,
    MissingDeliveryCapture,
    MissingTransitionReason,
    PACKAGING_SLOT_TYPES,
    PackagingItemNotAllowed,
    PublicLinkNotEnabled,
    SheetLockedBySignedProposal,
    SheetRegenerationRequiresForce,
    SpecificationCodeConflict,
    SpecificationDeletionLocked,
    SpecificationNotMutable,
    SpecificationPricingLocked,
    SpecificationNotFound,
    SpecificationReviewSlotTaken,
    create_sheet,
    delete_sheet,
    get_by_public_token,
    get_sheet,
    list_sheets,
    regenerate_sheet,
    render_context,
    render_pdf,
    revoke_public_token,
    rotate_public_token,
    set_packaging,
    set_section_order,
    set_section_visibility,
    accept_as_customer,
    SignatureRequired,
    transition_status,
    update_sheet,
)


class SpecificationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/specifications/``."""

    permission_classes = (HasSpecificationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "POST":
            self.required_capability = FormulationsCapability.EDIT
        else:
            # Mirror the proposal list-endpoint rule: the org-wide
            # approval queue (``?status=in_review``) and signed archive
            # (``?status=sent|accepted``) each unlock with their narrow
            # caps, while the broad ``view`` cap (project workspace
            # audience) is always sufficient.
            from apps.specifications.models import SpecificationStatus

            status_filter = request.query_params.get("status") or None
            if status_filter == SpecificationStatus.IN_REVIEW:
                self.required_capability_any = (
                    FormulationsCapability.VIEW,
                    FormulationsCapability.VIEW_APPROVALS,
                )
            elif status_filter in {
                SpecificationStatus.APPROVED,
                SpecificationStatus.SENT,
                SpecificationStatus.ACCEPTED,
            }:
                # ``approved`` is the post-director / pre-customer
                # window — surfaces on /signed under "Ready to send"
                # so commercial roles can sweep what still needs
                # mailing out.
                self.required_capability_any = (
                    FormulationsCapability.VIEW,
                    FormulationsCapability.VIEW_SIGNED,
                )
            else:
                self.required_capability = FormulationsCapability.VIEW
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        # Optional ?formulation_id scopes the list to one project —
        # drives the Spec Sheets tab on the project workspace.
        # Optional ?status drives the director's approval inbox.
        from apps.specifications.models import SpecificationStatus

        formulation_id = request.query_params.get("formulation_id") or None
        status_filter = request.query_params.get("status") or None
        if status_filter and status_filter not in SpecificationStatus.values:
            return Response(
                {"status": ["invalid_status"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        queryset = list_sheets(
            organization=self.organization,
            formulation_id=formulation_id,
            status=status_filter,
        )
        paginator = SpecificationCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        # List variant skips the three signature-image blobs — each
        # base64 PNG is ~8-12 KB, so a 50-row page would otherwise
        # ship ~1.5 MB of unused image bytes. The detail view still
        # returns them.
        serializer = SpecificationSheetListSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, org_id: str) -> Response:
        serializer = SpecificationSheetCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            sheet = create_sheet(
                organization=self.organization,
                actor=request.user,
                formulation_version_id=data["formulation_version_id"],
                code=data.get("code", ""),
                client_name=data.get("client_name", ""),
                client_email=data.get("client_email", ""),
                client_company=data.get("client_company", ""),
                margin_percent=data.get("margin_percent"),
                final_price=data.get("final_price"),
                cover_notes=data.get("cover_notes", ""),
                total_weight_label=data.get("total_weight_label", ""),
                document_kind=data.get("document_kind", "draft"),
            )
        except FormulationVersionNotInOrg:
            return Response(
                {
                    "formulation_version_id": [
                        "formulation_version_not_in_org"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationCodeConflict:
            return Response(
                {"code": ["specification_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidSpecificationDocumentKind:
            return Response(
                {"document_kind": ["invalid_specification_document_kind"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except LiveDraftAlreadyExists as exc:
            # 409 with the existing sheet id so the FE can jump the
            # scientist straight to the "Regenerate" surface on that
            # sheet instead of forcing them to hunt for it.
            return Response(
                {
                    "code": "live_draft_already_exists",
                    "existing_sheet_id": exc.existing_sheet_id,
                },
                status=status.HTTP_409_CONFLICT,
            )
        except FinalSpecAlreadyExists:
            return Response(
                {"code": "final_spec_already_exists"},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            SpecificationSheetReadSerializer(sheet).data,
            status=status.HTTP_201_CREATED,
        )


class SpecificationDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/.../specifications/<id>/``."""

    permission_classes = (HasSpecificationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            # Reads are reachable from project workspace, approval
            # queue, and signed archive. Accept any of the three caps
            # that unlock those surfaces so a card the caller can see
            # in a list view can also be opened.
            self.required_capability_any = (
                FormulationsCapability.VIEW,
                FormulationsCapability.VIEW_APPROVALS,
                FormulationsCapability.VIEW_SIGNED,
            )
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, sheet_id: str):
        try:
            return get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, sheet_id: str) -> Response:
        sheet = self._load(sheet_id)
        return Response(
            SpecificationSheetReadSerializer(sheet).data,
            status=status.HTTP_200_OK,
        )

    def patch(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        serializer = SpecificationSheetUpdateSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_sheet(
                sheet=sheet,
                actor=request.user,
                **serializer.validated_data,
            )
        except SpecificationCodeConflict:
            return Response(
                {"code": ["specification_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationPricingLocked:
            return Response(
                {"detail": ["specification_pricing_locked"]},
                status=status.HTTP_409_CONFLICT,
            )
        except SpecificationNotMutable:
            return Response(
                {"detail": ["specification_not_mutable"]},
                status=status.HTTP_409_CONFLICT,
            )
        except InvalidSpecificationDocumentKind:
            return Response(
                {"document_kind": ["invalid_specification_document_kind"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidSnapshotOverrides:
            return Response(
                {"snapshot_overrides": ["invalid_snapshot_overrides"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FinalSpecAlreadyExists:
            # Surface the domain error as a 409 instead of letting it
            # bubble as an uncaught 500. The earlier behaviour leaked
            # an unhandled exception every time a user tried to flip a
            # draft to FINAL when another final already existed for
            # the same formulation — eight back-to-back retries today
            # were the trigger for the afternoon perf spike (each one
            # held a connection through the @transaction.atomic
            # rollback). 409 lets the frontend render "another final
            # already exists" copy without a 500 noise burst.
            return Response(
                {"code": "final_spec_already_exists"},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        from apps.audit.services import record as record_audit

        sheet = self._load(sheet_id)
        try:
            outcome = delete_sheet(sheet=sheet, actor=request.user)
        except SpecificationDeletionLocked:
            # 409 (not 403) — the caller has the DELETE capability,
            # the resource exists; the deny is a property of the
            # row's lifecycle state. Codified error so the frontend
            # can render "revert to draft first" copy without
            # string-matching the response body.
            return Response(
                {"code": "specification_deletion_locked"},
                status=status.HTTP_409_CONFLICT,
            )
        # The audit row lands here (not in the service) so a failed
        # write to the audit log doesn't roll back the DELETE — the
        # spec is gone either way and we'd rather lose the trail than
        # half-delete and confuse every subsequent read.
        record_audit(
            organization=outcome["organization"],
            actor=outcome["actor"],
            action="spec_sheet.delete",
            target=None,
            target_type="specificationsheet",
            target_id=outcome["target_id"],
            before=outcome["before"],
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class SpecificationStatusView(APIView):
    """``POST`` ``/.../specifications/<id>/status/``."""

    permission_classes = (HasSpecificationsPermission,)
    # Per-transition gate is set in ``initial()`` based on the target
    # status (and, for revert-to-draft, the source status). Default
    # to APPROVE here so a misrouted call without ``initial()`` ever
    # firing fails closed rather than letting an EDIT-only user
    # advance the sheet.
    required_capability = FormulationsCapability.APPROVE

    def initial(self, request: Request, *args, **kwargs) -> None:
        # Read the target status off the payload to pick the right
        # capability *before* the permission check runs. ``initial``
        # is the DRF hook for exactly this — DRF calls it after auth
        # but before ``check_permissions``, so the resolved capability
        # is in place by the time ``HasSpecificationsPermission``
        # reads it.
        #
        # Mapping:
        # * ``→ approved``: director sign-off — APPROVE-only. The
        #   scientist who drafted the sheet must not be able to flip
        #   their own work to director-approved.
        # * ``→ rejected``: manual terminal close (customer rejected
        #   over phone / email rather than on the kiosk) — APPROVE.
        # * ``→ draft`` from ``approved``: unlocks the director's
        #   signature, so APPROVE. From any other source it's an
        #   ordinary revert and EDIT is enough.
        # * Everything else (``draft → in_review``, ``approved →
        #   sent``, ``in_review → draft`` for scientist pull-back,
        #   ``rejected → draft`` for reopen): EDIT.
        target = (request.data or {}).get("status")
        if target == "approved" or target == "rejected":
            self.required_capability = FormulationsCapability.APPROVE
        elif target == "draft":
            sheet_id = kwargs.get("sheet_id")
            current_status: str | None = None
            if sheet_id is not None:
                current_status = (
                    SpecificationSheet.objects.filter(id=sheet_id)
                    .values_list("status", flat=True)
                    .first()
                )
            if current_status == "approved":
                self.required_capability = FormulationsCapability.APPROVE
            else:
                self.required_capability = FormulationsCapability.EDIT
        else:
            # ``draft → in_review`` (send for review) and ``approved
            # → sent`` (sales sends to customer) — both are EDIT.
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc
        serializer = SpecificationStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        # Pluck the optional pricing block out of the payload. The
        # service only consumes it on the ``in_review → approved``
        # edge; other edges ignore it. We pass the full dict
        # unconditionally because the service's ``any(...)`` check
        # short-circuits a no-op when every field is null.
        pricing_payload = {
            "unit_cost": data.get("unit_cost"),
            "margin_percent": data.get("margin_percent"),
            "final_price": data.get("final_price"),
            "quantity": data.get("quantity"),
            "currency": data.get("currency") or None,
        }
        try:
            updated = transition_status(
                sheet=sheet,
                actor=request.user,
                next_status=data["status"],
                notes=data.get("notes", ""),
                signature_image=data.get("signature_image") or None,
                pricing=pricing_payload,
                delivery_method=data.get("delivery_method") or "",
                delivery_recipient=data.get("delivery_recipient") or "",
            )
        except InvalidStatusTransition:
            return Response(
                {"status": ["invalid_status_transition"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationReviewSlotTaken:
            return Response(
                {"status": ["specification_review_slot_taken"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SignatureRequired:
            return Response(
                {"signature_image": ["signature_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except MissingTransitionReason:
            return Response(
                {"notes": ["missing_transition_reason"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except MissingDeliveryCapture:
            return Response(
                {"delivery_method": ["missing_delivery_capture"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )


class SpecificationRegenerateView(APIView):
    """``POST`` ``/.../specifications/<id>/regenerate/``.

    Re-pins the sheet to a newer ``FormulationVersion`` so the derived
    sections (actives, nutrition, allergens, ingredients declaration,
    weight, packaging auto-seed) refresh against the new snapshot
    without wiping scientist-typed fields.

    Payload: ``{ "formulation_version_id": "...", "force": false }``.

    ``force`` is required when the sheet's linked proposal is in the
    ``sent`` state — the customer has seen the document, so mutating
    it is a decision the operator has to confirm explicitly. The
    endpoint replies 409 on the first (non-force) call so the FE can
    render the confirmation modal, then accepts the retry.

    Never allowed when the linked proposal is ``accepted`` (or the
    sheet / proposal carries ``customer_signed_at``) — that sheet has
    crossed into audit-artefact territory and must not be rewritten.
    Callers create a fresh spec (an amendment) instead.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

        payload = request.data if isinstance(request.data, dict) else {}
        new_version_id = payload.get("formulation_version_id")
        if not new_version_id:
            return Response(
                {"formulation_version_id": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        force = bool(payload.get("force"))

        try:
            regenerated = regenerate_sheet(
                sheet=sheet,
                actor=request.user,
                new_formulation_version_id=new_version_id,
                force=force,
            )
        except FormulationVersionNotInOrg:
            return Response(
                {
                    "formulation_version_id": [
                        "formulation_version_not_in_org"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SheetLockedBySignedProposal:
            return Response(
                {"code": "sheet_locked_by_signed_proposal"},
                status=status.HTTP_409_CONFLICT,
            )
        except SheetRegenerationRequiresForce:
            return Response(
                {"code": "sheet_regeneration_requires_force"},
                status=status.HTTP_409_CONFLICT,
            )
        except SpecificationNotMutable:
            return Response(
                {"detail": ["specification_not_mutable"]},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            SpecificationSheetReadSerializer(regenerated).data,
            status=status.HTTP_200_OK,
        )


class SpecificationRenderView(APIView):
    """``GET`` ``/.../specifications/<id>/render/``.

    Returns the flat view-model the frontend uses to paint the HTML
    spec sheet. Computed fresh each request from the locked-in
    ``FormulationVersion.snapshot_totals`` — no catalogue edits
    downstream can rewrite what a client sees once the sheet exists.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str, sheet_id: str) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc
        return Response(render_context(sheet), status=status.HTTP_200_OK)


class SpecificationPdfView(APIView):
    """``GET`` ``/.../specifications/<id>/pdf/``.

    Streams a WeasyPrint-generated PDF of the spec sheet. Same
    read-only permission as the JSON render endpoint — anyone who can
    view the sheet in the browser can download it as PDF.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, sheet_id: str
    ) -> HttpResponse:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

        # Cached + serialized — repeat clicks within ``ttl`` reuse
        # the bytes, concurrent clicks queue on the render lock so
        # only one WeasyPrint call runs at a time per worker. See
        # :mod:`config.pdf_cache` for the rationale.
        pdf_bytes, filename = cached_render(
            f"spec-pdf:{sheet.id}",
            lambda: render_pdf(sheet),
        )
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        # ``inline`` lets the browser preview in-tab; the frontend
        # adds ?download=1 when it wants to force a save-as dialog.
        disposition = (
            "attachment"
            if request.query_params.get("download") in {"1", "true"}
            else "inline"
        )
        response["Content-Disposition"] = (
            f'{disposition}; filename="{filename}"'
        )
        return response


class SpecificationVisibilityView(APIView):
    """``PUT`` ``/.../specifications/<id>/visibility/``.

    Write partial visibility toggles for the customer-facing sheet.
    Deliberately gated on ``formulations.manage_spec_visibility``
    (separate from ``edit``) so commercial/QA leads can hide sensitive
    sections without needing write access to the sheet's content.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.MANAGE_SPEC_VISIBILITY

    def put(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

        payload = request.data if isinstance(request.data, dict) else {}
        raw_visibility = payload.get("visibility")
        raw_order = payload.get("order")
        if raw_visibility is None and raw_order is None:
            return Response(
                {"visibility": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        updated = sheet
        try:
            if raw_visibility is not None:
                if not isinstance(raw_visibility, dict):
                    return Response(
                        {"visibility": ["invalid"]},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                # Coerce defensively: JSON booleans only. Strings like
                # ``"false"`` would silently coerce to ``True`` otherwise.
                visibility: dict[str, bool] = {}
                for slug, value in raw_visibility.items():
                    if isinstance(value, bool):
                        visibility[slug] = value
                    elif isinstance(value, (int, float)):
                        visibility[slug] = bool(value)
                updated = set_section_visibility(
                    sheet=updated,
                    actor=request.user,
                    visibility=visibility,
                )

            if raw_order is not None:
                if not isinstance(raw_order, list):
                    return Response(
                        {"order": ["invalid"]},
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                updated = set_section_order(
                    sheet=updated,
                    actor=request.user,
                    order=raw_order,
                )
        except SpecificationNotMutable:
            return Response(
                {"detail": ["specification_not_mutable"]},
                status=status.HTTP_409_CONFLICT,
            )

        return Response(render_context(updated), status=status.HTTP_200_OK)


class SpecificationPackagingView(APIView):
    """``POST`` ``/.../specifications/<id>/packaging/``.

    Partial update of one or more of the four packaging slots. The
    body is a subset of ``{packaging_lid, packaging_container,
    packaging_label, packaging_antitemper}`` — each value is an item
    UUID from the org packaging catalogue, or ``null`` to clear that
    slot. Unspecified slots are left untouched.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        try:
            sheet = get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

        serializer = SpecificationPackagingSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        selections = {
            key: str(value) if value is not None else None
            for key, value in serializer.validated_data.items()
        }
        try:
            updated = set_packaging(
                sheet=sheet,
                actor=request.user,
                selections=selections,
            )
        except PackagingItemNotAllowed:
            return Response(
                {"packaging": ["packaging_item_not_allowed"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except SpecificationNotMutable:
            return Response(
                {"detail": ["specification_not_mutable"]},
                status=status.HTTP_409_CONFLICT,
            )
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )


#: Default / max values for the packaging search endpoint. The hard
#: cap exists so a misbehaving client cannot ask for "give me the
#: whole catalogue" in one round-trip.
_PACKAGING_DEFAULT_LIMIT = 50
_PACKAGING_MAX_LIMIT = 200


class SpecificationPackagingOptionsView(APIView):
    """``GET`` ``/.../specifications/packaging-options/``.

    Server-side search across the org's packaging catalogue,
    scoped to one slot at a time. Query parameters:

    - ``slot`` (required) — one of the four packaging slots.
    - ``search`` (optional) — substring matched case-insensitively
      against ``name`` and ``internal_code``.
    - ``limit`` (optional) — page size, defaults to 50, clamped to 200.

    The endpoint deliberately returns only what the caller asks
    for: at catalogue scale (potentially millions of packaging
    rows across orgs) shipping everything at once is a non-starter
    for both the wire and the browser. The picker component on the
    client debounces ``search`` keystrokes so the typing latency is
    a single round-trip per pause.

    Performance note: the underlying filter joins on the ``(catalogue,
    name)`` index for the ORDER + LIMIT, then filters
    ``attributes->>'packaging_type'`` in-memory. For tenants pushing
    past ~100K packaging rows, the long-term fix is to denormalise
    ``packaging_type`` to a real column so a composite index picks up
    the full predicate — tracked out of band, not blocking F4.1.
    """

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str) -> Response:
        slot = request.query_params.get("slot")
        if slot not in PACKAGING_SLOT_TYPES:
            return Response(
                {"slot": ["invalid_slot"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        expected_type = PACKAGING_SLOT_TYPES[slot]

        search = (request.query_params.get("search") or "").strip()

        try:
            raw_limit = int(request.query_params.get("limit") or _PACKAGING_DEFAULT_LIMIT)
        except (TypeError, ValueError):
            raw_limit = _PACKAGING_DEFAULT_LIMIT
        limit = max(1, min(raw_limit, _PACKAGING_MAX_LIMIT))

        catalogue = Catalogue.objects.filter(
            organization=self.organization, slug=PACKAGING_SLUG
        ).first()
        if catalogue is None:
            return Response({"results": [], "slot": slot, "limit": limit})

        queryset = Item.objects.filter(
            catalogue=catalogue,
            is_archived=False,
            attributes__packaging_type=expected_type,
        )
        if search:
            from django.db.models import Q

            queryset = queryset.filter(
                Q(name__icontains=search)
                | Q(internal_code__icontains=search)
            )
        items = list(
            queryset.order_by("name").values("id", "name", "internal_code")[
                :limit
            ]
        )
        results = [
            {
                "id": str(row["id"]),
                "name": row["name"],
                "internal_code": row["internal_code"],
            }
            for row in items
        ]
        return Response({"results": results, "slot": slot, "limit": limit})


class SpecificationPublicLinkView(APIView):
    """``POST`` rotates (or issues) the sheet's public preview token;
    ``DELETE`` revokes it. Gated on ``approve`` because publishing a
    spec sheet to a client is a commercial decision, not a content
    edit."""

    permission_classes = (HasSpecificationsPermission,)
    required_capability = FormulationsCapability.APPROVE

    def _load(self, sheet_id: str):
        try:
            return get_sheet(
                organization=self.organization, sheet_id=sheet_id
            )
        except SpecificationNotFound as exc:
            raise NotFound() from exc

    def post(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        updated = rotate_public_token(sheet=sheet, actor=request.user)
        return Response(
            SpecificationSheetReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, sheet_id: str
    ) -> Response:
        sheet = self._load(sheet_id)
        revoke_public_token(sheet=sheet, actor=request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Public (token-gated, no authentication) endpoints
# ---------------------------------------------------------------------------


class PublicSpecificationRenderView(APIView):
    """``GET`` ``/api/public/specifications/<token>/``.

    Unauthenticated read-only render of a shared sheet. Identical
    payload to :class:`SpecificationRenderView` so the same frontend
    component can consume it. Returns 404 for any malformed, unknown,
    or revoked token — the single error code deliberately blurs the
    distinction so a leaked link cannot be probed.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> Response:
        try:
            sheet = get_by_public_token(token)
        except PublicLinkNotEnabled as exc:
            raise NotFound() from exc
        return Response(render_context(sheet), status=status.HTTP_200_OK)


@method_decorator(xframe_options_sameorigin, name="dispatch")
class PublicSpecificationPdfView(APIView):
    """Token-gated PDF download — same body as the authenticated PDF
    view but reached via the public token.

    Same-origin iframe embedding is allowed so the proposal kiosk
    (which renders an iframe per attached spec) can load this
    response; without it Django's default ``X-Frame-Options: DENY``
    shows the broken-file placeholder instead of the spec sheet.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> HttpResponse:
        try:
            sheet = get_by_public_token(token)
        except PublicLinkNotEnabled as exc:
            raise NotFound() from exc

        # Cached + render-locked — see :mod:`config.pdf_cache`.
        # Public endpoint, so the cache + lock matter most here:
        # a customer email blast that drops everyone on the kiosk
        # at the same time would otherwise OOM the worker on the
        # very first batch of Download clicks.
        pdf_bytes, filename = cached_render(
            f"spec-pdf:{sheet.id}",
            lambda: render_pdf(sheet),
        )
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        disposition = (
            "attachment"
            if request.query_params.get("download") in {"1", "true"}
            else "inline"
        )
        response["Content-Disposition"] = (
            f'{disposition}; filename="{filename}"'
        )
        # 5-minute CDN-friendly cache; ``must-revalidate`` so an
        # edit-then-share workflow won't serve a stale PDF after
        # the spec has been re-signed. The render itself is also
        # cached in-process for 60s by :mod:`config.pdf_cache` so
        # an aggressive refresh from one client doesn't queue
        # WeasyPrint renders behind it.
        response["Cache-Control"] = "public, max-age=300, must-revalidate"
        return response


class PublicProposalRenderView(APIView):
    """``GET`` ``/api/public/specifications/<token>/proposal/``.

    Returns the proposal attached to the shared spec sheet — as a PDF
    rendered from the real Vita NPD Word template. The kiosk iframe
    loads it inline so the customer sees the exact document they're
    being asked to sign. Falls back to the HTML approximation when the
    server has no DOCX→PDF converter (Linux boxes without
    LibreOffice). 404 when no proposal is linked so the kiosk knows
    to hide the section.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def get(self, request: Request, token: str) -> HttpResponse:
        # Lazy import — the proposals app is imported only when this
        # endpoint fires so the specifications module stays load-clean
        # in environments that don't serve proposals yet.
        from apps.proposals.api.views import _render_proposal_html
        from apps.specifications.services import resolve_linked_proposal

        try:
            sheet = get_by_public_token(token)
        except PublicLinkNotEnabled as exc:
            raise NotFound() from exc

        # ``resolve_linked_proposal`` falls back to ``ProposalLine``
        # when the legacy OneToOne is empty — without it every spec
        # past the first one in a multi-spec proposal would 404 here
        # and the iframe on the spec kiosk would render an error.
        proposal = resolve_linked_proposal(sheet)
        if proposal is None:
            raise NotFound()

        # Proposals are served as HTML on every surface (in-app
        # preview + customer kiosk) so the layout is identical
        # everywhere — same Django template, same browser engine.
        return HttpResponse(_render_proposal_html(proposal))


class PublicSpecificationAcceptView(APIView):
    """``POST`` ``/api/public/specifications/<token>/accept/``.

    Kiosk sign-off endpoint. Takes the drawn signature + signer
    identity, cross-checks identity against the active kiosk
    session cookie (issued when the visitor entered their details
    on the public page), and flips the sheet from ``sent`` to
    ``accepted``. Unauthenticated but not anonymous — the signer
    has proven who they are by establishing a kiosk session first.
    """

    permission_classes = (AllowAny,)
    authentication_classes: tuple = ()

    def post(self, request: Request, token: str) -> Response:
        from apps.comments.kiosk import (
            KioskSessionInvalid,
            KioskSessionRevoked,
            KioskTokenInvalid,
            resolve_from_request,
        )
        from config.signatures import SignatureImageInvalid

        try:
            sheet = get_by_public_token(token)
        except PublicLinkNotEnabled as exc:
            raise NotFound() from exc

        try:
            identity = resolve_from_request(request, str(token))
        except (
            KioskSessionInvalid,
            KioskSessionRevoked,
            KioskTokenInvalid,
        ):
            return Response(
                {"detail": ["kiosk_session_required"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        serializer = SpecificationCustomerAcceptSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        session = identity.session
        posted_name = (data.get("name") or "").strip().lower()
        session_name = (session.guest_name or "").strip().lower()
        if posted_name and session_name and posted_name != session_name:
            return Response(
                {"name": ["identity_mismatch"]},
                status=status.HTTP_403_FORBIDDEN,
            )

        try:
            updated = accept_as_customer(
                sheet=sheet,
                signer_name=data.get("name") or session.guest_name,
                signer_email=data.get("email") or session.guest_email,
                signer_company=(
                    data.get("company") or session.guest_org_label
                ),
                signature_image=data["signature_image"],
            )
        except InvalidStatusTransition:
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
                "status": updated.status,
                "customer_name": updated.customer_name,
                "customer_signed_at": (
                    updated.customer_signed_at.isoformat()
                    if updated.customer_signed_at is not None
                    else None
                ),
            },
            status=status.HTTP_200_OK,
        )
