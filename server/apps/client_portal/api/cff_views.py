"""Customer-portal endpoints for the CFF surface.

The customer-side counterpart to :mod:`apps.cff_submissions.api`.
Where the staff endpoints expose every CFF in the org for triage,
these endpoints scope to the logged-in :class:`ClientAccount` and
surface only the CFFs the customer "owns" — defined by the
ownership union in
:func:`apps.cff_submissions.services.list_customer_cffs`:

    * the CFF's denormalised ``submitter_email`` matches the
      customer's email, OR
    * the CFF is assigned to a project that has at least one
      proposal owned by the customer.

Endpoints:

    * ``GET /api/portal/cffs/`` — list the customer's CFFs,
      newest first.
    * ``GET /api/portal/cffs/<id>/`` — single CFF, 404 on any
      ownership-rule miss.
    * ``GET /api/portal/cffs/<id>/messages/`` — list the SHARED
      comments + the customer's last-read pointer.
    * ``POST /api/portal/cffs/<id>/messages/`` — post a customer
      reply. Goes through :func:`create_comment` so the WS
      broadcast + inbox fan-out fire automatically.
    * ``POST /api/portal/cffs/<id>/messages/read/`` — bump the
      customer's per-thread last-read timestamp.

The comments thread defaults to ``shared`` visibility on the
``cff_submission`` polymorphic target (see
:func:`apps.comments.services.create_comment`) so every staff
comment created on a CFF after the rule change becomes visible to
the customer automatically — no per-comment toggle required.
"""

from __future__ import annotations

from typing import Any

from django.contrib.contenttypes.models import ContentType
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.exceptions import NotFound, ValidationError
from rest_framework.request import Request
from rest_framework.response import Response

from apps.cff_submissions.services import (
    CFFPortalError,
    CFFReorderSubmissionError,
    CFFRTGSubmissionError,
    PortalReorderSubmissionInput,
    PortalRTGSubmissionInput,
    PortalSubmissionInput,
    create_portal_reorder_submission,
    create_portal_rtg_submission,
    create_portal_submission,
    get_customer_cff,
    list_customer_cffs,
    list_reorderable_formulations_for_customer,
)
from apps.client_portal.api.messaging_views import (
    PostMessageSerializer,
    _author_payload,
    _parent_payload,
)
from apps.client_portal.api.views import (
    PortalAPIView,
    _err,
)
from apps.comments.models import Comment, CommentReadState


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------


class PortalCFFListItemSerializer(serializers.Serializer):
    """Wire shape for one CFF row in the portal list.

    Trims the staff payload heavily: the customer doesn't need
    Wix-side import metadata, the assigned-by user, or any
    sales-person hint — they need their own intake state + an
    activity summary so they can pick which thread to read.

    ``lifecycle_state`` is the derived single-value summary the FE
    renders as a chip — cleaner than making the FE walk
    ``has_project`` / ``is_rejected`` / ``wix_status`` and pick one:

    * ``project_created`` — CFF has been attached to at least one
      project. Terminal happy path.
    * ``rejected`` — triage rejected the CFF. Terminal decline path.
    * ``under_review`` — CFF is in the triage queue awaiting a
      decision. Default.
    """

    id = serializers.UUIDField()
    submitted_at = serializers.DateTimeField(source="wix_created_date")
    status = serializers.CharField(source="wix_status")
    has_project = serializers.SerializerMethodField()
    project_code = serializers.SerializerMethodField()
    # Rejection state is customer-visible so they can see the outcome
    # without waiting on an email. The reason is intentionally shown
    # verbatim — internal triage notes are usually short and factual
    # ("duplicate", "off-topic", …); if a specific tenant ever wants
    # to sanitise, it belongs in a per-tenant policy, not a hardcoded
    # rewrite here.
    is_rejected = serializers.BooleanField()
    rejection_reason = serializers.CharField(allow_blank=True)
    rejected_at = serializers.DateTimeField(allow_null=True)
    # In-portal vs marketing-site provenance. Surfaced so the FE can
    # render a subtle "Portal" badge on rows the customer submitted
    # here vs the ones that came in via Wix.
    provenance = serializers.CharField()
    # ``custom`` | ``ready_to_go`` — RTG rows get a distinct chip on
    # the pending state ("Awaiting proposal") because the drafted
    # quote lands quickly and the customer's next action is
    # different.
    submission_kind = serializers.CharField()
    # Single-word lifecycle for chip rendering.
    lifecycle_state = serializers.SerializerMethodField()
    #: Short preview line so the list row reads as more than a
    #: row of identical "CFF · 2026-05-21" stamps. Pulled from the
    #: customer's own form responses (market segment, brief, etc).
    summary = serializers.SerializerMethodField()

    def get_has_project(self, obj) -> bool:
        # CFFs can now be linked to multiple projects via the
        # ``CFFProjectAssignment`` through-table. The portal cares
        # only about the binary "is this CFF on the workshop floor
        # yet" signal — same headline the v1 single-FK shape gave.
        return obj.projects.exists()

    def get_project_code(self, obj) -> str | None:
        # Surface a single code for the list-row pill. When a CFF
        # spans multiple workspaces we pick the first by name (the
        # M2M's default ordering) — the customer rarely needs to see
        # the full set in a flat row; the detail page can expand it
        # later if there's ever demand.
        first = obj.projects.order_by("name").first()
        if first is None:
            return None
        return first.code or first.name or None

    def get_lifecycle_state(self, obj) -> str:
        # Priority order: project_created wins over rejected wins
        # over under_review. In practice a rejected CFF can't also
        # be assigned (the reject service blocks it), but the guard
        # here keeps the FE readable if state ever drifts.
        if obj.projects.exists():
            return "project_created"
        if obj.rejected_at is not None:
            return "rejected"
        return "under_review"

    def get_summary(self, obj) -> str:
        return _summary_line(obj)


class PortalCFFDetailSerializer(PortalCFFListItemSerializer):
    """Detail shape — list fields plus the full raw_payload so the
    customer can re-read everything they submitted."""

    raw_payload = serializers.JSONField()
    # Nullable now that portal-authored submissions exist. Wix rows
    # keep the value; portal rows carry NULL.
    wix_form_id = serializers.UUIDField(allow_null=True)


class PortalCFFMessageSerializer(serializers.Serializer):
    """One comment on a CFF thread, neutral about author side —
    mirrors :class:`PortalMessageSerializer` so the FE can render
    both proposal/spec and CFF threads with one component."""

    id = serializers.UUIDField()
    body = serializers.CharField()
    created_at = serializers.DateTimeField()
    is_deleted = serializers.BooleanField()
    author_kind = serializers.CharField()
    author_name = serializers.CharField()
    author_avatar = serializers.CharField(allow_blank=True)
    thread_target_type = serializers.CharField()
    thread_target_id = serializers.UUIDField()
    parent = serializers.DictField(allow_null=True, required=False)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _summary_line(submission) -> str:
    """Compose a one-line preview for the CFF list row. Walks
    common slugs (market segment, product type, brief) to find
    the first useful customer-typed answer. Falls back to the
    Wix-status pill when nothing readable is on the row."""

    submissions = (
        submission.raw_payload.get("submissions")
        if isinstance(submission.raw_payload, dict)
        else None
    )
    if not isinstance(submissions, dict):
        return ""
    preferred_prefixes = (
        "market_segment",
        "product_type",
        "product_category",
        "brief",
        "summary",
        "company",
    )
    for prefix in preferred_prefixes:
        for slug, value in submissions.items():
            if not slug.startswith(prefix):
                continue
            if isinstance(value, str) and value.strip():
                cleaned = value.strip().replace("\n", " ")
                return cleaned[:160]
    return ""


def _serialise_comment(comment: Comment) -> dict[str, Any]:
    """Reuse the proposal/spec author + parent payload composers so
    the wire shape of a CFF message matches what the FE already
    renders for proposal + spec threads."""

    author = _author_payload(comment)
    body = "" if comment.is_deleted else (comment.body or "")
    return {
        "id": comment.id,
        "body": body,
        "created_at": comment.created_at,
        "is_deleted": comment.is_deleted,
        "author_kind": author["kind"],
        "author_name": author["name"],
        "author_avatar": author["avatar"],
        "thread_target_type": "cff_submission",
        "thread_target_id": comment.cff_submission_id,
        "parent": _parent_payload(comment),
    }


def _load_owned_cff(request: Request, submission_id: str):
    """Resolve the submission by id, gated by the portal-side
    ownership union. 404 either when the row doesn't exist OR
    fails the ownership rule — same leak-proof shape the proposal
    and spec loaders use."""

    submission = get_customer_cff(
        client_account=request.user,
        submission_id=submission_id,
    )
    if submission is None:
        raise NotFound("CFF not found.")
    return submission


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------


class PortalCFFListView(PortalAPIView):
    """``GET /api/portal/cffs/`` — every CFF this customer owns,
    newest first."""

    def get(self, request: Request) -> Response:
        rows = list(
            list_customer_cffs(client_account=request.user)
            # Pre-load the M2M so ``get_has_project`` and
            # ``get_project_code`` don't fan out to one query per
            # row when the list view renders.
            .prefetch_related("projects")
        )
        return Response(
            {"results": PortalCFFListItemSerializer(rows, many=True).data},
        )


class PortalCFFDetailView(PortalAPIView):
    """``GET /api/portal/cffs/<id>/`` — single CFF with the full
    raw_payload so the customer can re-read their own submission."""

    def get(self, request: Request, submission_id: str) -> Response:
        submission = _load_owned_cff(request, submission_id)
        return Response(PortalCFFDetailSerializer(submission).data)


class PortalCFFCreateSerializer(serializers.Serializer):
    """Wire-shape for the multi-step portal wizard's final submit.

    Every field is optional at the serializer level — the service
    layer enforces required-ness so we produce one field-scoped
    error dict regardless of which layer flagged the issue. Multi-
    choice fields ship as lists of strings; the service flattens
    them for storage.
    """

    first_name = serializers.CharField(allow_blank=True, required=False, max_length=200)
    last_name = serializers.CharField(allow_blank=True, required=False, max_length=200)
    email = serializers.EmailField(allow_blank=True, required=False)
    phone = serializers.CharField(allow_blank=True, required=False, max_length=32)
    company_name = serializers.CharField(allow_blank=True, required=False, max_length=200)

    product_formats = serializers.ListField(
        child=serializers.CharField(max_length=64), required=False, default=list,
    )
    market_segment = serializers.CharField(allow_blank=True, required=False, max_length=500)
    dose = serializers.CharField(allow_blank=True, required=False, max_length=500)
    nutritional_requirements = serializers.ListField(
        child=serializers.CharField(max_length=64), required=False, default=list,
    )
    target_sex = serializers.ListField(
        child=serializers.CharField(max_length=32), required=False, default=list,
    )
    target_age = serializers.ListField(
        child=serializers.CharField(max_length=32), required=False, default=list,
    )
    other_nutritional_requirements = serializers.CharField(
        allow_blank=True, required=False, max_length=2000,
    )

    dose_per_unit = serializers.CharField(allow_blank=True, required=False, max_length=500)
    actives_requirements = serializers.CharField(
        allow_blank=True, required=False, max_length=4000,
    )

    primary_package_type = serializers.CharField(
        allow_blank=True, required=False, max_length=200,
    )
    quantity_to_be_quoted = serializers.CharField(
        allow_blank=True, required=False, max_length=64,
    )

    country_region = serializers.CharField(allow_blank=True, required=False, max_length=100)
    address = serializers.CharField(allow_blank=True, required=False, max_length=500)
    city = serializers.CharField(allow_blank=True, required=False, max_length=200)
    postal_code = serializers.CharField(allow_blank=True, required=False, max_length=32)
    delivery_same_as_proposal = serializers.CharField(
        allow_blank=True, required=False, max_length=16,
    )

    account_manager_email = serializers.CharField(
        allow_blank=True, required=False, max_length=320,
    )


class PortalCFFCreateView(PortalAPIView):
    """``POST /api/portal/cffs/``.

    Authenticated portal customer submits the in-portal CFF form.
    The row lands in the triage queue immediately with
    ``provenance=portal``; the customer sees it on their /portal/cffs
    list right after the redirect and can track state as triage
    routes / rejects / creates-project.
    """

    def post(self, request: Request) -> Response:
        payload = PortalCFFCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)

        # Coerce list defaults into tuples so the frozen dataclass is
        # happy. Also handles the "list serializer returns []" default
        # cleanly without a per-field ``or ()`` sprinkle.
        data = dict(payload.validated_data)
        for list_field in (
            "product_formats",
            "nutritional_requirements",
            "target_sex",
            "target_age",
        ):
            data[list_field] = tuple(data.get(list_field) or ())

        typed_input = PortalSubmissionInput(**data)

        try:
            submission = create_portal_submission(
                client_account=request.user,
                payload=typed_input,
            )
        except CFFPortalError as exc:
            field_errors = getattr(exc, "field_errors", None)
            if field_errors:
                return _err(
                    "cff_portal_validation",
                    422,
                    detail=str(exc),
                    fields=field_errors,
                )
            return _err("cff_portal_error", 400, detail=str(exc))

        return Response(
            PortalCFFDetailSerializer(submission).data,
            status=status.HTTP_201_CREATED,
        )


class PortalCFFSalesPeopleView(PortalAPIView):
    """``GET /api/portal/cffs/sales-people/``.

    Feeds the searchable "Vita Manufacture Account Manager" dropdown
    on the portal wizard. Returns every :class:`User` who is a
    member of the customer's org (there's no dedicated "sales"
    role today — every member is a candidate). The customer's
    currently-attached account manager (if any) is flagged so the
    FE can preselect them.
    """

    def get(self, request: Request) -> Response:
        client_account = request.user
        customer = getattr(client_account, "customer", None)
        if customer is None or customer.organization_id is None:
            return Response({"results": [], "default_email": ""})

        from apps.organizations.models import Membership

        # Membership carries no ``is_active`` flag — every row is
        # treated as an active grant. Scope on the User side so
        # deactivated accounts don't leak into the picker.
        rows = (
            Membership.objects
            .select_related("user")
            .filter(
                organization_id=customer.organization_id,
                user__is_active=True,
            )
            .order_by("user__last_name", "user__first_name", "user__email")
        )

        # Best-effort preselect: pull the email off Customer.account_manager
        # when the FK exists, else fall back to the customer's own
        # sales_person if that's what your workspace calls it. Silently
        # skipped when neither field is present so we don't hard-fail
        # tenants that haven't adopted the field yet.
        default_email = ""
        candidate_fields = ("account_manager", "sales_person")
        for field_name in candidate_fields:
            candidate = getattr(customer, field_name, None)
            if candidate is not None:
                email = getattr(candidate, "email", "") or ""
                if email:
                    default_email = email.strip().lower()
                    break

        return Response({
            "results": [
                {
                    "id": str(row.user.id),
                    "full_name": row.user.get_full_name() or row.user.email,
                    "email": row.user.email,
                }
                for row in rows
            ],
            "default_email": default_email,
        })


class PortalCFFMessagesView(PortalAPIView):
    """``GET + POST /api/portal/cffs/<id>/messages/``.

    GET returns the shared comments thread + the read pointer.
    POST creates a customer-side comment via the comments service
    so the broadcast + inbox fan-out + read-state housekeeping all
    happen the same way they do for proposal / spec replies.
    """

    def get(self, request: Request, submission_id: str) -> Response:
        submission = _load_owned_cff(request, submission_id)
        cff_ct = ContentType.objects.get_for_model(submission.__class__)
        comments = (
            Comment.objects
            .filter(
                content_type=cff_ct,
                object_id=submission.id,
                visibility=Comment.Visibility.SHARED,
                organization_id=submission.organization_id,
            )
            .select_related(
                "client_account__customer",
                "author",
                "parent__client_account__customer",
                "parent__author",
            )
            .order_by("created_at")
        )
        read_row = (
            CommentReadState.objects
            .filter(
                viewer_client=request.user,
                content_type=cff_ct,
                object_id=submission.id,
            )
            .values("last_read_at")
            .first()
        )
        return Response(
            {
                "results": [_serialise_comment(c) for c in comments],
                "read_state": (
                    read_row["last_read_at"].isoformat()
                    if read_row else None
                ),
                "cff_id": str(submission.id),
            },
        )

    def post(self, request: Request, submission_id: str) -> Response:
        submission = _load_owned_cff(request, submission_id)

        try:
            data = PostMessageSerializer(data=request.data)
            data.is_valid(raise_exception=True)
        except ValidationError as exc:
            return _err(
                "invalid_message",
                status.HTTP_400_BAD_REQUEST,
                detail=exc.detail,
            )

        from apps.cff_submissions.models import CFFSubmission

        cff_ct = ContentType.objects.get_for_model(CFFSubmission)
        parent_id = data.validated_data.get("parent_id")
        parent: Comment | None = None
        if parent_id:
            parent = (
                Comment.objects
                .filter(
                    pk=parent_id,
                    content_type=cff_ct,
                    object_id=submission.id,
                    visibility=Comment.Visibility.SHARED,
                    organization_id=submission.organization_id,
                )
                .first()
            )
            if parent is None:
                return _err(
                    "invalid_reply_target",
                    status.HTTP_400_BAD_REQUEST,
                )
            # Two-level reply cap, same as the proposal + spec
            # messaging paths.
            if parent.parent_id is not None:
                parent = parent.parent

        with transaction.atomic():
            comment = Comment.objects.create(
                organization_id=submission.organization_id,
                content_type=cff_ct,
                object_id=submission.id,
                cff_submission=submission,
                client_account=request.user,
                visibility=Comment.Visibility.SHARED,
                body=data.validated_data["body"],
                parent=parent,
            )
            # Same broadcast hop the proposal-chat post path takes
            # — lands on ``comments.cff_submission.<id>`` so any
            # staff / customer WS attached to this CFF sees the
            # message instantly instead of waiting for the next
            # poll cycle.
            from apps.comments.broadcast import schedule_comment_broadcast

            schedule_comment_broadcast(comment, "created")

        return Response(
            _serialise_comment(comment),
            status=status.HTTP_201_CREATED,
        )


class PortalRTGCatalogItemSerializer(serializers.Serializer):
    """Wire shape for one card on the customer-facing RTG catalog.

    Deliberately lean — hides the recipe, ownership, and pricing
    ancestry. Customers see only what they need to decide whether
    to order: a hero, a headline, marketing sub-copy, the price
    anchor, MOQ, and the packaging options they'll pick from.
    ``hero_image_url`` may be ``null`` when staff hasn't uploaded an
    image; the FE renders a monogram tile in that case.
    """

    id = serializers.UUIDField()
    # URL-safe identifier the marketing site uses for the product
    # detail page (``/products/ready-to-go/<slug>``). Nullable —
    # unpublished / freshly-migrated rows may not have one yet, but
    # every published RTG that comes through this endpoint will.
    slug = serializers.CharField(source="rtg_slug", allow_null=True)
    # ``name`` is the customer-facing label: the marketing display
    # name if staff set one, otherwise the formulation's internal
    # name. Portal callers get one field to render — the fallback
    # logic lives here so every consumer doesn't reimplement it.
    name = serializers.SerializerMethodField()
    short_description = serializers.CharField(source="rtg_short_description")
    #: Legacy sanitized HTML body from the standalone rich-text
    #: editor. Portal falls back to this when ``page_content`` is
    #: null so pre-migration listings still render.
    long_description = serializers.CharField(
        source="rtg_long_description", default=""
    )
    #: Puck page-builder JSON schema. Portal renders this via
    #: Puck's ``<Render>`` when set — takes precedence over the
    #: legacy HTML. ``None`` means the SKU still uses the old flow.
    page_content = serializers.JSONField(
        source="rtg_page_content", allow_null=True
    )
    hero_image_url = serializers.SerializerMethodField()
    #: Full multi-photo gallery for the storefront (primary first).
    #: Empty when staff hasn't added any. Portal renders the whole
    #: list as a click-through gallery below the hero.
    gallery = serializers.SerializerMethodField()
    base_price = serializers.DecimalField(
        source="rtg_base_price", max_digits=12, decimal_places=2,
    )
    currency_code = serializers.CharField(source="rtg_currency_code")
    moq = serializers.IntegerField(source="rtg_moq")
    # Optional paid sample. ``sample_price = null`` means the SKU
    # doesn't offer samples right now; the FE hides the sample CTA.
    # Currency mirrors ``currency_code`` (samples are billed on the
    # same tender as the main order).
    sample_price = serializers.DecimalField(
        source="rtg_sample_price",
        max_digits=10,
        decimal_places=2,
        allow_null=True,
    )
    sample_description = serializers.CharField(
        source="rtg_sample_description", allow_blank=True, default="",
    )
    packaging_options = serializers.ListField(
        source="rtg_packaging_options",
        child=serializers.CharField(),
    )
    # Phase 2 packaging combos. Portal picker prefers this list when
    # non-empty; falls back to the legacy free-text ``packaging_options``
    # for cards published before the combo model existed.
    packaging_combos = serializers.SerializerMethodField()

    def _catalog_photos(self, obj):
        """Ordered catalog gallery for this formulation — primary
        first, then explicit sort order. Cached on the wrapper so
        both ``hero_image_url`` and ``gallery`` reuse the same query
        per row without a second trip."""

        cached = getattr(self, "_catalog_photos_cache", None)
        if cached is not None and cached[0] is obj:
            return cached[1]
        from apps.formulations.models import FormulationPhoto

        rows = list(
            obj.photos.filter(
                purpose=FormulationPhoto.Purpose.CATALOG,
            ).order_by("-is_primary", "sort_order", "uploaded_at")
        )
        self._catalog_photos_cache = (obj, rows)
        return rows

    def get_hero_image_url(self, obj) -> str | None:
        # Prefer the primary catalog photo when the new gallery has
        # anything at all — every card added post-migration comes in
        # through the gallery, so the legacy hero is only a fallback
        # for rows that pre-date the feature.
        for photo in self._catalog_photos(obj):
            if photo.image:
                try:
                    return photo.image.url
                except ValueError:
                    continue
        image = getattr(obj, "rtg_hero_image", None)
        if image and hasattr(image, "url"):
            try:
                return image.url
            except ValueError:
                return None
        return None

    def get_gallery(self, obj) -> list[dict]:
        out: list[dict] = []
        for photo in self._catalog_photos(obj):
            if not photo.image:
                continue
            try:
                url = photo.image.url
            except ValueError:
                continue
            out.append(
                {
                    "id": str(photo.id),
                    "url": url,
                    "caption": photo.caption,
                    "is_primary": photo.is_primary,
                }
            )
        return out

    def get_name(self, obj) -> str:
        display = (getattr(obj, "rtg_display_name", "") or "").strip()
        return display or obj.name

    def get_packaging_combos(self, obj) -> list[dict]:
        """Portal picker payload — combo id + name + price delta +
        item names. Items are just labels here (no quantity / codes)
        because the portal customer only needs to see what's in each
        bundle, not the internal SKU shape."""

        combos = obj.packaging_combos.all().prefetch_related("items__item")
        return [
            {
                "id": str(c.id),
                "name": c.name,
                "price_delta": str(c.price_delta),
                "is_default": c.is_default,
                "items": [
                    (row.item.name if row.item_id else "")
                    for row in c.items.all()
                    if row.item_id
                ],
            }
            for c in combos
        ]


class PortalRTGCatalogView(PortalAPIView):
    """``GET /api/portal/rtg-catalog/``.

    Returns the customer's org's published Ready-to-Go SKUs — the
    grid the customer picks from on ``/portal/cffs/new/rtg``. Only
    ``is_rtg_published=True`` rows are visible; unpublished drafts
    stay hidden even if a customer pastes a UUID.
    """

    def get(self, request: Request) -> Response:
        from apps.formulations.models import Formulation, ProjectType

        client_account = request.user
        customer = getattr(client_account, "customer", None)
        if customer is None or customer.organization_id is None:
            return Response({"results": []})

        rows = list(
            Formulation.objects
            .filter(
                organization_id=customer.organization_id,
                is_rtg_published=True,
                project_type=ProjectType.READY_TO_GO,
            )
            .order_by("name")
        )
        return Response(
            {
                "results": PortalRTGCatalogItemSerializer(
                    rows, many=True,
                ).data,
            },
        )


class PortalRTGCreateSerializer(serializers.Serializer):
    """Wire-shape for the short RTG order form."""

    rtg_formulation_id = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)
    packaging = serializers.CharField(
        max_length=200, required=False, allow_blank=True,
    )
    packaging_combo_id = serializers.UUIDField(
        required=False, allow_null=True,
    )
    delivery_address = serializers.CharField(max_length=1000)
    target_ship_date = serializers.DateField(required=False, allow_null=True)
    notes = serializers.CharField(
        required=False, allow_blank=True, max_length=2000,
    )


class PortalRTGCreateView(PortalAPIView):
    """``POST /api/portal/cffs/new-rtg/``.

    Wraps :func:`create_portal_rtg_submission`. Returns the same
    ``PortalCFFDetail`` shape as the Custom-track submit so the FE
    reads both flows with one type. Validation failures return 422
    with ``{code, detail, fields}`` matching the Custom flow.
    """

    def post(self, request: Request) -> Response:
        payload = PortalRTGCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)

        typed = PortalRTGSubmissionInput(
            rtg_formulation_id=str(data["rtg_formulation_id"]),
            quantity=int(data["quantity"]),
            packaging=str(data.get("packaging") or ""),
            delivery_address=str(data["delivery_address"]),
            target_ship_date=(
                data["target_ship_date"].isoformat()
                if data.get("target_ship_date")
                else None
            ),
            notes=str(data.get("notes") or ""),
            packaging_combo_id=(
                str(data["packaging_combo_id"])
                if data.get("packaging_combo_id")
                else None
            ),
        )

        try:
            submission = create_portal_rtg_submission(
                client_account=request.user,
                payload=typed,
            )
        except CFFRTGSubmissionError as exc:
            code = getattr(exc, "code", "rtg_validation")
            field_errors = getattr(exc, "field_errors", None) or {}
            http_status = 404 if code == "rtg_sku_not_found" else 422
            body = {"code": code, "detail": str(exc)}
            if field_errors:
                body["fields"] = field_errors
            return Response(body, status=http_status)

        return Response(
            PortalCFFDetailSerializer(submission).data,
            status=status.HTTP_201_CREATED,
        )


class PortalCFFMessagesReadView(PortalAPIView):
    """``POST /api/portal/cffs/<id>/messages/read/`` — bump the
    customer's last-read pointer for this thread."""

    def post(self, request: Request, submission_id: str) -> Response:
        from apps.cff_submissions.models import CFFSubmission

        submission = _load_owned_cff(request, submission_id)
        cff_ct = ContentType.objects.get_for_model(CFFSubmission)
        CommentReadState.objects.update_or_create(
            viewer_client=request.user,
            content_type=cff_ct,
            object_id=submission.id,
            defaults={
                "organization_id": submission.organization_id,
                "last_read_at": timezone.now(),
            },
        )
        return Response({"detail": "ok"})


# ---------------------------------------------------------------------------
# Reorder — customer re-buys a signed Custom formulation.
# ---------------------------------------------------------------------------


class PortalReorderableFormulationSerializer(serializers.Serializer):
    """Wire shape for one row on the Reorder picker.

    Slim: id + display name + code + signed_at + last-paid hints so
    the customer sees "last time you ordered N units at £X each"
    before they commit. The heavy detail (packaging, recipe) lives
    on the detail endpoint the confirm-step calls after the pick.
    """

    id = serializers.UUIDField(read_only=True)
    display_name = serializers.SerializerMethodField()
    code = serializers.CharField(read_only=True)
    dosage_form = serializers.CharField(read_only=True)
    servings_per_pack = serializers.IntegerField(read_only=True)
    last_signed_at = serializers.SerializerMethodField()
    last_unit_price = serializers.SerializerMethodField()
    last_currency = serializers.SerializerMethodField()
    last_quantity = serializers.SerializerMethodField()

    def _last_order(self, obj):
        """Cache the ``_find_source_last_order`` result per instance
        so the three ``last_*`` methods share one lookup instead of
        firing three copies of the same query per row.
        """

        cache_attr = "_reorderable_last_order_cache"
        cached = getattr(obj, cache_attr, None)
        if cached is not None:
            return cached
        from apps.cff_submissions.services import _find_source_last_order

        result = _find_source_last_order(obj)
        try:
            setattr(obj, cache_attr, result)
        except Exception:  # pragma: no cover - defensive on frozen models
            pass
        return result

    def get_display_name(self, obj) -> str:
        from apps.client_portal.queries import formulation_display_name

        return formulation_display_name(obj)

    def get_last_signed_at(self, obj) -> str | None:
        from apps.cff_submissions.services import _find_source_signed_spec

        spec = _find_source_signed_spec(obj)
        if spec is None or spec.customer_signed_at is None:
            return None
        return spec.customer_signed_at.isoformat()

    def get_last_unit_price(self, obj) -> str | None:
        price, _currency, _quantity = self._last_order(obj)
        return str(price) if price is not None else None

    def get_last_currency(self, obj) -> str | None:
        _price, currency, _quantity = self._last_order(obj)
        return currency

    def get_last_quantity(self, obj) -> int | None:
        _price, _currency, quantity = self._last_order(obj)
        return int(quantity) if quantity is not None else None


class PortalReorderableListView(PortalAPIView):
    """``GET /api/portal/reorderable-formulations/``.

    Cursor-paginated list of the customer's own signed Custom
    formulations. Query params:

    * ``search`` — case-insensitive ILIKE on name + code.
    * ``cursor`` — opaque string returned in a prior page's
      ``next_cursor`` field. Missing / empty → first page.
    * ``limit`` — page size, clamped to 100 on the service side.

    Returns ``{results: [...], next_cursor: str | None}``. Never
    returns more than 100 rows in one call — the customer must
    filter or paginate to browse everything.
    """

    def get(self, request: Request) -> Response:
        customer = getattr(request.user, "customer", None)
        if customer is None or customer.organization_id is None:
            return Response({"results": [], "next_cursor": None})

        search = (request.query_params.get("search") or "").strip()
        cursor = (request.query_params.get("cursor") or "").strip()
        try:
            limit = int(request.query_params.get("limit") or 20)
        except (TypeError, ValueError):
            limit = 20

        page = list_reorderable_formulations_for_customer(
            customer=customer,
            search=search,
            cursor=cursor,
            limit=limit,
        )
        payload = {
            "results": PortalReorderableFormulationSerializer(
                page["results"], many=True
            ).data,
            "next_cursor": page["next_cursor"],
        }
        return Response(payload)


class PortalReorderCreateSerializer(serializers.Serializer):
    """Wire shape for POST /api/portal/reorder/new/."""

    source_formulation_id = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1)
    delivery_address = serializers.CharField(max_length=1000)
    target_ship_date = serializers.DateField(required=False, allow_null=True)
    notes = serializers.CharField(
        required=False, allow_blank=True, max_length=2000,
    )


class PortalReorderCreateView(PortalAPIView):
    """``POST /api/portal/reorder/new/``.

    Wraps :func:`create_portal_reorder_submission`. Returns the same
    ``PortalCFFDetail`` shape as the Custom + RTG tracks so the FE
    reads all three flows with one type. Validation failures return
    422 with ``{code, detail, fields}``; missing source formulation
    returns 404.
    """

    def post(self, request: Request) -> Response:
        payload = PortalReorderCreateSerializer(data=request.data)
        payload.is_valid(raise_exception=True)
        data = dict(payload.validated_data)

        typed = PortalReorderSubmissionInput(
            source_formulation_id=str(data["source_formulation_id"]),
            quantity=int(data["quantity"]),
            delivery_address=str(data["delivery_address"]),
            target_ship_date=(
                data["target_ship_date"].isoformat()
                if data.get("target_ship_date")
                else None
            ),
            notes=str(data.get("notes") or ""),
        )

        try:
            submission = create_portal_reorder_submission(
                client_account=request.user,
                payload=typed,
            )
        except CFFReorderSubmissionError as exc:
            code = getattr(exc, "code", "reorder_validation")
            field_errors = getattr(exc, "field_errors", None) or {}
            http_status = (
                404
                if code in {"reorder_source_not_found", "no_customer"}
                else 422
            )
            body = {"code": code, "detail": str(exc)}
            if field_errors:
                body["fields"] = field_errors
            return Response(body, status=http_status)

        return Response(
            PortalCFFDetailSerializer(submission).data,
            status=status.HTTP_201_CREATED,
        )
