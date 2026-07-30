"""Views for the formulations API."""

from __future__ import annotations

import logging
from dataclasses import asdict
from decimal import Decimal
from typing import Any

from django.db.models import ProtectedError

logger = logging.getLogger(__name__)
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.pagination import FormulationCursorPagination
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.api.rtg_permissions import HasRTGCatalogPermission
from apps.formulations.api.serializers import (
    FormulationLineWriteSerializer,
    FormulationReadSerializer,
    FormulationVersionReadSerializer,
    FormulationWriteSerializer,
    ReplaceLinesSerializer,
    RollbackVersionSerializer,
    SetApprovedVersionSerializer,
    SaveVersionSerializer,
    WizardRoutingSerializer,
)
from apps.formulations.overview import compute_project_overview
from apps.formulations.services import (
    CloneTargetIsSource,
    CloneTargetNotFound,
    CloneTargetRequired,
    FormulationCodeConflict,
    FormulationCodeRequired,
    FormulationNotFound,
    FormulationRTGError,
    FormulationVersionNotFound,
    InvalidAcidityItem,
    InvalidCapsuleSize,
    InvalidAntiCakingItem,
    InvalidCloneMode,
    InvalidDcpCarrierItem,
    InvalidPowderCarrierItem,
    InvalidDosageForm,
    InvalidColourItem,
    InvalidExcipientOverrides,
    InvalidFlavouringItem,
    InvalidGellingItem,
    InvalidGlazingItem,
    InvalidGummyBaseItem,
    InvalidCapsuleShellItem,
    InvalidMccCarrierItem,
    InvalidPowderType,
    InvalidPremixSweetenerItem,
    InvalidSweetenerItem,
    InvalidTabletSize,
    LeadScientistNotMember,
    ProjectTypeLocked,
    RawMaterialNotInOrg,
    SalesPersonNotMember,
    assign_lead_scientist,
    assign_sales_person,
    clone_formulation,
    compute_formulation_totals,
    create_formulation,
    get_formulation,
    list_formulations,
    list_versions,
    set_formulation_stages,
    publish_to_rtg_catalog,
    replace_lines,
    rollback_to_version,
    save_version,
    save_wizard_routing,
    set_approved_version,
    unpublish_from_rtg_catalog,
    update_formulation,
)
from apps.organizations.modules import (
    FormulationsCapability,
    RTGCatalogCapability,
)


def _totals_payload(totals) -> dict[str, Any]:
    def _as_str(value: Decimal | None) -> str | None:
        return None if value is None else str(value)

    excipients_payload = None
    if totals.excipients is not None:
        excipients_payload = {
            "mg_stearate_mg": _as_str(totals.excipients.mg_stearate_mg),
            "silica_mg": _as_str(totals.excipients.silica_mg),
            "mcc_mg": _as_str(totals.excipients.mcc_mg),
            "dcp_mg": _as_str(totals.excipients.dcp_mg),
            "rows": [
                {
                    "slug": row.slug,
                    "label": row.label,
                    "mg": _as_str(row.mg),
                    "is_remainder": row.is_remainder,
                    "concentration_mg_per_g_powder": _as_str(
                        row.concentration_mg_per_g_powder
                    ),
                    "use_as": row.use_as or "",
                    "is_allergen": bool(row.is_allergen),
                    "allergen_source": row.allergen_source or "",
                }
                for row in totals.excipients.rows
            ],
        }

    return {
        "total_active_mg": _as_str(totals.total_active_mg),
        "dosage_form": totals.dosage_form,
        "size_key": totals.size_key,
        "size_label": totals.size_label,
        "max_weight_mg": _as_str(totals.max_weight_mg),
        "total_weight_mg": _as_str(totals.total_weight_mg),
        "excipients": excipients_payload,
        "viability": {
            "fits": totals.viability.fits,
            "comfort_ok": totals.viability.comfort_ok,
            "codes": list(totals.viability.codes),
        },
        "warnings": list(totals.warnings),
        "line_values": {
            external_id: str(value)
            for external_id, value in totals.line_values.items()
        },
    }


class FormulationListCreateView(APIView):
    """``GET`` / ``POST`` ``/api/organizations/<org>/formulations/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        search = request.query_params.get("search")
        # ``has_open_proposal`` is tri-state: absent (no filter),
        # ``true`` (only formulations with open proposals), or
        # ``false`` (only formulations free of open proposals — used
        # by the new-proposal modal so the picker pages stay full of
        # eligible projects). Anything else is coerced to ``None``
        # rather than a 400 so a typo in a manual query param falls
        # back to the unfiltered list instead of failing the request.
        raw_has_open = request.query_params.get("has_open_proposal")
        if raw_has_open is None:
            has_open_proposal: bool | None = None
        else:
            lowered = raw_has_open.strip().lower()
            if lowered in {"true", "1", "yes"}:
                has_open_proposal = True
            elif lowered in {"false", "0", "no"}:
                has_open_proposal = False
            else:
                has_open_proposal = None
        # ``status`` arrives as ``?status=a&status=b`` (repeated key).
        # ``getlist`` returns ``[]`` when absent, which we treat as "no
        # status filter" via the truthy check in the service. Trim +
        # de-dupe happens server-side too, so a stale client repeating
        # the same value doesn't bloat the IN clause.
        statuses = request.query_params.getlist("status") or None
        sales_person_id = request.query_params.get("sales_person_id")
        project_type = request.query_params.get("project_type")
        queryset = list_formulations(
            organization=self.organization,
            search=search,
            has_open_proposal=has_open_proposal,
            statuses=statuses,
            sales_person_id=sales_person_id,
            project_type=project_type,
        )
        paginator = FormulationCursorPagination()
        page = paginator.paginate_queryset(queryset, request, view=self)
        serializer = FormulationReadSerializer(page, many=True)
        return paginator.get_paginated_response(serializer.data)

    def post(self, request: Request, org_id: str) -> Response:
        serializer = FormulationWriteSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            formulation = create_formulation(
                organization=self.organization,
                actor=request.user,
                name=data["name"],
                code=data["code"],
                description=data.get("description", ""),
                dosage_form=data.get("dosage_form", "capsule"),
                capsule_size=data.get("capsule_size", ""),
                tablet_size=data.get("tablet_size", ""),
                serving_size=data.get("serving_size", 1),
                servings_per_pack=data.get("servings_per_pack", 60),
                target_fill_weight_mg=data.get("target_fill_weight_mg"),
                powder_type=data.get("powder_type", "standard"),
                water_volume_ml=data.get("water_volume_ml"),
                directions_of_use=data.get("directions_of_use", ""),
                suggested_dosage=data.get("suggested_dosage", ""),
                appearance=data.get("appearance", ""),
                disintegration_spec=data.get("disintegration_spec", ""),
                # Passed through when the "New RTG" dialog on the RTG
                # catalog page seeds a formulation as ``ready_to_go``
                # from the start. Absent on the standard formulations
                # create form → defaults to ``custom``.
                project_type=data.get("project_type", "custom"),
                # PSP finished-product link — the picker at project
                # creation emits it. Optional; None when the picker
                # wasn't used or PSP isn't the active integration.
                psp_finished_product_uuid=data.get(
                    "psp_finished_product_uuid"
                ),
            )
        except FormulationCodeRequired:
            return Response(
                {"code": ["formulation_code_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FormulationCodeConflict:
            return Response(
                {"code": ["formulation_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidDosageForm:
            return Response(
                {"dosage_form": ["invalid_dosage_form"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidCapsuleSize:
            return Response(
                {"capsule_size": ["invalid_capsule_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidTabletSize:
            return Response(
                {"tablet_size": ["invalid_tablet_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidPowderType:
            return Response(
                {"powder_type": ["invalid_powder_type"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_201_CREATED,
        )


class FormulationDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE`` ``/.../formulations/<id>/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, formulation_id: str):
        try:
            return get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )

    def patch(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        serializer = FormulationWriteSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_formulation(
                formulation=formulation,
                actor=request.user,
                **serializer.validated_data,
            )
        except FormulationCodeConflict:
            return Response(
                {"code": ["formulation_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ProjectTypeLocked:
            return Response(
                {"project_type": ["project_type_locked"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidDosageForm:
            return Response(
                {"dosage_form": ["invalid_dosage_form"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidCapsuleSize:
            return Response(
                {"capsule_size": ["invalid_capsule_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidTabletSize:
            return Response(
                {"tablet_size": ["invalid_tablet_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidPowderType:
            return Response(
                {"powder_type": ["invalid_powder_type"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidGummyBaseItem:
            return Response(
                {"gummy_base_item_ids": ["invalid_gummy_base_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidFlavouringItem:
            return Response(
                {"flavouring_item_ids": ["invalid_flavouring_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidColourItem:
            return Response(
                {"colour_item_ids": ["invalid_colour_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidSweetenerItem:
            return Response(
                {"sweetener_item_ids": ["invalid_sweetener_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidGlazingItem:
            return Response(
                {"glazing_item_ids": ["invalid_glazing_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidGellingItem:
            return Response(
                {"gelling_item_ids": ["invalid_gelling_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidPremixSweetenerItem:
            return Response(
                {
                    "premix_sweetener_item_ids": [
                        "invalid_premix_sweetener_item"
                    ]
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidAcidityItem:
            return Response(
                {"acidity_item_ids": ["invalid_acidity_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidCapsuleShellItem:
            return Response(
                {"capsule_shell_item_ids": ["invalid_capsule_shell_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidMccCarrierItem:
            return Response(
                {"mcc_carrier_item_ids": ["invalid_mcc_carrier_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidDcpCarrierItem:
            return Response(
                {"dcp_carrier_item_ids": ["invalid_dcp_carrier_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidAntiCakingItem:
            return Response(
                {"anti_caking_item_ids": ["invalid_anti_caking_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidPowderCarrierItem:
            return Response(
                {"powder_carrier_item_ids": ["invalid_powder_carrier_item"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidExcipientOverrides:
            return Response(
                {"excipient_overrides": ["invalid_excipient_overrides"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            FormulationReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )

    def delete(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        from apps.audit.services import record as record_audit, snapshot

        formulation = self._load(formulation_id)
        # Snapshot + capture the pk BEFORE the cascade wipes them;
        # we still want a meaningful audit row after the row is
        # gone.
        before = snapshot(formulation)
        organization = formulation.organization
        target_id = str(formulation.pk)

        # Capture every PSP item this formulation owns so we can
        # clean them up after the local delete succeeds. Finished-
        # product item first (the project's identity on PSP), then
        # every stage's semi-finished. delete_psp_item is safety-
        # gated on the PSP side (refuses when the item is
        # referenced in another BOM, has stock/MO/PO history, or
        # its external_sku doesn't match the NPD-owned pattern) so
        # items shared with other work stay put.
        psp_uuids_to_reap: list[str] = []
        if formulation.psp_finished_product_uuid:
            psp_uuids_to_reap.append(str(formulation.psp_finished_product_uuid))
        for uuid in formulation.stages.filter(
            psp_semi_finished_uuid__isnull=False
        ).values_list("psp_semi_finished_uuid", flat=True):
            if uuid:
                psp_uuids_to_reap.append(str(uuid))

        try:
            formulation.delete()
        except ProtectedError:
            # A downstream ``PROTECT`` FK is blocking the cascade —
            # most commonly a :class:`TrialBatch` still pointing at
            # one of this project's :class:`FormulationVersion`s,
            # since batches are production records we refuse to lose
            # silently. Surface a translatable code so the frontend
            # can explain *why* rather than hiding behind a generic
            # "couldn't delete" toast.
            return Response(
                {
                    "detail": ["formulation_has_dependencies"],
                    "code": "formulation_has_dependencies",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        record_audit(
            organization=organization,
            actor=request.user,
            action="formulation.delete",
            target=None,
            target_type="formulation",
            target_id=target_id,
            before=before,
        )

        # PSP cleanup runs after the local delete is authoritative.
        # Silent-degrade: skip reasons (item referenced elsewhere,
        # has history, sku doesn't match NPD pattern, PSP offline)
        # just get logged and the formulation delete still succeeds.
        if psp_uuids_to_reap:
            import logging

            from apps.psp.services import delete_psp_item

            log = logging.getLogger(__name__)
            for uuid in psp_uuids_to_reap:
                result = delete_psp_item(organization=organization, uuid=uuid)
                if not result.get("deleted"):
                    log.info(
                        "formulation.delete: skipped PSP delete for item %s"
                        " (formulation %s, org %s) — reason %s",
                        uuid,
                        target_id,
                        organization.pk,
                        result.get("reason"),
                    )

        return Response(status=status.HTTP_204_NO_CONTENT)


class FormulationSalesPersonView(APIView):
    """``PUT`` ``/.../formulations/<id>/sales-person/``.

    Dedicated endpoint so the capability check is unambiguous: only
    callers with ``formulations.assign_sales_person`` can hit this
    URL, regardless of whether they also hold the project ``edit``
    grant. The body accepts ``{"user_id": "<uuid>" | null}``; a
    ``null`` clears the current assignment.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.ASSIGN_SALES_PERSON

    def put(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        payload = request.data if isinstance(request.data, dict) else {}
        raw_user_id = payload.get("user_id", object())
        if raw_user_id is object():
            return Response(
                {"user_id": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        sales_person = None
        if raw_user_id is not None:
            from django.contrib.auth import get_user_model

            User = get_user_model()
            sales_person = User.objects.filter(id=raw_user_id).first()
            if sales_person is None:
                # Treat an unresolved user UUID identically to a
                # cross-tenant user — don't leak existence through
                # a distinct error code.
                return Response(
                    {"user_id": ["sales_person_not_member"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            assign_sales_person(
                formulation=formulation,
                sales_person=sales_person,
                actor=request.user,
            )
        except SalesPersonNotMember:
            return Response(
                {"user_id": ["sales_person_not_member"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationLeadScientistView(APIView):
    """``PUT`` ``/.../formulations/<id>/lead-scientist/``.

    Mirror of :class:`FormulationSalesPersonView` for the R&D lead
    pointer. Only callers with
    ``formulations.assign_lead_scientist`` reach this URL, even if
    they also hold the project ``edit`` grant. Body shape:
    ``{"user_id": "<uuid>" | null}`` — ``null`` clears the
    assignment.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.ASSIGN_LEAD_SCIENTIST

    def put(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        payload = request.data if isinstance(request.data, dict) else {}
        raw_user_id = payload.get("user_id", object())
        if raw_user_id is object():
            return Response(
                {"user_id": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        lead_scientist = None
        if raw_user_id is not None:
            from django.contrib.auth import get_user_model

            User = get_user_model()
            lead_scientist = User.objects.filter(id=raw_user_id).first()
            if lead_scientist is None:
                # Same cross-tenant guard as the sales-person view —
                # don't leak existence through a distinct error code.
                return Response(
                    {"user_id": ["lead_scientist_not_member"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            assign_lead_scientist(
                formulation=formulation,
                lead_scientist=lead_scientist,
                actor=request.user,
            )
        except LeadScientistNotMember:
            return Response(
                {"user_id": ["lead_scientist_not_member"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationLinesView(APIView):
    """``PUT`` ``/.../formulations/<id>/lines/`` — atomic replace."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def put(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        serializer = ReplaceLinesSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            replace_lines(
                formulation=formulation,
                actor=request.user,
                lines=list(serializer.validated_data["lines"]),
            )
        except RawMaterialNotInOrg:
            return Response(
                {"lines": ["raw_material_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationStagesView(APIView):
    """``PUT`` ``/.../formulations/<id>/stages/`` — wholesale-replace
    the production-stage graph on a formulation.

    The FE builder's stage strip drives this — one PUT carries the
    full ordered stage list. Every stage that doesn't appear in the
    payload is deleted; the ones with an ``id`` are updated in-place;
    the ones without an ``id`` are created. Lines FK'd to a departing
    stage fall back to ``stage=NULL`` via ``SET_NULL`` — they surface
    in a "no stage" bucket on the FE, they never cascade-delete.

    Gated on ``formulations.edit`` — non-editors get 403.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def put(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        stages = request.data.get("stages") if isinstance(request.data, dict) else None
        if not isinstance(stages, list):
            return Response(
                {"stages": ["stages_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            set_formulation_stages(
                formulation=formulation, stages=stages, actor=request.user
            )
        except Exception as exc:  # noqa: BLE001
            # Catch-all so the operator sees the real reason instead
            # of a bare 500. Common culprits: bad decimal input, an
            # unknown ``stage_key`` slipping through the FE, a stale
            # workstation_group_uuid pointing at something that no
            # longer exists on the PSP snapshot. Ship the exception
            # class + message so the FE banner is actionable.
            import logging

            logging.getLogger(__name__).exception(
                "set_formulation_stages failed"
            )
            return Response(
                {
                    "stages": ["invalid_stage_payload"],
                    "message": f"{type(exc).__name__}: {exc}",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationComputeView(APIView):
    """``GET`` ``/.../formulations/<id>/compute/`` — dry-run totals.

    Called by the builder UI every time the scientist edits a line
    without saving, so the viability chip updates live. No state
    changes — pure read with freshly computed math.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        totals = compute_formulation_totals(formulation=formulation)
        return Response(_totals_payload(totals), status=status.HTTP_200_OK)


class FormulationSyncPspView(APIView):
    """``POST`` ``/.../formulations/<id>/sync-psp/`` — push the current
    in-memory BOM cascade to PSP without cutting a version.

    Useful for the "Sync now" affordance on the stage strip: the
    scientist wants to prototype a stage's BOM against PSP without
    forcing a v(n+1) bump in the version history. Reuses
    ``push_bom_to_psp`` so all the idempotency + silent-degrade rules
    are the same as the Save Version path.

    Response shape mirrors the save-version endpoint so the FE can
    reuse the same PSP-linked chip refresh logic:

    * ``201 Created`` with ``{"synced": true, "finished_product_uuid":
      "<uuid or null>"}`` on a successful push.
    * ``200 OK`` with ``{"synced": false, "reason": "psp_not_live"}``
      when PSP isn't configured for the org — not an error, just a
      no-op. The FE surfaces this as "PSP not configured" rather
      than a red toast.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        from apps.psp.services import is_psp_live, push_bom_to_psp

        if not is_psp_live(self.organization):
            return Response(
                {"synced": False, "reason": "psp_not_live"},
                status=status.HTTP_200_OK,
            )

        # The FE ships a per-stage BOM snapshot (actives + every
        # excipient band at compute-adjusted mg per SKU) so PSP's
        # per-stage BOMs mirror exactly what the operator sees on
        # each stage card. Missing / malformed → we fall back to
        # the line-based derivation inside push_bom_to_psp.
        raw_stage_boms = (
            request.data.get("stage_boms")
            if isinstance(request.data, dict)
            else None
        )
        stage_bom_overrides: dict[str, list[dict]] | None = None
        if isinstance(raw_stage_boms, dict):
            cleaned: dict[str, list[dict]] = {}
            for stage_uuid, rows in raw_stage_boms.items():
                if not isinstance(rows, list):
                    continue
                cleaned[str(stage_uuid)] = [
                    row for row in rows if isinstance(row, dict)
                ]
            if cleaned:
                stage_bom_overrides = cleaned

        push_error: str | None = None
        try:
            push_bom_to_psp(
                formulation=formulation,
                stage_bom_overrides=stage_bom_overrides,
            )
        except Exception as exc:
            # push_bom_to_psp is meant to be silent-degrade, but a
            # bad-payload path (e.g. a duplicate-name 422 on the very
            # first PSP item create) can still surface. Capture the
            # message on the response so the FE toast is useful; log
            # for post-mortem.
            push_error = str(exc)
            logger.exception(
                "sync-psp: push_bom_to_psp bubbled an unexpected exception"
                " for formulation %s",
                formulation.pk,
            )

        # Reload so we see the finished-product uuid ``_ensure_finished_product``
        # may have just written back.
        formulation.refresh_from_db()
        if push_error is not None:
            return Response(
                {
                    "synced": False,
                    "reason": "psp_push_failed",
                    "detail": push_error,
                    "finished_product_uuid": (
                        str(formulation.psp_finished_product_uuid)
                        if formulation.psp_finished_product_uuid
                        else None
                    ),
                },
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response(
            {
                "synced": True,
                "finished_product_uuid": (
                    str(formulation.psp_finished_product_uuid)
                    if formulation.psp_finished_product_uuid
                    else None
                ),
            },
            status=status.HTTP_201_CREATED,
        )


class FormulationPullPspBomView(APIView):
    """``POST`` ``/.../formulations/<id>/pull-psp-bom/`` — hydrate the
    finished-stage BOM from PSP's active primary BOM.

    PSP is source of truth here — the endpoint auto-snapshots the
    formulation's current state to a version labelled
    ``pre-pull-from-psp`` before overwriting, so a mis-click is
    recoverable from the version drawer. Only the finished stage's
    lines are replaced; semi-finished stages stay intact.

    Response codes:

      * 200 OK + summary dict on success.
      * 400 ``psp_not_configured`` / ``psp_finished_product_not_linked``.
      * 404 ``psp_bom_not_found`` — item has no primary BOM yet.
      * 422 ``psp_bom_empty`` — PSP returned a BOM header with no
        lines (defensive; typically means someone cleared it).
      * 502 ``psp_unreachable`` — PSP network / auth failure.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        from apps.psp.services import (
            PspAuthFailed,
            PspBomEmpty,
            PspBomNotFound,
            PspError,
            PspFinishedProductNotLinked,
            PspNotConfigured,
            PspRateLimited,
            PspUnreachable,
            pull_psp_bom_into_formulation,
        )

        try:
            summary = pull_psp_bom_into_formulation(
                organization=self.organization,
                formulation=formulation,
                actor=request.user,
            )
        except PspNotConfigured as exc:
            return Response(
                {"error": "psp_not_configured", "detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except PspFinishedProductNotLinked as exc:
            return Response(
                {
                    "error": "psp_finished_product_not_linked",
                    "detail": str(exc),
                },
                status=status.HTTP_400_BAD_REQUEST,
            )
        except PspBomNotFound as exc:
            return Response(
                {"error": "psp_bom_not_found", "detail": str(exc)},
                status=status.HTTP_404_NOT_FOUND,
            )
        except PspBomEmpty as exc:
            return Response(
                {"error": "psp_bom_empty", "detail": str(exc)},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        except PspAuthFailed as exc:
            return Response(
                {"error": "psp_auth_failed", "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except PspRateLimited as exc:
            return Response(
                {"error": "psp_rate_limited", "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        except (PspUnreachable, PspError) as exc:
            return Response(
                {"error": "psp_unreachable", "detail": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        formulation.refresh_from_db()
        return Response(
            {
                "summary": summary,
                "formulation": FormulationReadSerializer(formulation).data,
            },
            status=status.HTTP_200_OK,
        )


def _stage_template_payload(row: Any) -> dict[str, Any]:
    """Wire shape for a template row. Shared by list + detail
    responses so create / update / read all emit the same fields."""

    return {
        "id": str(row.id),
        "name": row.name,
        "description": row.description,
        "dosage_form": row.dosage_form,
        "is_seeded": row.is_seeded,
        "stages": row.stages_json or [],
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


def _normalise_template_stages(raw: Any) -> list[dict[str, Any]]:
    """Coerce an incoming ``stages`` payload into the shape the
    ``UpsertStageInput`` set_formulation_stages expects. Rejects
    malformed rows so a bad template can never brick the picker."""

    if not isinstance(raw, list):
        raise ValueError("stages must be a list")

    normalised: list[dict[str, Any]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ValueError(f"stage[{index}] must be an object")
        name = str(item.get("name") or "").strip()
        if not name:
            raise ValueError(f"stage[{index}] name is required")
        stage_key = str(item.get("stage_key") or "").strip() or "custom"
        psp_item_type = str(item.get("psp_item_type") or "semi_finished")
        if psp_item_type not in ("semi_finished", "finished_product"):
            raise ValueError(
                f"stage[{index}] psp_item_type must be semi_finished or finished_product"
            )
        normalised.append(
            {
                "sort_order": index,
                "name": name[:150],
                "stage_key": stage_key,
                "psp_item_type": psp_item_type,
                # Optional workstation defaults + times. Pass through
                # only when set so downstream consumers keep behaving
                # the same way they do for hand-authored stages.
                "workstation_group_uuid": item.get("workstation_group_uuid")
                or None,
                "workstation_group_name": str(
                    item.get("workstation_group_name") or ""
                ),
                "operation_description": str(
                    item.get("operation_description") or ""
                ),
                "setup_time_min": item.get("setup_time_min") or None,
                "cycle_time_min": item.get("cycle_time_min") or None,
                "fixed_cost": item.get("fixed_cost") or None,
                "variable_cost": item.get("variable_cost") or None,
                "capacity": item.get("capacity") or None,
                "other_fixed_cost": item.get("other_fixed_cost") or None,
                "other_variable_cost": item.get("other_variable_cost") or None,
                "other_variable_cost_basis": item.get(
                    "other_variable_cost_basis"
                )
                or None,
            }
        )
    return normalised


class StageTemplateListView(APIView):
    """``GET`` list + ``POST`` create for the org's stage templates.

    ``GET`` is open to anyone with ``VIEW`` so scientists see the
    picker options. ``POST`` requires ``MANAGE_STAGE_TEMPLATES`` — the
    reshape right sits with the workspace admin, not every operator.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.MANAGE_STAGE_TEMPLATES
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(self, request: Request, org_id: str) -> Response:
        from apps.formulations.models import FormulationStageTemplate

        rows = FormulationStageTemplate.objects.filter(
            organization=self.organization
        ).order_by("name")
        return Response(
            {"items": [_stage_template_payload(row) for row in rows]},
            status=status.HTTP_200_OK,
        )

    def post(self, request: Request, org_id: str) -> Response:
        from apps.formulations.models import FormulationStageTemplate

        raw = request.data if isinstance(request.data, dict) else {}
        name = str(raw.get("name") or "").strip()
        if not name:
            return Response(
                {"error": "invalid_payload", "detail": "name is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            stages = _normalise_template_stages(raw.get("stages") or [])
        except ValueError as exc:
            return Response(
                {"error": "invalid_stages", "detail": str(exc)},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if FormulationStageTemplate.objects.filter(
            organization=self.organization, name=name
        ).exists():
            return Response(
                {
                    "error": "duplicate_name",
                    "detail": "A template with this name already exists.",
                },
                status=status.HTTP_409_CONFLICT,
            )

        template = FormulationStageTemplate.objects.create(
            organization=self.organization,
            name=name[:200],
            description=str(raw.get("description") or "")[:2000],
            dosage_form=str(raw.get("dosage_form") or "")[:32],
            stages_json=stages,
            is_seeded=False,
            created_by=request.user,
            updated_by=request.user,
        )
        return Response(
            _stage_template_payload(template),
            status=status.HTTP_201_CREATED,
        )


class StageTemplateDetailView(APIView):
    """``PATCH`` update + ``DELETE`` for a single template. Both
    require ``MANAGE_STAGE_TEMPLATES``. Deleting a seeded template is
    allowed — admins should be free to prune the reference set when
    they want a leaner picker.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.MANAGE_STAGE_TEMPLATES

    def _get(self, template_id: str) -> Any:
        from apps.formulations.models import FormulationStageTemplate

        row = FormulationStageTemplate.objects.filter(
            organization=self.organization, id=template_id
        ).first()
        if row is None:
            raise NotFound()
        return row

    def patch(
        self, request: Request, org_id: str, template_id: str
    ) -> Response:
        from apps.formulations.models import FormulationStageTemplate

        row = self._get(template_id)
        raw = request.data if isinstance(request.data, dict) else {}

        if "name" in raw:
            name = str(raw.get("name") or "").strip()
            if not name:
                return Response(
                    {
                        "error": "invalid_payload",
                        "detail": "name cannot be blank",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if (
                FormulationStageTemplate.objects.filter(
                    organization=self.organization, name=name
                )
                .exclude(id=row.id)
                .exists()
            ):
                return Response(
                    {
                        "error": "duplicate_name",
                        "detail": (
                            "A template with this name already exists."
                        ),
                    },
                    status=status.HTTP_409_CONFLICT,
                )
            row.name = name[:200]
        if "description" in raw:
            row.description = str(raw.get("description") or "")[:2000]
        if "dosage_form" in raw:
            row.dosage_form = str(raw.get("dosage_form") or "")[:32]
        if "stages" in raw:
            try:
                row.stages_json = _normalise_template_stages(
                    raw.get("stages") or []
                )
            except ValueError as exc:
                return Response(
                    {"error": "invalid_stages", "detail": str(exc)},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        row.updated_by = request.user
        row.save()
        return Response(_stage_template_payload(row), status=status.HTTP_200_OK)

    def delete(
        self, request: Request, org_id: str, template_id: str
    ) -> Response:
        row = self._get(template_id)
        row.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _resolve_workstations_by_name(
    *, organization: Any, stages: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """For each stage without an explicit workstation_group_uuid,
    look up PSP's catalog by exact stage-name match and pin the uuid.
    Silent-degrade — a PSP outage / mis-config just returns the input
    unchanged so apply still succeeds with a null workstation.
    """

    # Fast path: every stage already has an explicit workstation.
    if not any(
        (s.get("workstation_group_uuid") in (None, ""))
        and s.get("name")
        for s in stages
        if isinstance(s, dict)
    ):
        return stages

    try:
        from apps.psp.services import list_psp_workstation_groups

        catalog = list_psp_workstation_groups(organization=organization)
    except Exception:  # pragma: no cover — silent-degrade contract
        return stages
    if not catalog:
        return stages

    by_name = {
        str(row.get("name") or "").strip().casefold(): row for row in catalog
    }
    resolved: list[dict[str, Any]] = []
    for s in stages:
        if not isinstance(s, dict):
            resolved.append(s)
            continue
        if s.get("workstation_group_uuid"):
            resolved.append(s)
            continue
        needle = str(s.get("name") or "").strip().casefold()
        match = by_name.get(needle)
        if match is None:
            resolved.append(s)
            continue
        merged = dict(s)
        merged["workstation_group_uuid"] = str(match.get("uuid") or "")
        merged["workstation_group_name"] = str(match.get("name") or "")
        resolved.append(merged)
    return resolved


class FormulationApplyStageTemplateView(APIView):
    """``POST`` ``/.../formulations/<id>/apply-stage-template/`` —
    wholesale-replace the formulation's stages with the template's
    ``stages_json``. Delegates to ``set_formulation_stages`` so the
    existing invariants (exactly-one-finished promotion, orphan-line
    reassignment on stage delete) all fire the same way as a normal
    save.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        from apps.formulations.models import FormulationStageTemplate

        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        raw = request.data if isinstance(request.data, dict) else {}
        template_id = str(raw.get("template_id") or "").strip()
        if not template_id:
            return Response(
                {"error": "invalid_payload", "detail": "template_id required"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        template = (
            FormulationStageTemplate.objects.filter(
                organization=self.organization, id=template_id
            ).first()
        )
        if template is None:
            raise NotFound()

        stages = template.stages_json or []
        # Auto-resolve any missing workstation_group_uuid on apply by
        # matching the stage name against PSP's workstation catalog.
        # Templates authored before the workstation picker landed have
        # ``workstation_group_uuid: null`` — but the stage NAMES
        # ("Blending", "Encapsulation") already match PSP workstation
        # names exactly. Rather than force the operator to hand-pick
        # the same thing twice, resolve by name on apply so the stage
        # cards land with the operation pre-selected.
        stages = _resolve_workstations_by_name(
            organization=self.organization, stages=stages
        )
        try:
            set_formulation_stages(
                formulation=formulation,
                actor=request.user,
                stages=stages,
            )
        except ValueError as exc:
            return Response(
                {"error": "invalid_template", "detail": str(exc)},
                status=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )

        formulation.refresh_from_db()
        return Response(
            {
                "summary": {
                    "template_id": template_id,
                    "template_name": template.name,
                    "stages_applied": len(stages),
                },
                "formulation": FormulationReadSerializer(formulation).data,
            },
            status=status.HTTP_200_OK,
        )


class FormulationVersionListView(APIView):
    """``GET`` / ``POST`` ``/.../formulations/<id>/versions/``."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _load(self, formulation_id: str):
        try:
            return get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        versions = list_versions(formulation=formulation)
        return Response(
            FormulationVersionReadSerializer(versions, many=True).data,
            status=status.HTTP_200_OK,
        )

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        formulation = self._load(formulation_id)
        serializer = SaveVersionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        version = save_version(
            formulation=formulation,
            actor=request.user,
            label=serializer.validated_data.get("label", ""),
            stage_boms=serializer.validated_data.get("stage_boms") or None,
            is_auto=serializer.validated_data.get("is_auto", False),
        )
        return Response(
            FormulationVersionReadSerializer(version).data,
            status=status.HTTP_201_CREATED,
        )


class FormulationWizardRoutingView(APIView):
    """``POST`` ``/.../formulations/<id>/wizard-routing/``.

    Persists the routing wizard's per-ingredient stage assignments.
    Body:

    .. code-block:: json

        {
          "line_assignments": {"<line_uuid>": "<stage_uuid_or_null>"},
          "band_assignments": [
            {"item_id": "<uuid>", "band_key": "anti_caking",
             "mg": 12.5, "stage_id": "<uuid_or_null>"}
          ]
        }

    Line assignments update ``stage`` on existing operator-picked
    active lines. Band assignments wholesale-replace the
    formulation's compute-derived band-pick lines (upsert on
    ``(item, band_key)``, delete orphans). Returns the refreshed
    formulation DTO so the caller can re-render off one round-trip.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        serializer = WizardRoutingSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        formulation = save_wizard_routing(
            formulation=formulation,
            actor=request.user,
            line_assignments=serializer.validated_data.get(
                "line_assignments"
            ),
            band_assignments=serializer.validated_data.get(
                "band_assignments"
            ),
        )
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationRollbackView(APIView):
    """``POST`` ``/.../formulations/<id>/rollback/`` — restore + snapshot."""

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        serializer = RollbackVersionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            rollback_to_version(
                formulation=formulation,
                actor=request.user,
                version_number=serializer.validated_data["version_number"],
            )
        except FormulationVersionNotFound:
            return Response(
                {"version_number": ["formulation_version_not_found"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except RawMaterialNotInOrg:
            return Response(
                {"lines": ["raw_material_not_in_org"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        formulation.refresh_from_db()
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationApprovedVersionView(APIView):
    """``POST`` ``/.../formulations/<id>/approved-version/``.

    Flips the formulation's pointer at "the current approved recipe".
    ``version_number=null`` clears the pointer. Every version-picker
    surface (trial batch modal, spec sheet creator, QC) reads this
    field back out to badge the right row.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.APPROVE

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        serializer = SetApprovedVersionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            set_approved_version(
                formulation=formulation,
                actor=request.user,
                version_number=serializer.validated_data.get("version_number"),
            )
        except FormulationVersionNotFound:
            return Response(
                {"version_number": ["formulation_version_not_found"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        formulation.refresh_from_db()
        return Response(
            FormulationReadSerializer(formulation).data,
            status=status.HTTP_200_OK,
        )


class FormulationOverviewView(APIView):
    """``GET`` ``/.../formulations/<id>/overview/``.

    One-shot aggregator for the Project workspace's Overview tab.
    Computes counts + compliance + allergens + activity feed across
    every child surface (spec sheets, trial batches, QC validations)
    so the dashboard paints in a single round-trip.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        overview = compute_project_overview(formulation)
        return Response(asdict(overview), status=status.HTTP_200_OK)


class FormulationLinkCFFView(APIView):
    """``POST`` / ``DELETE`` ``/.../formulations/<id>/link-cff/``.

    Attaches or detaches a CFF submission to this project. Both
    directions gated on ``formulations.edit`` — the same capability
    that lets a scientist reassign sales / lead — because it's a
    workspace-metadata edit, not a formulation content mutation.

    Payload: ``{ "cff_submission_id": "<uuid>" }`` on both verbs.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def _load(self, formulation_id: str, cff_id: str | None):
        from apps.cff_submissions.models import CFFSubmission

        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc
        if not cff_id:
            return formulation, None, Response(
                {"cff_submission_id": ["required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        submission = CFFSubmission.objects.filter(
            organization=self.organization, id=cff_id
        ).first()
        if submission is None:
            return formulation, None, Response(
                {"cff_submission_id": ["cff_not_found"]},
                status=status.HTTP_404_NOT_FOUND,
            )
        return formulation, submission, None

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        from apps.cff_submissions.services import (
            CFFAssignmentError,
            ProjectAlreadyHasCFF,
            assign_to_project,
        )

        payload = request.data if isinstance(request.data, dict) else {}
        formulation, submission, err = self._load(
            formulation_id, payload.get("cff_submission_id")
        )
        if err is not None:
            return err
        try:
            assign_to_project(
                submission=submission,
                project=formulation,
                actor=request.user,
            )
        except ProjectAlreadyHasCFF as exc:
            # 409 with the existing submission id so the FE renders
            # the "Unlink and replace" affordance without a second
            # round-trip. One-CFF-per-project is a workspace rule,
            # not a permission — hence 409 not 403.
            return Response(
                {
                    "code": "project_already_has_cff",
                    "existing_submission_id": exc.existing_submission_id,
                },
                status=status.HTTP_409_CONFLICT,
            )
        except CFFAssignmentError as exc:
            return Response(
                {"cff_submission_id": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        overview = compute_project_overview(formulation)
        return Response(asdict(overview), status=status.HTTP_200_OK)

    def delete(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        from apps.cff_submissions.services import (
            CFFAssignmentError,
            detach_from_project,
        )

        # DELETE bodies aren't universally supported by clients — the
        # FE unlink action sends the id in the query string too so
        # either shape works. Payload wins when both are present.
        payload = request.data if isinstance(request.data, dict) else {}
        cff_id = payload.get("cff_submission_id") or request.query_params.get(
            "cff_submission_id"
        )
        formulation, submission, err = self._load(formulation_id, cff_id)
        if err is not None:
            return err
        try:
            detach_from_project(
                submission=submission,
                project=formulation,
                actor=request.user,
            )
        except CFFAssignmentError as exc:
            return Response(
                {"cff_submission_id": [str(exc)]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        overview = compute_project_overview(formulation)
        return Response(asdict(overview), status=status.HTTP_200_OK)


#: Cap per page for the cursor-paginated CFF picker. Kept small so
#: a tenant with millions of rows still ships one page-worth of data
#: per keystroke; the FE infinite-scrolls to reach subsequent pages
#: rather than paying for a bigger initial payload.
_CFF_CANDIDATES_PAGE_SIZE = 20


def _encode_cff_cursor(effective_ts: Any, row_id: Any) -> str:
    """Base64-encode a keyset cursor for the CFF candidates picker.

    Format is opaque to the client — the FE just round-trips the
    string back on ``next_cursor``. Encodes both parts of the
    ``(effective_ts, id)`` keyset so the next page filter is a
    strict-less-than compound comparison.
    """

    import base64
    import json

    return base64.urlsafe_b64encode(
        json.dumps(
            {
                "t": effective_ts.isoformat() if effective_ts is not None else None,
                "id": str(row_id),
            }
        ).encode("utf-8")
    ).decode("ascii")


def _decode_cff_cursor(raw: str) -> tuple[Any, Any] | None:
    """Parse a base64 cursor back into ``(effective_ts, row_id)``.

    Returns ``None`` when the string is missing or malformed — the
    caller treats that as "no cursor" and starts from page 1 rather
    than 400-ing. A tampered cursor is not a security event on this
    endpoint since the underlying rows are already tenant-scoped.
    """

    if not raw:
        return None
    import base64
    import json
    from datetime import datetime

    try:
        decoded = json.loads(base64.urlsafe_b64decode(raw.encode("ascii")))
        ts_raw = decoded.get("t")
        row_id = decoded.get("id")
        if not row_id:
            return None
        ts = datetime.fromisoformat(ts_raw) if ts_raw else None
        return (ts, row_id)
    except (ValueError, TypeError, KeyError):
        return None


class FormulationCFFCandidatesView(APIView):
    """``GET`` ``/.../formulations/<id>/cff-candidates/?search=<q>&cursor=<c>``.

    Cursor-paginated picker over the org's CFF inbox.

    On modal open the FE fires this without ``search`` and without
    ``cursor`` — the caller gets the newest 20 rows in the tenant.
    Subsequent pages come from re-firing with the ``next_cursor`` the
    previous response returned; the FE infinite-scrolls until
    ``next_cursor`` is ``null``. Typing in the search box just adds
    the ``search`` filter — the cursor still works.

    Query cost properties:

    * ``raw_payload`` is never loaded (``.only()`` skips the JSON blob).
    * Filter columns (``submitter_email`` / ``submitter_name``) both
      carry ``db_index=True`` so the search is an index-range scan.
    * Sort key is ``COALESCE(wix_created_date, imported_at)`` so
      portal + Wix rows interleave chronologically without either
      branch needing to appear null-last.
    * Keyset pagination via ``(effective_ts, id) < (cursor_ts,
      cursor_id)`` — no OFFSET, so page N is O(page_size) regardless
      of N even on wide tenants.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        from apps.cff_submissions.models import CFFSubmission
        from apps.formulations.models import Formulation
        from django.db.models import F, Prefetch, Q
        from django.db.models.functions import Coalesce

        try:
            formulation = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        search = (request.query_params.get("search") or "").strip()
        cursor = _decode_cff_cursor(request.query_params.get("cursor") or "")

        queryset = (
            CFFSubmission.objects.filter(organization=self.organization)
            .filter(rejected_at__isnull=True)
            .exclude(projects=formulation)
            .annotate(
                effective_ts=Coalesce("wix_created_date", "imported_at")
            )
            .only(
                "id",
                "submitter_email",
                "submitter_name",
                "submission_kind",
                "provenance",
                "wix_created_date",
                "imported_at",
            )
            # Prefetch the M2M so ``linked_projects`` on each row is a
            # walk over an already-loaded collection, not N+1 queries.
            # ``only`` narrows the Formulation payload to the three
            # fields the picker chip actually renders — the recipe
            # blob + audit trail don't need to travel with the picker
            # response.
            .prefetch_related(
                Prefetch(
                    "projects",
                    queryset=Formulation.objects.only("id", "code", "name"),
                )
            )
            .order_by(F("effective_ts").desc(nulls_last=True), "-id")
        )

        if search:
            # Merged OR over the two denormalised name/email columns —
            # both indexed. ``icontains`` walks the index prefix on
            # each branch; the planner unions the two ranges without
            # touching ``raw_payload``.
            queryset = queryset.filter(
                Q(submitter_email__icontains=search)
                | Q(submitter_name__icontains=search)
            )

        if cursor is not None:
            cursor_ts, cursor_id = cursor
            if cursor_ts is not None:
                queryset = queryset.filter(
                    Q(effective_ts__lt=cursor_ts)
                    | Q(effective_ts=cursor_ts, id__lt=cursor_id)
                )
            else:
                queryset = queryset.filter(
                    Q(effective_ts__isnull=True, id__lt=cursor_id)
                )

        # Fetch one extra row so we can compute ``next_cursor``
        # without a follow-up COUNT — page-size + 1 is the standard
        # keyset trick.
        rows = list(queryset[: _CFF_CANDIDATES_PAGE_SIZE + 1])
        has_more = len(rows) > _CFF_CANDIDATES_PAGE_SIZE
        rows = rows[:_CFF_CANDIDATES_PAGE_SIZE]

        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            effective_ts = getattr(last, "effective_ts", None) or last.imported_at
            next_cursor = _encode_cff_cursor(effective_ts, last.id)

        results = [
            {
                "id": str(cff.id),
                "submitter_name": cff.submitter_name or (cff.submitter_email or ""),
                "submitter_email": cff.submitter_email or "",
                "submission_kind": cff.submission_kind,
                "provenance": cff.provenance,
                "wix_created_date": (
                    cff.wix_created_date.isoformat()
                    if cff.wix_created_date
                    else None
                ),
                # Every remaining project on this CFF is guaranteed to
                # be a *different* project than the one we're picking
                # for — the ``exclude(projects=formulation)`` filter
                # above already dropped the current one. Non-empty
                # means the CFF is shared with another workspace, a
                # legitimate but flag-worthy state (customer wanted
                # two flavour variants of the same brief).
                "linked_projects": [
                    {
                        "id": str(project.id),
                        "code": project.code or "",
                        "name": project.name or "",
                    }
                    for project in cff.projects.all()
                ],
            }
            for cff in rows
        ]
        return Response(
            {
                "candidates": results,
                "next_cursor": next_cursor,
            },
            status=status.HTTP_200_OK,
        )


class FormulationCloneView(APIView):
    """``POST`` ``/.../formulations/<id>/clone/``.

    Duplicates the source formulation's recipe into either a brand-new
    project (``mode="new"``) or an existing project that gets its
    recipe overwritten (``mode="replace"``). The replace path auto-
    snapshots the target's current state into a new version BEFORE
    overwriting so the action is reversible from the version history
    drawer.

    Permission: the standard formulations EDIT capability — anyone who
    can save a draft on the source can clone from it.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.EDIT

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            source = get_formulation(
                organization=self.organization, formulation_id=formulation_id
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        body = request.data if isinstance(request.data, dict) else {}
        mode = str(body.get("mode") or "").strip()
        new_code = body.get("code")
        new_name = body.get("name")
        target_id = body.get("target_formulation_id")
        target_formulation = None
        if mode == "replace" and target_id:
            try:
                target_formulation = get_formulation(
                    organization=self.organization, formulation_id=target_id
                )
            except FormulationNotFound:
                return Response(
                    {"target_formulation_id": ["clone_target_not_found"]},
                    status=status.HTTP_400_BAD_REQUEST,
                )

        try:
            result = clone_formulation(
                source=source,
                actor=request.user,
                mode=mode,
                new_code=new_code,
                new_name=new_name,
                target_formulation=target_formulation,
            )
        except InvalidCloneMode:
            return Response(
                {"mode": ["invalid_clone_mode"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FormulationCodeRequired:
            # Re-used for blank name on the "new" path too, so we map
            # it to a non-field key — the frontend surfaces the
            # validation by disabling the submit button on empty
            # inputs, but a malicious client bypassing that should
            # still get a sane 400.
            return Response(
                {"detail": ["formulation_code_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except FormulationCodeConflict:
            return Response(
                {"code": ["formulation_code_conflict"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CloneTargetRequired:
            return Response(
                {"target_formulation_id": ["clone_target_required"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CloneTargetNotFound:
            return Response(
                {"target_formulation_id": ["clone_target_not_found"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except CloneTargetIsSource:
            return Response(
                {"target_formulation_id": ["clone_target_is_source"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            FormulationReadSerializer(result).data,
            status=status.HTTP_201_CREATED,
        )


class FormulationRTGPublishView(APIView):
    """``PATCH`` ``/.../formulations/<id>/rtg-publish/``.

    Toggles the Ready-to-Go catalog publication and updates the
    marketing block in one call. Multipart-capable so the hero image
    can be uploaded alongside the descriptive fields — the FE panel
    posts a ``FormData`` body with the optional file plus the
    scalar fields.

    Body keys (all optional apart from ``is_rtg_published``):

    * ``is_rtg_published`` — ``"true"``/``"false"`` (form) or bool.
      When ``true``, the marketing fields must satisfy every
      guard enforced by :func:`publish_to_rtg_catalog`. When
      ``false``, the record is taken off the catalog and marketing
      fields are left untouched so a re-publish doesn't require
      re-typing.
    * ``rtg_short_description``, ``rtg_base_price``, ``rtg_moq``,
      ``rtg_currency_code`` — scalar marketing fields.
    * ``rtg_packaging_options`` — repeated form key, or a JSON list
      inside a single value. The view accepts both shapes so the
      FE can post a plain multipart form without JSON-encoding the
      list itself.
    * ``rtg_hero_image`` — optional file upload; ``""``/absent
      leaves the current image untouched.

    Gated on the dedicated ``rtg_catalog`` module — ``manage`` for
    marketing-only saves (edit description, price, packaging without
    flipping visibility), ``publish`` when the request also flips
    ``is_rtg_published``. Split from ``formulations.edit`` so a
    catalog manager can publish RTG SKUs without holding recipe-edit
    rights, and so an author can draft copy without the go-live
    button — segregation of duties on what appears in the customer
    portal. The membership backfill on ``0011_rtg_catalog_module``
    mirrors every existing ``formulations.edit`` grant onto both
    caps so no one loses access on upgrade.
    """

    permission_classes = (HasRTGCatalogPermission,)
    required_capability = RTGCatalogCapability.MANAGE

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        # Whether the incoming request flips ``is_rtg_published`` gates
        # the required capability: publish-toggle requires ``publish``,
        # marketing-only edit requires ``manage``. We can't peek at
        # ``request.data`` before ``super().initial`` runs the auth /
        # parser stack, so instead we look at ``request.data`` directly
        # — DRF hydrates it lazily on first read, which is safe here
        # because ``parser_classes`` is already declared on the class.
        raw = None
        try:
            raw = request.data.get("is_rtg_published")
        except Exception:
            raw = None
        if isinstance(raw, str):
            raw = raw.strip().lower()
        flips_publish = raw not in (None, "")
        self.required_capability = (
            RTGCatalogCapability.PUBLISH
            if flips_publish
            else RTGCatalogCapability.MANAGE
        )
        super().initial(request, *args, **kwargs)
    # DRF's global ``DEFAULT_PARSER_CLASSES`` is JSON-only so the
    # hero-image upload can't ride the default parsers. Opt this view
    # in to multipart + urlencoded form bodies explicitly; JSON stays
    # in the list so a caller that skips the file upload can still
    # send an application/json patch.
    parser_classes = (MultiPartParser, FormParser, JSONParser)

    def patch(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        try:
            formulation = get_formulation(
                organization=self.organization,
                formulation_id=formulation_id,
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

        data = request.data
        is_published_raw = data.get("is_rtg_published")
        # ``FormData`` submissions arrive as strings; JSON POSTs
        # arrive as native bools. Accept both so the caller isn't
        # forced to pick a content type based on whether they have
        # a file to attach.
        if isinstance(is_published_raw, str):
            is_published = is_published_raw.strip().lower() in {
                "true",
                "1",
                "yes",
            }
        else:
            is_published = bool(is_published_raw)

        packaging_raw = data.get("rtg_packaging_options")
        packaging: list[str] | None = None
        # ``getlist`` gives us the repeated-key shape when it exists;
        # fall back to parsing a JSON blob for callers who post a
        # single value.
        if hasattr(data, "getlist"):
            multi = data.getlist("rtg_packaging_options")
            if multi:
                packaging = list(multi)
        if packaging is None and packaging_raw is not None:
            if isinstance(packaging_raw, list):
                packaging = packaging_raw
            elif isinstance(packaging_raw, str):
                import json

                try:
                    parsed = json.loads(packaging_raw)
                except (TypeError, ValueError):
                    parsed = None
                if isinstance(parsed, list):
                    packaging = parsed

        marketing_fields: dict[str, Any] = {}
        for key in (
            "rtg_display_name",
            "rtg_short_description",
            "rtg_base_price",
            "rtg_moq",
            "rtg_currency_code",
        ):
            if key in data:
                marketing_fields[key] = data.get(key)
        if packaging is not None:
            marketing_fields["rtg_packaging_options"] = packaging
        if "rtg_hero_image" in data and data.get("rtg_hero_image"):
            marketing_fields["rtg_hero_image"] = data.get("rtg_hero_image")

        try:
            if is_published:
                updated = publish_to_rtg_catalog(
                    formulation,
                    actor=request.user,
                    marketing_fields=marketing_fields,
                )
            else:
                updated = unpublish_from_rtg_catalog(
                    formulation,
                    actor=request.user,
                )
        except FormulationRTGError as exc:
            field_errors = getattr(exc, "field_errors", None)
            body: dict[str, Any] = {
                "code": getattr(exc, "code", "formulation_rtg_error"),
                "detail": str(exc),
            }
            if field_errors:
                body["fields"] = field_errors
            return Response(body, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            FormulationReadSerializer(updated).data,
            status=status.HTTP_200_OK,
        )
