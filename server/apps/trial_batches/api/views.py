"""Views for the trial-batches API."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import asdict

from django.http import HttpResponse
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.formulations.api.permissions import HasFormulationsPermission
from apps.organizations.modules import FormulationsCapability
from apps.trial_batches.api.serializers import (
    TrialBatchCreateSerializer,
    TrialBatchReadSerializer,
    TrialBatchUpdateSerializer,
)
from apps.trial_batches.services import (
    FormulationVersionNotInOrg,
    InvalidBatchSize,
    InvalidBatchSizeMode,
    TrialBatchNotFound,
    compute_batch_scaleup,
    create_batch,
    get_batch,
    list_batches_for_formulation,
    update_batch,
)


class TrialBatchListCreateView(APIView):
    """``GET`` / ``POST`` scoped to one formulation.

    ``/api/organizations/<org>/formulations/<formulation_id>/trial-batches/``

    List returns every batch that targets any version of the
    requested formulation; create locks the new batch to a specific
    version the caller supplies.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "POST"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def get(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        queryset = list_batches_for_formulation(
            organization=self.organization,
            formulation_id=formulation_id,
        )
        serializer = TrialBatchReadSerializer(queryset, many=True)
        return Response(serializer.data, status=status.HTTP_200_OK)

    def post(
        self, request: Request, org_id: str, formulation_id: str
    ) -> Response:
        serializer = TrialBatchCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            batch = create_batch(
                organization=self.organization,
                actor=request.user,
                formulation_version_id=data["formulation_version_id"],
                batch_size_units=data["batch_size_units"],
                batch_size_mode=data.get("batch_size_mode", "pack"),
                label=data.get("label", ""),
                notes=data.get("notes", ""),
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
        except InvalidBatchSize:
            return Response(
                {"batch_size_units": ["invalid_batch_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidBatchSizeMode:
            return Response(
                {"batch_size_mode": ["invalid_batch_size_mode"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(
            TrialBatchReadSerializer(batch).data,
            status=status.HTTP_201_CREATED,
        )


class TrialBatchDetailView(APIView):
    """``GET`` / ``PATCH`` / ``DELETE``
    ``/api/organizations/<org>/trial-batches/<id>/``.

    Lives at the org root (not nested under formulations) because the
    scientist reaches a batch by its own id — the link from the list
    page already encodes the formulation scope.
    """

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request: Request, *args, **kwargs) -> None:  # type: ignore[override]
        if request.method == "GET":
            self.required_capability = FormulationsCapability.VIEW
        elif request.method == "DELETE":
            self.required_capability = FormulationsCapability.DELETE
        else:
            self.required_capability = FormulationsCapability.EDIT
        super().initial(request, *args, **kwargs)

    def _load(self, batch_id: str):
        try:
            return get_batch(
                organization=self.organization, batch_id=batch_id
            )
        except TrialBatchNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, batch_id: str) -> Response:
        batch = self._load(batch_id)
        return Response(TrialBatchReadSerializer(batch).data)

    def patch(
        self, request: Request, org_id: str, batch_id: str
    ) -> Response:
        batch = self._load(batch_id)
        serializer = TrialBatchUpdateSerializer(
            data=request.data, partial=True
        )
        serializer.is_valid(raise_exception=True)
        try:
            updated = update_batch(
                batch=batch,
                actor=request.user,
                **serializer.validated_data,
            )
        except InvalidBatchSize:
            return Response(
                {"batch_size_units": ["invalid_batch_size"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except InvalidBatchSizeMode:
            return Response(
                {"batch_size_mode": ["invalid_batch_size_mode"]},
                status=status.HTTP_400_BAD_REQUEST,
            )
        return Response(TrialBatchReadSerializer(updated).data)

    def delete(
        self, request: Request, org_id: str, batch_id: str
    ) -> Response:
        from apps.audit.services import record as record_audit, snapshot

        batch = self._load(batch_id)
        organization = batch.organization
        target_id = str(batch.pk)
        before = snapshot(batch)
        batch.delete()
        record_audit(
            organization=organization,
            actor=request.user,
            action="trial_batch.delete",
            target=None,
            target_type="trialbatch",
            target_id=target_id,
            before=before,
        )
        return Response(status=status.HTTP_204_NO_CONTENT)


class TrialBatchRenderView(APIView):
    """``GET`` ``/.../trial-batches/<id>/render/``.

    Computes the scaled-up BOM fresh each request from the frozen
    :class:`FormulationVersion` snapshot. No catalogue edits downstream
    can rewrite what procurement sees for a planned batch.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str, batch_id: str) -> Response:
        try:
            batch = get_batch(
                organization=self.organization, batch_id=batch_id
            )
        except TrialBatchNotFound as exc:
            raise NotFound() from exc
        result = compute_batch_scaleup(batch)
        payload = asdict(result)
        # asdict() returns Decimals as Decimal instances; DRF's JSON
        # renderer serialises them fine, but we stringify for
        # symmetry with every other decimal-carrying payload the
        # frontend consumes (render_context etc.).
        payload = _stringify_decimals(payload)
        return Response(payload, status=status.HTTP_200_OK)


def _stringify_decimals(value):
    from decimal import Decimal

    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, list):
        return [_stringify_decimals(v) for v in value]
    if isinstance(value, dict):
        return {k: _stringify_decimals(v) for k, v in value.items()}
    return value


# ---------------------------------------------------------------------------
# BOM export (F4.4) — MRPeasy-ready CSV + flat JSON
# ---------------------------------------------------------------------------


#: Columns written to the CSV, in order. Kept as a module constant so
#: the shape is greppable and so any future consumer (MRPeasy importer,
#: SAP spreadsheet template, whatever) can be diffed against one list.
_BOM_CSV_COLUMNS: tuple[str, ...] = (
    "code",
    "material",
    "category",
    "uom",
    "quantity",
    "quantity_unit",
    "mg_per_unit",
    "g_per_pack",
    "notes",
)


def _bom_filename(batch) -> str:
    """Produce a stable, portable filename for a BOM export.

    Procurement files these by product code, so the filename should
    sort cleanly in Finder / Explorer without the scientist having to
    rename anything. ``<code>-v<n>-bom`` matches the PDF naming
    already used by the spec sheet downloads.
    """

    code = (batch.formulation_version.formulation.code or "").strip()
    if not code:
        code = str(batch.id)[:8]
    code = code.replace(" ", "-")
    v = batch.formulation_version.version_number
    return f"{code}-v{v}-bom"


def _bom_line_rows(result) -> list[dict]:
    """Flatten a :class:`BOMResult` into a list of per-line dicts
    suitable for CSV / flat JSON export.

    Weight-UOM lines report ``quantity`` in kg; count-UOM lines (the
    capsule shell) report their piece count and the unit literally
    says ``each``. A downstream ERP mapping the columns has everything
    it needs on a single row — no cross-field lookups.
    """

    rows: list[dict] = []
    for entry in result.entries:
        if entry.uom == "count":
            quantity = str(entry.count_per_batch)
            quantity_unit = "each"
        else:
            quantity = str(entry.kg_per_batch)
            quantity_unit = "kg"
        rows.append(
            {
                "code": entry.internal_code or "",
                "material": entry.label,
                "category": entry.category,
                "uom": entry.uom,
                "quantity": quantity,
                "quantity_unit": quantity_unit,
                "mg_per_unit": str(entry.mg_per_unit),
                "g_per_pack": str(entry.g_per_pack),
                "notes": "",
            }
        )
    return rows


class TrialBatchBOMExportView(APIView):
    """``GET`` ``/.../trial-batches/<id>/bom/``.

    Content-negotiated BOM export. ``?format=csv`` (default) returns a
    header-plus-rows CSV the ERP importer can chew. ``?format=json``
    returns a flat JSON document (batch metadata + line array) so
    integrations that would rather skip the CSV round-trip can pull
    the same data structurally.

    Response is always served with ``Content-Disposition: attachment``
    so the browser download UX is consistent. Cookie auth rides
    same-origin from the anchor click.
    """

    permission_classes = (HasFormulationsPermission,)
    required_capability = FormulationsCapability.VIEW

    def get(self, request: Request, org_id: str, batch_id: str) -> HttpResponse:
        try:
            batch = get_batch(
                organization=self.organization, batch_id=batch_id
            )
        except TrialBatchNotFound as exc:
            raise NotFound() from exc

        result = compute_batch_scaleup(batch)
        rows = _bom_line_rows(result)
        filename_stem = _bom_filename(batch)

        fmt = (request.query_params.get("format") or "csv").lower()
        if fmt == "json":
            payload = {
                "batch": {
                    "id": result.batch_id,
                    "label": result.label,
                    "formulation_id": result.formulation_id,
                    "formulation_name": result.formulation_name,
                    "version_number": result.version_number,
                    "version_label": result.version_label,
                    "dosage_form": result.dosage_form,
                    "size_label": result.size_label,
                    "batch_size_packs": result.batch_size_units,
                    "batch_size_mode": result.batch_size_mode,
                    "units_per_pack": result.units_per_pack,
                    "total_units_in_batch": result.total_units_in_batch,
                },
                "totals": {
                    "fill_mg_per_unit": str(result.total_mg_per_unit),
                    "fill_g_per_pack": str(result.total_g_per_pack),
                    "fill_kg_per_batch": str(result.total_kg_per_batch),
                    "shells_per_batch": result.total_count_per_batch,
                },
                "lines": rows,
            }
            body = json.dumps(payload, indent=2).encode("utf-8")
            response = HttpResponse(body, content_type="application/json")
            response["Content-Disposition"] = (
                f'attachment; filename="{filename_stem}.json"'
            )
            return response

        # Default: CSV. Writes through an in-memory buffer first so
        # we can hand the full payload to the HttpResponse in one
        # write — simpler than streaming for ~hundreds of lines.
        buffer = io.StringIO()
        writer = csv.DictWriter(
            buffer,
            fieldnames=_BOM_CSV_COLUMNS,
            extrasaction="ignore",
        )
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
        response = HttpResponse(
            buffer.getvalue(), content_type="text/csv; charset=utf-8"
        )
        response["Content-Disposition"] = (
            f'attachment; filename="{filename_stem}.csv"'
        )
        return response
