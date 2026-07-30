"""Serializers for the proposals API."""

from __future__ import annotations

from rest_framework import serializers
from rest_framework.exceptions import ErrorDetail

from apps.proposals.models import (
    Proposal,
    ProposalLine,
    ProposalStatus,
    ProposalStatusTransition,
    ProposalTemplateType,
)


def _code(value: str) -> ErrorDetail:
    return ErrorDetail(value, code=value)


class ProposalLineReadSerializer(serializers.ModelSerializer):
    formulation_id = serializers.UUIDField(
        source="formulation_version.formulation_id",
        read_only=True,
        allow_null=True,
    )
    formulation_name = serializers.CharField(
        source="formulation_version.formulation.name",
        read_only=True,
        allow_null=True,
    )
    formulation_version_number = serializers.IntegerField(
        source="formulation_version.version_number",
        read_only=True,
        allow_null=True,
    )
    specification_sheet_id = serializers.UUIDField(
        read_only=True, allow_null=True
    )
    subtotal = serializers.SerializerMethodField()

    class Meta:
        model = ProposalLine
        fields = (
            "id",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "specification_sheet",
            "specification_sheet_id",
            "product_code",
            "description",
            "quantity",
            "unit_cost",
            "unit_price",
            "display_order",
            "subtotal",
        )
        read_only_fields = (
            "id",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "specification_sheet_id",
            "subtotal",
        )

    def get_subtotal(self, obj: ProposalLine) -> str | None:
        sub = obj.subtotal
        return None if sub is None else str(sub)


class ProposalReadSerializer(serializers.ModelSerializer):
    formulation_id = serializers.UUIDField(
        source="formulation_version.formulation_id", read_only=True
    )
    formulation_name = serializers.CharField(
        source="formulation_version.formulation.name", read_only=True
    )
    formulation_version_number = serializers.IntegerField(
        source="formulation_version.version_number", read_only=True
    )
    specification_sheet_id = serializers.UUIDField(read_only=True)
    customer_id = serializers.UUIDField(read_only=True)
    sales_person_id = serializers.UUIDField(read_only=True, allow_null=True)
    sales_person_name = serializers.SerializerMethodField()
    #: Effective sales person rendered on the proposal — proposal-
    #: level override when set, otherwise the linked project's owner.
    #: Lets the UI show "inherited from project" hints without a
    #: second round-trip to fetch the formulation.
    effective_sales_person_id = serializers.SerializerMethodField()
    effective_sales_person_name = serializers.SerializerMethodField()
    lines = ProposalLineReadSerializer(many=True, read_only=True)
    subtotal = serializers.SerializerMethodField()
    total_excl_vat = serializers.SerializerMethodField()
    #: Three signature slots render as structured payloads (name +
    #: signed_at + image) so the client doesn't have to hydrate two
    #: parallel fields per slot. ``null`` means "not signed yet" for
    #: any slot.
    prepared_by = serializers.SerializerMethodField()
    director = serializers.SerializerMethodField()
    customer_signature = serializers.SerializerMethodField()

    class Meta:
        model = Proposal
        fields = (
            "id",
            "code",
            "status",
            "template_type",
            "formulation_version",
            "formulation_id",
            "formulation_name",
            "formulation_version_number",
            "specification_sheet_id",
            "customer_id",
            "customer_name",
            "customer_email",
            "customer_phone",
            "customer_company",
            "invoice_address",
            "delivery_address",
            "dear_name",
            "reference",
            "sales_person_id",
            "sales_person_name",
            "effective_sales_person_id",
            "effective_sales_person_name",
            "currency",
            "quantity",
            "unit_price",
            "freight_amount",
            "material_cost_per_pack",
            "margin_percent",
            "deposit_percent",
            "lines",
            "subtotal",
            "total_excl_vat",
            "cover_notes",
            "valid_until",
            "public_token",
            "prepared_by_signed_at",
            "director_signed_at",
            "prepared_by",
            "director",
            "customer_signature",
            "customer_signer_name",
            "customer_signer_email",
            "customer_signer_company",
            "customer_signed_at",
            "customer_rejected_at",
            "customer_rejection_reason",
            "created_at",
            "updated_at",
        )
        read_only_fields = fields

    def _user_label(self, user) -> str:
        if user is None:
            return ""
        return (user.get_full_name() or user.email or "").strip()

    def get_prepared_by(self, obj: Proposal) -> dict | None:
        if obj.prepared_by_signed_at is None:
            return None
        return {
            "name": self._user_label(obj.prepared_by_user),
            "signed_at": obj.prepared_by_signed_at.isoformat(),
            "image": obj.prepared_by_signature_image or "",
        }

    def get_director(self, obj: Proposal) -> dict | None:
        if obj.director_signed_at is None:
            return None
        return {
            "name": self._user_label(obj.director_user),
            "signed_at": obj.director_signed_at.isoformat(),
            "image": obj.director_signature_image or "",
        }

    def get_customer_signature(self, obj: Proposal) -> dict | None:
        if obj.customer_signed_at is None:
            return None
        return {
            "name": obj.customer_signer_name or "",
            "email": obj.customer_signer_email or "",
            "company": obj.customer_signer_company or "",
            "signed_at": obj.customer_signed_at.isoformat(),
            "image": obj.customer_signature_image or "",
        }

    def get_sales_person_name(self, obj: Proposal) -> str:
        user = obj.sales_person
        if user is None:
            return ""
        return (user.get_full_name() or user.email or "").strip()

    def _effective_user(self, obj: Proposal):
        if obj.sales_person_id:
            return obj.sales_person
        formulation = getattr(obj.formulation_version, "formulation", None)
        return getattr(formulation, "sales_person", None)

    def get_effective_sales_person_id(self, obj: Proposal) -> str | None:
        user = self._effective_user(obj)
        return None if user is None else str(user.id)

    def get_effective_sales_person_name(self, obj: Proposal) -> str:
        user = self._effective_user(obj)
        if user is None:
            return ""
        return (user.get_full_name() or user.email or "").strip()

    def get_subtotal(self, obj: Proposal) -> str | None:
        sub = obj.subtotal
        return None if sub is None else str(sub)

    def get_total_excl_vat(self, obj: Proposal) -> str | None:
        total = obj.total_excl_vat
        return None if total is None else str(total)


class ProposalListSerializer(ProposalReadSerializer):
    """List-endpoint variant: strips the three signature-image blobs
    AND drops the nested ``lines`` array.

    Wire-size optimisations applied here vs. the detail serializer:

    * ``prepared_by`` / ``director`` / ``customer_signature`` keep
      their name + timestamp keys (the list shows "Signed on X" pills)
      but the base64 PNG ``image`` payload is blanked — on a 50-row
      page that alone is ~1 MB of bytes the list never renders.
    * ``lines`` (full :class:`ProposalLineReadSerializer` per row,
      including the line's formulation chain) is removed and
      replaced with a scalar ``lines_count``. The list UI only ever
      reads ``proposal.lines.length`` to render the "N products"
      badge — shipping the array is wasted payload + the entry point
      for an N+1 follow-up per line. ``len(obj.lines.all())`` reads
      from the prefetched cache populated by
      :func:`apps.proposals.services.list_proposals` so no extra
      query fires per row.

    Totals (``subtotal`` / ``total_excl_vat``) still iterate the
    prefetched lines cache server-side, so the badge stays accurate
    without the client receiving the line objects themselves.
    Detail endpoints continue to use the full
    :class:`ProposalReadSerializer` so the signature pad, audit
    panel, and lines table all see everything.
    """

    lines_count = serializers.IntegerField(read_only=True)

    class Meta(ProposalReadSerializer.Meta):
        # Inherit the parent's field list verbatim except drop the
        # nested ``lines`` array; add the cheap ``lines_count``
        # replacement at the same position so the wire shape stays
        # stable for clients that introspect key order.
        fields = tuple(
            f if f != "lines" else "lines_count"
            for f in ProposalReadSerializer.Meta.fields
        )
        read_only_fields = fields

    def get_prepared_by(self, obj: Proposal) -> dict | None:
        signed = super().get_prepared_by(obj)
        return None if signed is None else {**signed, "image": ""}

    def get_director(self, obj: Proposal) -> dict | None:
        signed = super().get_director(obj)
        return None if signed is None else {**signed, "image": ""}

    def get_customer_signature(self, obj: Proposal) -> dict | None:
        signed = super().get_customer_signature(obj)
        return None if signed is None else {**signed, "image": ""}

    def to_representation(self, instance: Proposal) -> dict:
        # ``lines_count`` is a declared scalar field, so DRF expects
        # to read ``instance.lines_count`` — which doesn't exist as a
        # model attribute. Inject it from the prefetched ``lines``
        # cache (populated upstream by ``list_proposals``) before
        # serialisation. ``len(.all())`` walks the cached list when
        # prefetch_related is active; no extra query.
        instance.lines_count = len(instance.lines.all())  # type: ignore[attr-defined]
        return super().to_representation(instance)


class ProposalCreateSerializer(serializers.Serializer):
    formulation_version_id = serializers.UUIDField()
    specification_sheet_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    customer_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    template_type = serializers.ChoiceField(
        choices=ProposalTemplateType.choices, required=False, allow_null=True
    )
    code = serializers.CharField(
        max_length=64, required=False, allow_blank=True, default=""
    )
    customer_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    customer_email = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    customer_phone = serializers.CharField(
        max_length=60, required=False, allow_blank=True, default=""
    )
    customer_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    invoice_address = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    delivery_address = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    dear_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    reference = serializers.CharField(
        max_length=120, required=False, allow_blank=True, default=""
    )
    currency = serializers.CharField(
        max_length=3, required=False, default="GBP"
    )
    quantity = serializers.IntegerField(min_value=1, required=False, default=1)
    unit_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    freight_amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, allow_null=True
    )
    margin_percent = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False, allow_null=True
    )
    #: Deposit % printed in the Custom-template deposit clause.
    #: Optional on the wire — the service layer defaults to 50 when
    #: the caller omits it, matching the model default.
    deposit_percent = serializers.DecimalField(
        max_digits=5,
        decimal_places=2,
        required=False,
        allow_null=True,
        min_value=0,
        max_value=100,
    )
    #: Scientist-entered cost per pack (what it costs *us* to
    #: manufacture one). Overrides the automatic
    #: ``compute_material_cost_per_pack`` roll-up so overheads /
    #: labour / packaging costs not in the raw-material catalogue can
    #: be rolled into the number sales see.
    material_cost_per_pack = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    cover_notes = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    valid_until = serializers.DateField(required=False, allow_null=True)


class ProposalBundleEntrySerializer(serializers.Serializer):
    """One row of the ``/proposals/bundle/`` request array."""

    sheet_id = serializers.UUIDField()
    quantity = serializers.IntegerField(min_value=1, required=False, default=1)


class ProposalBundleCreateSerializer(serializers.Serializer):
    """Payload for creating one proposal from N approved specs.

    The /signed page's bulk-select flow posts this — every entry is a
    ``{sheet_id, quantity}`` picked by the sales operator. Same-customer
    invariant is enforced by the service layer so a hand-rolled request
    can't bypass the FE picker's guard.
    """

    sheets = ProposalBundleEntrySerializer(many=True, allow_empty=False)
    deposit_percent = serializers.DecimalField(
        max_digits=5,
        decimal_places=2,
        required=False,
        allow_null=True,
        min_value=0,
        max_value=100,
    )


class ProposalUpdateSerializer(serializers.Serializer):
    specification_sheet_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    customer_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    sales_person_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    template_type = serializers.ChoiceField(
        choices=ProposalTemplateType.choices, required=False
    )
    customer_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    customer_email = serializers.CharField(required=False, allow_blank=True)
    customer_phone = serializers.CharField(
        max_length=60, required=False, allow_blank=True
    )
    customer_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    invoice_address = serializers.CharField(required=False, allow_blank=True)
    delivery_address = serializers.CharField(required=False, allow_blank=True)
    dear_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True
    )
    reference = serializers.CharField(
        max_length=120, required=False, allow_blank=True
    )
    currency = serializers.CharField(max_length=3, required=False)
    quantity = serializers.IntegerField(min_value=1, required=False)
    unit_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    freight_amount = serializers.DecimalField(
        max_digits=12, decimal_places=2, required=False, allow_null=True
    )
    margin_percent = serializers.DecimalField(
        max_digits=6, decimal_places=2, required=False, allow_null=True
    )
    deposit_percent = serializers.DecimalField(
        max_digits=5,
        decimal_places=2,
        required=False,
        allow_null=True,
        min_value=0,
        max_value=100,
    )
    material_cost_per_pack = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    cover_notes = serializers.CharField(required=False, allow_blank=True)
    valid_until = serializers.DateField(required=False, allow_null=True)


class ProposalLineWriteSerializer(serializers.Serializer):
    """Shape accepted for ``POST`` / ``PATCH`` on a proposal line.

    ``formulation_version_id`` is optional — ad-hoc lines (e.g. a
    courier charge) can exist without a pinned formulation. When set,
    the service layer resolves the version + cross-checks it belongs
    to the proposal's organization.
    """

    formulation_version_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    specification_sheet_id = serializers.UUIDField(
        required=False, allow_null=True
    )
    product_code = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    description = serializers.CharField(
        max_length=500, required=False, allow_blank=True, default=""
    )
    quantity = serializers.IntegerField(
        min_value=1, required=False, default=1
    )
    unit_cost = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    unit_price = serializers.DecimalField(
        max_digits=12, decimal_places=4, required=False, allow_null=True
    )
    display_order = serializers.IntegerField(
        min_value=0, required=False
    )


class ProposalStatusSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=ProposalStatus.choices)
    signature_image = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    notes = serializers.CharField(required=False, allow_blank=True, default="")
    customer_name = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )
    customer_email = serializers.CharField(
        required=False, allow_blank=True, default=""
    )
    customer_company = serializers.CharField(
        max_length=200, required=False, allow_blank=True, default=""
    )


class ProposalTransitionSerializer(serializers.ModelSerializer):
    actor_name = serializers.SerializerMethodField()

    class Meta:
        model = ProposalStatusTransition
        fields = (
            "id",
            "from_status",
            "to_status",
            "actor",
            "actor_name",
            "notes",
            "created_at",
        )
        read_only_fields = fields

    def get_actor_name(self, obj: ProposalStatusTransition) -> str:
        user = obj.actor
        return (user.get_full_name() or user.email or "").strip()
