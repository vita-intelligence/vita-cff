"""Views for the formulations API."""

from __future__ import annotations

from dataclasses import asdict
from decimal import Decimal
from typing import Any

from django.db.models import ProtectedError
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

        try:
            push_bom_to_psp(formulation=formulation)
        except Exception:
            # Same defensive envelope as the save-version hook — the
            # service already swallows every PspError. Anything that
            # slips through gets logged so a PSP outage doesn't fail
            # the whole sync request.
            logger.exception(
                "sync-psp: push_bom_to_psp bubbled an unexpected exception"
                " for formulation %s",
                formulation.pk,
            )

        # Reload so we see the finished-product uuid ``_ensure_finished_product``
        # may have just written back.
        formulation.refresh_from_db()
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
        )
        return Response(
            FormulationVersionReadSerializer(version).data,
            status=status.HTTP_201_CREATED,
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
