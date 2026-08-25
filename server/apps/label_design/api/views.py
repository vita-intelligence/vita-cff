"""Views for the label-design staff API.

Endpoint groups:

* Read: list, detail, transitions audit
* Mutation: assign-designer, upload-artwork, submit-for-review,
  scientist-review, director-review, hold / resume
* Content block: JSON / PDF / PNG / text exports of the spec-derived
  compliance content block

The portal-facing counterparts live in
:mod:`apps.client_portal.api.label_design_views` and reuse the
same read serializers via composition so the wire shape stays
consistent.
"""

from __future__ import annotations

import logging

from django.db.models import Count, Q
from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.audit.services import record as record_audit
from apps.label_design.api.permissions import HasLabellingPermission
from apps.label_design.api.serializers import (
    AssignDesignerSerializer,
    HoldResumeSerializer,
    LabelDesignListItemSerializer,
    LabelDesignReadSerializer,
    LabelDesignReviewReadSerializer,
    ReviewSubmitSerializer,
    UploadArtworkSerializer,
)
from apps.label_design.constants import (
    LabelDesignStatus,
    ReviewKind,
    ReviewOutcome,
    RevisionSource,
)
from apps.label_design.models import (
    LabelDesign,
    LabelDesignReview,
    LabelDesignRevision,
    LabelDesignRevisionAsset,
    LabelDesignTransition,
)
from apps.label_design.services import (
    InvalidStatusTransition,
    transition_status,
)
from apps.organizations.modules import LabellingCapability
from apps.label_design.content_block import (
    compute_content_block,
    render_content_block_html,
    render_content_block_pdf,
    render_content_block_png,
    render_content_block_text,
)


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# List / detail
# ---------------------------------------------------------------------------


def _get_label_design(org, label_design_id) -> LabelDesign:
    label_design = (
        LabelDesign.objects.filter(organization=org, id=label_design_id)
        .select_related(
            "formulation",
            "organization",
            "current_revision",
            "preferences",
            "assigned_designer",
        )
        .prefetch_related("revisions__reviews", "preferences__inspiration_files")
        .first()
    )
    if label_design is None:
        raise NotFound()
    return label_design


_LIST_DEFAULT_LIMIT = 25
_LIST_MAX_LIMIT = 100


class LabelDesignListView(APIView):
    """Paginated + searchable staff queue.

    Query params:

    * ``status`` — exact match on ``LabelDesign.status``
    * ``designer`` — exact match on ``assigned_designer_id``
    * ``search`` — case-insensitive substring on the project code
      and product name (icontains)
    * ``limit`` — page size, clamped to ``[1, 100]`` (default 25)
    * ``offset`` — number of rows to skip (default 0)

    Response shape (mirrors :mod:`apps.payments.api.views`'s pending
    queue so the FE can reuse the same TanStack ``useInfiniteQuery``
    pattern):

    ``{
        "items": [...],
        "total": int,            # rows matching filters
        "has_more": bool,
        "next_offset": int|None,
        "counts_by_status": {<status>: int, ...}   # respects search
                                                  # but ignores ``status``
                                                  # filter so the tab
                                                  # pills always show
                                                  # the full picture
    }``

    Uses :class:`LabelDesignListItemSerializer` (slim) so a 100-row
    page is ~10× smaller than the old detail-shape payload.
    """

    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        from apps.organizations.services import has_capability, get_membership

        base_qs = (
            LabelDesign.objects.filter(organization=self.organization)
            .select_related("formulation", "assigned_designer")
        )

        search = (request.query_params.get("search") or "").strip()
        if search:
            base_qs = base_qs.filter(
                Q(formulation__code__icontains=search)
                | Q(formulation__name__icontains=search)
            )

        designer_filter = request.query_params.get("designer")
        if designer_filter:
            base_qs = base_qs.filter(assigned_designer_id=designer_filter)

        # ``scope=mine|all`` — a rank-and-file designer only sees
        # their work + anything still unclaimed, so the queue isn't
        # drowned by every other designer's load. A manager (the
        # ``labelling.manage`` cap holder) DEFAULTS to ``all`` —
        # the whole point of holding that grant is to see the
        # whole team's load. Either side can override with an
        # explicit ``?scope=`` query param if they need the other
        # view temporarily.
        membership = get_membership(request.user, self.organization)
        can_view_all = bool(
            membership
            and has_capability(
                membership, "labelling", LabellingCapability.MANAGE
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
            base_qs = base_qs.filter(
                Q(assigned_designer_id=request.user.id)
                | Q(assigned_designer__isnull=True)
            )

        # ``counts_by_status`` runs over the search-filtered set but
        # NOT the status-filtered set — that way the FE can render
        # tab pills showing "how many would appear if I clicked this
        # tab" even while a different tab is active. The dict
        # already tells us every status' count, so the
        # status-filtered total is just a dict lookup — no need for
        # a second ``qs.count()`` round-trip when the user is on a
        # specific tab.
        counts = dict(
            base_qs.values_list("status")
            .annotate(c=Count("id"))
            .values_list("status", "c")
        )

        qs = base_qs
        status_filter = request.query_params.get("status")
        if status_filter:
            qs = qs.filter(status=status_filter)
            total = counts.get(status_filter, 0)
        else:
            total = sum(counts.values())

        try:
            limit = int(request.query_params.get("limit") or _LIST_DEFAULT_LIMIT)
        except (TypeError, ValueError):
            limit = _LIST_DEFAULT_LIMIT
        limit = max(1, min(limit, _LIST_MAX_LIMIT))
        try:
            offset = int(request.query_params.get("offset") or 0)
        except (TypeError, ValueError):
            offset = 0
        offset = max(0, offset)

        rows = list(qs.order_by("-updated_at")[offset : offset + limit])
        items = LabelDesignListItemSerializer(rows, many=True).data
        next_offset = offset + len(rows)
        has_more = next_offset < total
        return Response(
            {
                "items": items,
                "total": total,
                "has_more": has_more,
                "next_offset": next_offset if has_more else None,
                "counts_by_status": counts,
                "scope": raw_scope,
                "scope_capabilities": {"can_view_all": can_view_all},
            }
        )


class LabelDesignDetailView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        return Response(LabelDesignReadSerializer(label_design).data)


class LabelDesignSpecRenderView(APIView):
    """``GET`` ``/.../label-designs/<id>/spec/``.

    Passthrough to ``apps.specifications.services.render_context`` for
    the spec sheet attached to this label design. Lives on the
    labelling API (not the specifications one) so a designer with
    only ``labelling.view`` can read the spec without needing
    ``formulations.view`` — the spec they get is strictly the one
    bound to the label design they can already see.
    """

    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        from apps.specifications.services import render_context

        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        sheet = label_design.specification_sheet
        if sheet is None:
            raise NotFound("No spec sheet is attached to this label design.")
        return Response(render_context(sheet))


class LabelDesignAssignDesignerView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.MANAGE

    def post(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        serializer = AssignDesignerSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        designer_id = serializer.validated_data.get("designer_id")

        if designer_id is None:
            label_design.assigned_designer = None
        else:
            from apps.accounts.models import User
            from apps.organizations.services import get_membership

            user = User.objects.filter(pk=designer_id).first()
            if user is None or get_membership(user, self.organization) is None:
                raise ValidationError(
                    {"designer_id": "user is not a member of this organization"}
                )
            label_design.assigned_designer = user
        label_design.save(update_fields=["assigned_designer", "updated_at"])

        record_audit(
            organization=label_design.organization,
            actor=request.user,
            action="label_design.assign_designer",
            target=label_design,
            before=None,
            after={"assigned_designer_id": str(designer_id) if designer_id else None},
        )
        return Response(LabelDesignReadSerializer(label_design).data)


# ---------------------------------------------------------------------------
# Artwork upload + review submission
# ---------------------------------------------------------------------------


def _next_revision_number(label_design: LabelDesign) -> int:
    last = (
        LabelDesignRevision.objects.filter(label_design=label_design)
        .order_by("-revision_number")
        .values_list("revision_number", flat=True)
        .first()
    )
    return (last or 0) + 1


#: Cap the supplementary-file count per revision. Ten is generous
#: enough for front / back / left / right / top / bottom / mockup
#: shots and still leaves headroom before the multipart body gets
#: unwieldy. Enforced at every upload path.
MAX_ADDITIONAL_ASSETS: int = 10


def _attach_additional_assets(
    *,
    revision: LabelDesignRevision,
    request: Request,
    labels: list[str],
) -> None:
    """Persist any ``additional_files`` uploaded alongside the primary
    artwork.

    Files ride the multipart body under the ``additional_files`` field
    (repeated); their user-facing labels ride via the parallel
    ``additional_file_labels`` array (JSON-encoded string, positional).
    A missing / short label array is fine — the FE renders "View N" as
    a fallback.
    """

    uploads = request.FILES.getlist("additional_files") or []
    if not uploads:
        return
    if len(uploads) > MAX_ADDITIONAL_ASSETS:
        raise ValidationError(
            {
                "detail": (
                    f"At most {MAX_ADDITIONAL_ASSETS} extra artwork "
                    "files per revision."
                ),
                "code": "too_many_additional_files",
            }
        )
    for idx, upload in enumerate(uploads):
        # Reuse the same file-type + size validator as the primary
        # artwork so the additional assets can't smuggle a
        # 500 MB video through the back door.
        from apps.label_design.api.serializers import (
            _validate_artwork_file,
        )

        _validate_artwork_file(upload)
        label = ""
        if idx < len(labels):
            label = str(labels[idx] or "")[:80]
        LabelDesignRevisionAsset.objects.create(
            revision=revision,
            file=upload,
            label=label,
            sort_order=idx,
            original_filename=(upload.name or "")[:255],
            content_type=(
                (getattr(upload, "content_type", "") or "").lower()
            )[:120],
            size_bytes=int(getattr(upload, "size", 0) or 0),
        )


def _make_compliance_snapshot(label_design: LabelDesign) -> dict:
    """Freeze the compliance content block onto the new revision.

    If the spec sheet pointer is missing we still create the revision
    — the snapshot is just empty. Slice 4's drift check surfaces that
    case to staff.
    """

    if label_design.specification_sheet is None:
        return {}
    try:
        block = compute_content_block(label_design.specification_sheet)
        return block.to_dict()
    except Exception:  # pragma: no cover - defence in depth
        logger.exception(
            "content-block snapshot failed for label_design %s",
            label_design.pk,
        )
        return {}


class LabelDesignUploadArtworkView(APIView):
    """Staff uploads finished artwork. Creates a new revision and sets
    it as ``current_revision`` so the workspace UI surfaces it. Does
    NOT transition status — that's a separate ``submit-for-review``
    call so the designer can iterate locally before showing it to
    reviewers.

    Hard-gated to DESIGN_BY_US: the moment the customer picks
    DESIGN_BY_CUSTOMER they own the artwork pipeline and staff has
    no business pushing a competing revision. The portal upload
    endpoint is the only legitimate write surface on that path.
    """

    permission_classes = [HasLabellingPermission]
    # DRF defaults to JSON-only parsing; override here so the
    # ``artwork`` FileField actually receives the upload body
    # instead of returning 415 ``Unsupported Media Type``.
    parser_classes = (MultiPartParser, FormParser)
    required_capability = LabellingCapability.DESIGN

    def post(self, request: Request, **kwargs) -> Response:
        from apps.label_design.constants import LabelDesignPath

        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.design_path == LabelDesignPath.DESIGN_BY_CUSTOMER:
            raise ValidationError(
                {
                    "detail": (
                        "This label is on the DESIGN_BY_CUSTOMER path — only "
                        "the customer can upload artwork. Switch the path on "
                        "the workspace if you need to take over."
                    ),
                    "code": "wrong_path",
                }
            )
        serializer = UploadArtworkSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        revision = LabelDesignRevision.objects.create(
            label_design=label_design,
            revision_number=_next_revision_number(label_design),
            submitted_by_user=request.user,
            source=RevisionSource.STAFF_UPLOAD,
            artwork_pdf=serializer.validated_data["artwork"],
            notes=serializer.validated_data["notes"],
            compliance_block_snapshot=_make_compliance_snapshot(label_design),
        )
        _attach_additional_assets(
            revision=revision,
            request=request,
            labels=serializer.validated_data.get("additional_file_labels", []),
        )
        label_design.current_revision = revision
        label_design.save(update_fields=["current_revision", "updated_at"])

        record_audit(
            organization=label_design.organization,
            actor=request.user,
            action="label_design.upload_artwork",
            target=label_design,
            before=None,
            after={
                "revision_id": str(revision.id),
                "additional_assets": revision.additional_assets.count(),
            },
        )
        return Response(
            LabelDesignReadSerializer(label_design).data,
            status=status.HTTP_201_CREATED,
        )


class LabelDesignSubmitForReviewView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.DESIGN

    def post(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.current_revision is None:
            raise ValidationError(
                {"detail": "No artwork uploaded yet.", "code": "no_revision"}
            )
        # A revision is locked once any reviewer touches it — the
        # ``(revision, kind)`` UNIQUE constraint on LabelDesignReview
        # means we couldn't store a second scientist OR director
        # review on the same revision even if we wanted to. Force a
        # new upload so the audit trail (reject → resubmit) doesn't
        # lose the prior verdict.
        already_reviewed = LabelDesignReview.objects.filter(
            revision=label_design.current_revision
        ).exists()
        if already_reviewed:
            raise ValidationError(
                {
                    "detail": (
                        "This revision was already reviewed. Upload a new "
                        "artwork revision before resubmitting — that keeps "
                        "the previous review on the record."
                    ),
                    "code": "revision_already_reviewed",
                }
            )
        try:
            transition_status(
                label_design,
                to_status=LabelDesignStatus.SCIENTIST_REVIEW,
                actor=request.user,
                notes="submitted for review",
                metadata={"revision_id": str(label_design.current_revision_id)},
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})
        return Response(LabelDesignReadSerializer(label_design).data)


class _BaseReviewSubmitView(APIView):
    """Shared logic for the scientist + director review submissions.

    Subclasses set ``review_kind``, ``required_capability``, and
    ``approve_next_status`` (the status to advance to on approval).
    """

    permission_classes = [HasLabellingPermission]
    review_kind: str
    approve_next_status: str
    current_status: str

    def post(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.status != self.current_status:
            raise ValidationError(
                {
                    "detail": (
                        f"label design is not awaiting {self.review_kind} review "
                        f"(current status: {label_design.status})"
                    ),
                    "code": "wrong_status",
                }
            )
        if label_design.current_revision is None:
            raise ValidationError(
                {"detail": "No revision to review.", "code": "no_revision"}
            )

        serializer = ReviewSubmitSerializer(
            data=request.data,
            context={
                # Scientist runs the regulatory checklist; director
                # is signing off on the scientist's verdict so the
                # checklist payload is optional. See the serializer
                # docstring for the regulatory reasoning.
                "require_full_checklist": (
                    self.review_kind == ReviewKind.SCIENTIST
                ),
            },
        )
        serializer.is_valid(raise_exception=True)
        payload = serializer.validated_data

        # Backstop: the model has a UNIQUE(revision, kind) constraint
        # — surfacing the IntegrityError as a 500 to the FE is exactly
        # the kind of "failed" toast the user complained about. The
        # ``submit-for-review`` view should have caught this earlier,
        # but if the FE bypassed it (or two reviewers raced) we still
        # want a friendly 400 instead of a stacktrace.
        existing = LabelDesignReview.objects.filter(
            revision=label_design.current_revision,
            kind=self.review_kind,
        ).first()
        if existing is not None:
            raise ValidationError(
                {
                    "detail": (
                        f"This revision was already reviewed by a "
                        f"{self.review_kind}. Ask the designer to upload "
                        "a new revision before the next review round."
                    ),
                    "code": "revision_already_reviewed",
                }
            )

        # Persist the review row first — it becomes the audit-of-record
        # whether the workflow advances or rolls back.
        review = LabelDesignReview.objects.create(
            revision=label_design.current_revision,
            kind=self.review_kind,
            reviewer=request.user,
            outcome=payload["outcome"],
            checklist_responses=[
                {
                    "item_key": item["item_key"],
                    "pass": item["pass_check"],
                    "comment": item["comment"],
                }
                for item in payload["checklist"]
            ],
            final_comments=payload["final_comments"],
            signature_image=payload["signature_image"],
        )

        if payload["outcome"] == ReviewOutcome.APPROVED:
            target_status = self._resolve_approve_target(label_design)
            transition_status(
                label_design,
                to_status=target_status,
                actor=request.user,
                notes=f"{self.review_kind} approved",
                metadata={"review_id": str(review.id)},
            )
        else:
            transition_status(
                label_design,
                to_status=LabelDesignStatus.DESIGN_IN_PROGRESS,
                actor=request.user,
                notes=f"{self.review_kind} requested revisions",
                metadata={"review_id": str(review.id)},
            )
        return Response(LabelDesignReadSerializer(label_design).data)

    def _resolve_approve_target(self, label_design: LabelDesign) -> str:
        return self.approve_next_status


class LabelDesignScientistReviewView(_BaseReviewSubmitView):
    required_capability = LabellingCapability.REVIEW_SCIENTIST
    review_kind = ReviewKind.SCIENTIST
    current_status = LabelDesignStatus.SCIENTIST_REVIEW
    approve_next_status = LabelDesignStatus.DIRECTOR_REVIEW


class LabelDesignDirectorReviewView(_BaseReviewSubmitView):
    required_capability = LabellingCapability.REVIEW_DIRECTOR
    review_kind = ReviewKind.DIRECTOR
    current_status = LabelDesignStatus.DIRECTOR_REVIEW
    approve_next_status = LabelDesignStatus.CUSTOMER_APPROVAL

    def _resolve_approve_target(self, label_design: LabelDesign) -> str:
        # On the DESIGN_BY_CUSTOMER path the customer already approved
        # by uploading their own artwork — skip CUSTOMER_APPROVAL and
        # land directly on LABEL_APPROVED. On DESIGN_BY_US (or path
        # not yet picked) we route to CUSTOMER_APPROVAL.
        from apps.label_design.constants import LabelDesignPath

        if label_design.design_path == LabelDesignPath.DESIGN_BY_CUSTOMER:
            return LabelDesignStatus.LABEL_APPROVED
        return LabelDesignStatus.CUSTOMER_APPROVAL


# ---------------------------------------------------------------------------
# Hold / resume
# ---------------------------------------------------------------------------


class LabelDesignHoldView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.MANAGE

    def post(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        serializer = HoldResumeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            transition_status(
                label_design,
                to_status=LabelDesignStatus.ON_HOLD,
                actor=request.user,
                notes=serializer.validated_data["notes"],
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})
        return Response(LabelDesignReadSerializer(label_design).data)


class LabelDesignResumeView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.MANAGE

    def post(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        serializer = HoldResumeSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        # Resume to the status the workflow was in before the most
        # recent ON_HOLD transition. Walk back through transitions.
        prior = (
            LabelDesignTransition.objects.filter(label_design=label_design)
            .exclude(to_status=LabelDesignStatus.ON_HOLD)
            .exclude(to_status="")
            .order_by("-created_at")
            .values_list("to_status", flat=True)
            .first()
        )
        target = prior or LabelDesignStatus.DESIGN_IN_PROGRESS
        try:
            transition_status(
                label_design,
                to_status=target,
                actor=request.user,
                notes=serializer.validated_data["notes"] or "resumed",
                metadata={"resumed_to": target},
            )
        except InvalidStatusTransition as exc:
            raise ValidationError({"detail": str(exc), "code": "invalid_transition"})
        return Response(LabelDesignReadSerializer(label_design).data)


# ---------------------------------------------------------------------------
# Transitions audit
# ---------------------------------------------------------------------------


class LabelDesignTransitionsView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        rows = (
            LabelDesignTransition.objects.filter(label_design=label_design)
            .select_related("actor", "actor_client_account")
            .order_by("-created_at")
        )
        data = [
            {
                "id": str(row.id),
                "from_status": row.from_status,
                "to_status": row.to_status,
                "actor_email": row.actor.email if row.actor else "",
                "actor_client_email": (
                    row.actor_client_account.email
                    if row.actor_client_account
                    else ""
                ),
                "notes": row.notes,
                "metadata": row.metadata,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ]
        return Response({"items": data})


class LabelDesignReviewsView(APIView):
    """``GET /api/organizations/<org>/label-designs/<id>/reviews/`` —
    list every review row across all revisions for the timeline tab.
    """

    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        rows = (
            LabelDesignReview.objects.filter(revision__label_design=label_design)
            .select_related("revision", "reviewer")
            .order_by("-created_at")
        )
        return Response(
            {"items": LabelDesignReviewReadSerializer(rows, many=True).data}
        )


# ---------------------------------------------------------------------------
# Content block exports
# ---------------------------------------------------------------------------


class LabelDesignContentBlockJSONView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.specification_sheet is None:
            raise ValidationError(
                {"detail": "No spec sheet attached.", "code": "no_spec"}
            )
        block = compute_content_block(label_design.specification_sheet)
        return Response(block.to_dict())


def _region_slug(request: Request) -> str:
    """Read + sanitise the ``region`` query parameter.

    Unknown values fall back to ``"all"`` rather than 400-ing so
    the file-download path is always safe to click.
    """
    from apps.label_design.content_block import REGION_SLUGS

    raw = (request.query_params.get("region") or "all").strip().lower()
    return raw if raw in REGION_SLUGS else "all"


class LabelDesignContentBlockPDFView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> HttpResponse:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.specification_sheet is None:
            raise ValidationError(
                {"detail": "No spec sheet attached.", "code": "no_spec"}
            )
        region = _region_slug(request)
        block = compute_content_block(label_design.specification_sheet)
        pdf_bytes = render_content_block_pdf(block, region=region)
        response = HttpResponse(pdf_bytes, content_type="application/pdf")
        suffix = f"-{region}" if region != "all" else ""
        response["Content-Disposition"] = (
            f'inline; filename="content-block-{label_design.id}{suffix}.pdf"'
        )
        return response


class LabelDesignContentBlockPNGView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> HttpResponse:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.specification_sheet is None:
            raise ValidationError(
                {"detail": "No spec sheet attached.", "code": "no_spec"}
            )
        try:
            dpi = int(request.query_params.get("dpi", "300"))
        except (TypeError, ValueError):
            dpi = 300
        dpi = max(72, min(dpi, 600))
        region = _region_slug(request)
        block = compute_content_block(label_design.specification_sheet)
        png_bytes = render_content_block_png(block, dpi=dpi, region=region)
        response = HttpResponse(png_bytes, content_type="image/png")
        suffix = f"-{region}" if region != "all" else ""
        response["Content-Disposition"] = (
            f'inline; filename="content-block-{label_design.id}{suffix}.png"'
        )
        return response


class LabelDesignContentBlockTextView(APIView):
    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> Response:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.specification_sheet is None:
            raise ValidationError(
                {"detail": "No spec sheet attached.", "code": "no_spec"}
            )
        block = compute_content_block(label_design.specification_sheet)
        text = render_content_block_text(block)
        return Response({"full": text.full, "sections": text.sections})


class LabelDesignContentBlockHTMLView(APIView):
    """Internal HTML preview surface — same render the PDF/PNG flow
    uses, served as text/html so a designer can iframe it next to a
    Canva tab during drafting."""

    permission_classes = [HasLabellingPermission]
    required_capability = LabellingCapability.VIEW

    def get(self, request: Request, **kwargs) -> HttpResponse:
        label_design = _get_label_design(self.organization, kwargs["label_design_id"])
        if label_design.specification_sheet is None:
            raise ValidationError(
                {"detail": "No spec sheet attached.", "code": "no_spec"}
            )
        block = compute_content_block(label_design.specification_sheet)
        return HttpResponse(render_content_block_html(block), content_type="text/html")
