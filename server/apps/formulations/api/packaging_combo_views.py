"""Views for the RTG-only packaging-combo editor.

One endpoint pair per formulation: ``GET`` reads the current combos,
``PUT`` replaces the full list atomically. Replace-all is simpler
than piecemeal CRUD for a small nested collection — the editor
maintains the full state client-side and syncs it in one call.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

from django.db import transaction
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.catalogues.models import Item
from apps.formulations.api.permissions import HasFormulationsPermission
from apps.formulations.models import (
    Formulation,
    PackagingCombo,
    PackagingComboItem,
)
from apps.formulations.services import (
    FormulationNotFound,
    get_formulation,
)
from apps.organizations.modules import FormulationsCapability


def _combo_payload(combo: PackagingCombo) -> dict:
    return {
        "id": str(combo.id),
        "name": combo.name,
        "price_delta": str(combo.price_delta),
        "sort_order": combo.sort_order,
        "is_default": combo.is_default,
        # Stage assignment for the packaging cascade. Nullable until
        # the scientist wires it up on the Routing tab; RTG readiness
        # gate refuses to advance without every combo having a stage.
        "stage_id": str(combo.stage_id) if combo.stage_id else None,
        "items": [
            {
                "id": str(row.id),
                "item_id": str(row.item_id),
                "item_name": row.item.name if row.item_id else "",
                "item_code": row.item.internal_code if row.item_id else "",
                "quantity": row.quantity,
                "sort_order": row.sort_order,
            }
            for row in combo.items.select_related("item").all()
        ],
    }


class PackagingCombosView(APIView):
    """``GET`` list + ``PUT`` replace-all for a formulation's combos."""

    permission_classes = (HasFormulationsPermission,)

    def initial(self, request, *args, **kwargs):  # type: ignore[override]
        self.required_capability = (
            FormulationsCapability.EDIT
            if request.method == "PUT"
            else FormulationsCapability.VIEW
        )
        super().initial(request, *args, **kwargs)

    def _get_formulation(self, formulation_id: str) -> Formulation:
        try:
            return get_formulation(
                organization=self.organization,
                formulation_id=formulation_id,
            )
        except FormulationNotFound as exc:
            raise NotFound() from exc

    def get(self, request: Request, org_id: str, formulation_id: str) -> Response:
        formulation = self._get_formulation(formulation_id)
        combos = (
            formulation.packaging_combos.all()
            .prefetch_related("items__item")
        )
        return Response({"items": [_combo_payload(c) for c in combos]})

    def put(self, request: Request, org_id: str, formulation_id: str) -> Response:
        formulation = self._get_formulation(formulation_id)
        combos_in = request.data.get("combos")
        if not isinstance(combos_in, list):
            return Response(
                {
                    "error": "invalid_payload",
                    "detail": "Send `combos` as an array.",
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Pre-validate every row so a bad entry rejects the whole
        # request before we touch the DB. Cheaper for the caller than
        # a partial write half-way through the atomic block.
        cleaned: list[dict] = []
        default_seen = False
        seen_names: set[str] = set()
        # Cache Item lookups so a combo with N identical items only
        # hits the DB once per unique item.
        item_cache: dict[str, Item] = {}
        # Prefetch valid stage IDs on this formulation so combo
        # ``stage_id`` values can be validated in-memory without an
        # N+1 lookup per row.
        valid_stage_ids = {
            str(sid)
            for sid in formulation.stages.values_list("id", flat=True)
        }
        for i, raw in enumerate(combos_in):
            if not isinstance(raw, dict):
                return Response(
                    {
                        "error": "invalid_combo",
                        "detail": f"Combo #{i} isn't an object.",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            name = str(raw.get("name") or "").strip()
            if not name:
                return Response(
                    {
                        "error": "invalid_combo",
                        "detail": f"Combo #{i} is missing a name.",
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if name in seen_names:
                return Response(
                    {
                        "error": "duplicate_combo_name",
                        "detail": f'Combo name "{name}" appears twice.',
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            seen_names.add(name)
            try:
                price_delta = Decimal(str(raw.get("price_delta") or "0"))
            except (InvalidOperation, TypeError):
                return Response(
                    {
                        "error": "invalid_price_delta",
                        "detail": f'Combo "{name}" has a non-numeric price delta.',
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            is_default = bool(raw.get("is_default"))
            if is_default:
                if default_seen:
                    return Response(
                        {
                            "error": "multiple_defaults",
                            "detail": "At most one combo can be marked default.",
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                default_seen = True
            # Stage assignment — optional (nullable so scientists can
            # draft combos before wiring routing). Must belong to this
            # formulation when provided.
            stage_id_raw = raw.get("stage_id")
            if stage_id_raw is None or (
                isinstance(stage_id_raw, str) and not stage_id_raw.strip()
            ):
                stage_id: str | None = None
            else:
                candidate = str(stage_id_raw).strip()
                if candidate not in valid_stage_ids:
                    return Response(
                        {
                            "error": "invalid_stage",
                            "detail": (
                                f'Combo "{name}" is assigned to a stage '
                                "that doesn't belong to this formulation."
                            ),
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                stage_id = candidate
            items_raw = raw.get("items")
            if not isinstance(items_raw, list) or len(items_raw) == 0:
                return Response(
                    {
                        "error": "empty_combo",
                        "detail": f'Combo "{name}" needs at least one item.',
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            cleaned_items: list[dict] = []
            for j, ir in enumerate(items_raw):
                if not isinstance(ir, dict):
                    return Response(
                        {
                            "error": "invalid_combo_item",
                            "detail": f'Combo "{name}" item #{j} isn\'t an object.',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                item_id = str(ir.get("item_id") or "").strip()
                if not item_id:
                    return Response(
                        {
                            "error": "invalid_combo_item",
                            "detail": f'Combo "{name}" item #{j} is missing item_id.',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                if item_id not in item_cache:
                    item = Item.objects.filter(
                        id=item_id,
                        catalogue__organization=self.organization,
                    ).first()
                    if item is None:
                        return Response(
                            {
                                "error": "unknown_item",
                                "detail": f'Combo "{name}" references an item that isn\'t in this org.',
                            },
                            status=status.HTTP_400_BAD_REQUEST,
                        )
                    item_cache[item_id] = item
                qty = int(ir.get("quantity") or 1)
                if qty < 1:
                    return Response(
                        {
                            "error": "invalid_quantity",
                            "detail": f'Combo "{name}" item #{j} has quantity < 1.',
                        },
                        status=status.HTTP_400_BAD_REQUEST,
                    )
                cleaned_items.append(
                    {
                        "item": item_cache[item_id],
                        "quantity": qty,
                        "sort_order": j,
                    }
                )
            cleaned.append(
                {
                    "name": name,
                    "price_delta": price_delta,
                    "is_default": is_default,
                    "stage_id": stage_id,
                    "sort_order": i,
                    "items": cleaned_items,
                }
            )

        # Atomic replace: wipe existing combos, recreate. Cascade
        # handles the PackagingComboItem rows via the FK on delete.
        with transaction.atomic():
            formulation.packaging_combos.all().delete()
            for row in cleaned:
                combo = PackagingCombo.objects.create(
                    formulation=formulation,
                    name=row["name"],
                    price_delta=row["price_delta"],
                    is_default=row["is_default"],
                    stage_id=row["stage_id"],
                    sort_order=row["sort_order"],
                )
                PackagingComboItem.objects.bulk_create(
                    [
                        PackagingComboItem(
                            combo=combo,
                            item=ci["item"],
                            quantity=ci["quantity"],
                            sort_order=ci["sort_order"],
                        )
                        for ci in row["items"]
                    ]
                )

        combos = (
            formulation.packaging_combos.all().prefetch_related("items__item")
        )
        return Response({"items": [_combo_payload(c) for c in combos]})
