"""Serializers for the specifications API."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.specifications.models import (
    SpecificationDocumentKind,
    SpecificationSheet,
    SpecificationStatus,
)
from apps.specifications.services import resolve_linked_proposal


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


def _packaging_summary(item) -> dict | None:
    """Shape a selected packaging ``Item`` into the compact display
    payload the frontend picker reads — ``None`` when the slot is
    empty. Keeping this alongside the serializer (rather than on the
    model) keeps the model free of DRF-shaped render logic."""

    if item is None:
        return None
    return {
        "id": str(item.id),
        "name": item.name,
        "internal_code": item.internal_code,
    }


class SpecificationSheetReadSerializer(serializers.ModelSerializer):
    formulation_id = serializers.UUIDField(
        source="formulation_version.formulation_id", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation_version.formulation.name", read_only=True
    )
    #: The project's own code (e.g. "MA210367"). Surfaced on the
    #: spec payload so the MRPEasy price-hint component can look
    #: up the suggested price by part number without a second
    #: round-trip to the formulations endpoint — the spec view
    #: already has every other display field for the project.
    formulation_code = serializers.CharField(
        source="formulation_version.formulation.code", read_only=True
    )
    #: Engagement model of the underlying formulation. Used by the
    #: proposal-line spec picker to decide whether to gate this sheet
    #: as "already in use" — Custom specs are one-per-proposal (each
    #: bespoke recipe belongs to a single deal), Ready-to-Go specs
    #: are evergreen and reusable across every customer and re-order.
    formulation_project_type = serializers.CharField(
        source="formulation_version.formulation.project_type", read_only=True
    )
    formulation_version_number = serializers.IntegerField(
        source="formulation_version.version_number", read_only=True
    )
    # Nested display metadata for the currently-selected packaging
    # items. Ships the code + name alongside the raw FK UUID so the
    # picker can render the preselected label without a second
    # round-trip, even when the item is outside the search page the
    # ComboBox most recently loaded.
    packaging_details = serializers.SerializerMethodField()
    #: Compact summary of the proposal linked to this sheet (via the
    #: ``Proposal.specification_sheet`` OneToOne) or ``None`` when no
    #: proposal exists yet. Drives the "has a proposal been created?"
    #: chip on the customer-pipeline surfaces so commercial roles
    #: don't accidentally double-quote a sheet that's already been
    #: quoted. ``list_sheets`` prefetches the relation so this stays
    #: O(1) per row regardless of page size.
    linked_proposal = serializers.SerializerMethodField()
    #: Compact pointer to a *sibling* sheet that's already sitting in
    #: ``in_review`` on the same formulation + document_kind, or
    #: ``None`` when the review slot for this kind is free. Drives
    #: the disabled state of the "Send for review" action on the spec
    #: sheet detail page: the backend refuses the transition (see
    #: :class:`SpecificationReviewSlotTaken`) and this field tells
    #: the UI which sibling is occupying the slot so the tooltip can
    #: link out instead of just disabling silently. Empty for sheets
    #: that are already in_review (a sheet doesn't block itself).
    review_slot_blocker = serializers.SerializerMethodField()
    #: Compact projection of the *formulation's* linked customer (via
    #: ``Formulation.customer``), populated the moment sales attaches
    #: a client on the project workspace. ``None`` when no customer is
    #: linked — different from spec's own ``client_name`` / ``client_company``
    #: (which live on the sheet and get typed by the scientist during
    #: draft) and from ``customer_name`` / ``customer_company`` (which
    #: are the kiosk-signer identity captured at accept time). All three
    #: coexist because they answer different questions; the /signed
    #: page prefers this one as the freshest / most authoritative
    #: display since the project link is the single source of truth
    #: sales / R&D both edit against.
    linked_customer = serializers.SerializerMethodField()
    linked_cff_quote_context = serializers.SerializerMethodField()
    #: True when the sheet's formulation is Ready-to-Go AND has one or
    #: more :class:`PackagingCombo` rows configured. Signals to the FE
    #: that the four ``packaging_*`` FK slots are intentionally empty
    #: (customers pick their combo per order at checkout) so the
    #: packaging section should render a placeholder rather than
    #: four "—" rows. Falls out of the picker guard on the staff
    #: workspace too — the packaging picker is hidden when this is
    #: true because there's nothing meaningful for a scientist to
    #: pin on the canonical sheet.
    packaging_customer_choice = serializers.SerializerMethodField()

    def get_packaging_customer_choice(self, obj) -> bool:
        formulation = obj.formulation_version.formulation
        if getattr(formulation, "project_type", "") != "ready_to_go":
            return False
        if not formulation.packaging_combos.exists():
            return False
        # A per-order clone gets its packaging FKs stamped by the
        # storefront checkout (see checkout_services). Once any slot
        # is populated the placeholder gives way to the concrete
        # packaging table on this specific sheet. Template RTG sheets
        # keep all four slots blank and still render the placeholder.
        return (
            obj.packaging_lid_id is None
            and obj.packaging_container_id is None
            and obj.packaging_label_id is None
            and obj.packaging_antitemper_id is None
        )

    def get_packaging_details(self, obj) -> dict:
        return {
            "lid": _packaging_summary(obj.packaging_lid),
            "container": _packaging_summary(obj.packaging_container),
            "label": _packaging_summary(obj.packaging_label),
            "antitemper": _packaging_summary(obj.packaging_antitemper),
        }

    def get_linked_proposal(self, obj) -> dict | None:
        # Routed through ``resolve_linked_proposal`` so the Signed
        # tab, the kiosk ``has_proposal`` flag, and the public
        # proposal iframe all agree on what counts as "this spec
        # has a proposal attached". The helper handles both the
        # legacy OneToOne FK and the per-line attachment used by
        # multi-spec proposals.
        proposal = resolve_linked_proposal(obj)
        if proposal is None:
            return None
        return {
            "id": str(proposal.id),
            "code": proposal.code,
            "status": proposal.status,
            # ``customer_signed_at`` lets the FE regenerate modal
            # distinguish "sent (customer has document, no signature
            # yet)" from "accepted / signed (immutable artefact)"
            # without a second round-trip. The regenerate BE gate
            # treats a signed proposal as a hard block regardless of
            # the ``status`` field so the FE mirrors that check.
            "customer_signed_at": (
                proposal.customer_signed_at.isoformat()
                if proposal.customer_signed_at is not None
                else None
            ),
        }

    def get_linked_customer(self, obj) -> dict | None:
        customer = getattr(
            obj.formulation_version.formulation, "customer", None
        )
        if customer is None:
            return None
        return {
            "id": str(customer.id),
            "name": (customer.name or "").strip(),
            "company": (customer.company or "").strip(),
            "email": (customer.email or "").strip(),
        }

    def get_linked_cff_quote_context(self, obj) -> dict | None:
        """Quick-reference "what did the customer originally ask for?"
        pulled from the earliest CFF submission that seeded this
        project. Consumed by the proposal-creation modal to prefill
        the quantity field so sales doesn't have to re-type a number
        the customer already gave us on their portal CFF submission.

        Walks:
          formulation → CFFProjectAssignment (m2m through) →
          submission.raw_payload["submissions"]["quantity_to_be_quoted"]

        Returns ``None`` when:
          * The project wasn't seeded from a CFF (staff-started
            direct on NPD) — no assignment row exists.
          * The CFF payload predates the quantity field (legacy Wix
            forms without the ``quantity_to_be_quoted`` slug).
          * The raw value doesn't parse as a positive integer
            (blank / range / non-numeric — the customer typed
            "TBC" or "10k-20k"). The modal falls back to its
            hardcoded "1" default in that case; better than
            prefilling something the operator has to correct.

        Takes the EARLIEST CFF (by ``wix_created_date`` then
        ``imported_at`` fallback) for multi-CFF projects — the first
        submission is the anchor request; later CFFs are usually
        merged-in duplicates or amendments the operator has already
        reconciled.
        """

        from apps.cff_submissions.models import CFFProjectAssignment

        assignment = (
            CFFProjectAssignment.objects.filter(
                project=obj.formulation_version.formulation
            )
            .select_related("submission")
            .order_by(
                # ``NULLS LAST`` isn't a Django-ORM keyword on every
                # backend; sort by (has-date, date) so real timestamps
                # win over legacy nulls without a backend-specific hack.
                "submission__wix_created_date",
                "submission__imported_at",
            )
            .first()
        )
        if assignment is None or assignment.submission is None:
            return None

        submissions = (
            assignment.submission.raw_payload.get("submissions")
            if isinstance(assignment.submission.raw_payload, dict)
            else None
        )
        if not isinstance(submissions, dict):
            return None

        raw = submissions.get("quantity_to_be_quoted")
        if raw in (None, ""):
            return None

        # Defensive parse — CFF ships this as a string ("10000"), but
        # legacy Wix payloads have shipped raw ints too. Ranges /
        # non-numeric text ("TBC", "10k") fall through to None so the
        # modal doesn't prefill garbage.
        try:
            requested = int(str(raw).strip().replace(",", ""))
        except (TypeError, ValueError):
            return None
        if requested <= 0:
            return None

        submitted_at = (
            assignment.submission.wix_created_date
            or assignment.submission.imported_at
        )
        return {
            "requested_quantity": requested,
            "submitted_at": (
                submitted_at.isoformat() if submitted_at else None
            ),
            "source_kind": "cff_portal",
        }

    def get_review_slot_blocker(self, obj) -> dict | None:
        # A sheet already in_review never blocks itself, so the gate
        # only matters for sheets sitting outside the review lane
        # that the scientist might want to push into it.
        if obj.status == SpecificationStatus.IN_REVIEW.value:
            return None

        # Prefer the annotation installed by ``list_sheets`` — one
        # extra subplan per page instead of one query per row.
        # Falls back to an explicit ``filter().first()`` only on
        # detail-path serializations where no list query ran (e.g.
        # a fresh ``get_sheet`` fetch); the per-row cost is moot
        # there because we only serialize a single object.
        annotated_id = getattr(obj, "_review_blocker_id", None)
        annotated_code = getattr(obj, "_review_blocker_code", None)
        if annotated_id is not None:
            return {"id": str(annotated_id), "code": annotated_code or ""}
        # If the annotation was applied (list path) but matched no
        # sibling, ``_review_blocker_id`` is ``None`` even though
        # the attribute exists. Distinguish that from "no annotation
        # at all" by checking ``hasattr``: present-but-null means
        # the list query already determined there is no blocker.
        if hasattr(obj, "_review_blocker_id"):
            return None
        blocker = (
            SpecificationSheet.objects.filter(
                formulation_version__formulation_id=obj.formulation_version.formulation_id,
                document_kind=obj.document_kind,
                status=SpecificationStatus.IN_REVIEW,
            )
            .exclude(pk=obj.pk)
            .only("id", "code")
            .first()
        )
        if blocker is None:
            return None
        return {"id": str(blocker.id), "code": blocker.code}

    class Meta:
        model = SpecificationSheet
        fields = (
            "id",
            "code",
            "client_name",
            "client_email",
            "client_company",
            "unit_cost",
            "margin_percent",
            "final_price",
            "quantity",
            "currency",
            "cover_notes",
            "total_weight_label",
            "unit_quantity",
            "food_contact_status",
            "shelf_life",
            "storage_conditions",
            "weight_uniformity",
            "public_token",
            "prepared_by_signed_at",
            "prepared_by_signature_image",
            "director_signed_at",
            "director_signature_image",
            "customer_name",
            "customer_email",
            "customer_company",
            "customer_signed_at",
            "customer_signature_image",
            "customer_rejected_at",
            "customer_rejection_reason",
            "sent_at",
            "sent_delivery_method",
            "sent_recipient",
            "packaging_lid",
            "packaging_container",
            "packaging_label",
            "packaging_antitemper",
            "packaging_details",
            "packaging_customer_choice",
            "status",
            "document_kind",
            "snapshot_overrides",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_code",
            "formulation_project_type",
            "formulation_version_number",
            "linked_proposal",
            "linked_customer",
            "linked_cff_quote_context",
            "review_slot_blocker",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields


class SpecificationSheetListSerializer(SpecificationSheetReadSerializer):
    """List-endpoint variant that drops the three signature-image
    blobs.

    Signatures are base64-encoded PNGs stored on the row — typically
    8-12 KB each. Returning them on every list paint adds ~30 KB per
    row × 50 rows = 1.5 MB of wire payload per page just for images
    the list UI doesn't render. Detail endpoints still use the full
    read serializer so the audit panel, the print view, and the
    proposal-detail-bundled-spec inline render see the full picture.
    """

    class Meta(SpecificationSheetReadSerializer.Meta):
        # Same fields tuple minus the three signature image columns
        # — built off the base ``Meta.fields`` so a future field
        # added to the read serializer flows through automatically.
        fields = tuple(
            f
            for f in SpecificationSheetReadSerializer.Meta.fields
            if f
            not in {
                "prepared_by_signature_image",
                "director_signature_image",
                "customer_signature_image",
            }
        )
        read_only_fields = fields


class SpecificationSheetCreateSerializer(serializers.Serializer):
    formulation_version_id = serializers.UUIDField()
    code = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )
    client_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    client_email = serializers.EmailField(
        required=False, allow_blank=True, default=""
    )
    client_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    unit_cost = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    margin_percent = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False, allow_null=True
    )
    final_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    quantity = serializers.IntegerField(
        required=False, min_value=1
    )
    currency = serializers.CharField(
        max_length=3, required=False, allow_blank=True
    )
    cover_notes = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    total_weight_label = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )
    document_kind = serializers.ChoiceField(
        choices=SpecificationDocumentKind.choices,
        required=False,
        default=SpecificationDocumentKind.DRAFT.value,
    )


class SpecificationSheetUpdateSerializer(serializers.Serializer):
    code = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    client_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    client_email = serializers.EmailField(required=False, allow_blank=True)
    client_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    unit_cost = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    margin_percent = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False, allow_null=True
    )
    final_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    quantity = serializers.IntegerField(required=False, min_value=1)
    currency = serializers.CharField(
        max_length=3, required=False, allow_blank=True
    )
    cover_notes = serializers.CharField(required=False, allow_blank=True)
    total_weight_label = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    unit_quantity = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    food_contact_status = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    shelf_life = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    storage_conditions = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    weight_uniformity = serializers.CharField(
        max_length=64, required=False, allow_blank=True
    )
    # Per-sheet ``{slug: value}`` override for the microbial / heavy
    # metal block. Free-form strings — the UI surfaces a form so the
    # admin does not have to memorise slug names; this field just
    # enforces shape.
    limits_override = serializers.DictField(
        child=serializers.CharField(
            max_length=120, allow_blank=True, trim_whitespace=False
        ),
        required=False,
    )
    # Phase G5a — last-mile spec-sheet edits. Free-form nested
    # JSON validated by the service layer
    # (:func:`_validate_snapshot_overrides`) so the API surface stays
    # forward-compatible with new override sections without touching
    # this serializer. Pass ``{}`` to clear all overrides; a partial
    # dict replaces the override map verbatim.
    snapshot_overrides = serializers.JSONField(
        required=False,
        allow_null=True,
        help_text=(
            "Per-section overrides applied at render time. Keys: "
            "formulation, declaration, allergens, compliance, "
            "actives. See the Specification model for the schema."
        ),
    )
    document_kind = serializers.ChoiceField(
        choices=SpecificationDocumentKind.choices, required=False
    )


class SpecificationStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=SpecificationStatus.choices)
    notes = serializers.CharField(
        required=False, allow_blank=True, default="", max_length=2000
    )
    # Required on transitions that produce a sign-off
    # (``draft → in_review`` captures the prepared-by signature,
    # ``in_review → approved`` captures the director's). The service
    # decides per-transition whether it's mandatory, so we accept it
    # as optional at the serializer layer and let the service raise
    # ``SignatureRequired`` when missing.
    signature_image = serializers.CharField(
        required=False,
        allow_blank=True,
        trim_whitespace=False,
    )
    # Optional pricing block — used by the director-approval flow so
    # the price can be set or confirmed *as part of* the signing
    # transaction. Once the status flips to ``approved`` the price
    # freezes; bundling it into the transition payload means the
    # director never has to "edit details, save, then sign" — one
    # modal, one click. Ignored for any other transition.
    unit_cost = serializers.DecimalField(
        max_digits=12,
        decimal_places=4,
        required=False,
        allow_null=True,
    )
    margin_percent = serializers.DecimalField(
        max_digits=6,
        decimal_places=2,
        required=False,
        allow_null=True,
    )
    final_price = serializers.DecimalField(
        max_digits=12,
        decimal_places=4,
        required=False,
        allow_null=True,
    )
    quantity = serializers.IntegerField(required=False, min_value=1)
    currency = serializers.CharField(
        max_length=3, required=False, allow_blank=True
    )
    # Delivery capture — required only when ``status == "sent"``. The
    # service does the per-transition validation so this stays
    # optional at the serializer layer, letting one shape cover every
    # transition button. The FE Send modal always populates both;
    # transitions to other statuses ignore them.
    delivery_method = serializers.ChoiceField(
        choices=(
            ("public_link", "Public preview link"),
            ("email", "Email"),
            ("other", "Other"),
        ),
        required=False,
        allow_blank=True,
    )
    delivery_recipient = serializers.CharField(
        max_length=200,
        required=False,
        allow_blank=True,
    )


class SpecificationCustomerAcceptSerializer(serializers.Serializer):
    """Payload the public / kiosk endpoint accepts when a visitor
    signs off on a ``sent`` sheet. Identity fields mirror the kiosk
    session shape (name + email + company label) — the backend
    cross-checks them against the active session cookie, so clients
    cannot forge an acceptance from someone else's name."""

    name = serializers.CharField(max_length=200)
    email = serializers.EmailField(required=False, allow_blank=True, default="")
    company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    signature_image = serializers.CharField(trim_whitespace=False)


class SpecificationPackagingSerializer(serializers.Serializer):
    """Payload for partial updates of the four packaging FK slots.

    Every field is optional — the caller can update one slot and leave
    the others untouched. Passing ``null`` clears the slot. The UUIDs
    are validated downstream in the service against the org packaging
    catalogue + ``packaging_type`` attribute, so this serializer only
    enforces shape.
    """

    packaging_lid = serializers.UUIDField(required=False, allow_null=True)
    packaging_container = serializers.UUIDField(
        required=False, allow_null=True
    )
    packaging_label = serializers.UUIDField(required=False, allow_null=True)
    packaging_antitemper = serializers.UUIDField(
        required=False, allow_null=True
    )
