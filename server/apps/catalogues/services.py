"""Service layer for the catalogues app.

Views never touch the ORM directly; they call these functions. Services
never enforce authorization; views do that via the DRF permission class
in ``api/permissions.py``. Cross-app consumers (formulations,
specifications, ...) also go through this module so extracting
catalogues into its own service later stays a boundary refactor
rather than a rewrite.
"""

from __future__ import annotations

import datetime as _dt
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, IO

from django.db import transaction
from django.db.models import QuerySet

from apps.attributes.models import AttributeDefinition, DataType
from apps.attributes.services import validate_values
from apps.audit.services import record as record_audit, snapshot
from apps.catalogues.models import Catalogue, Item
from apps.organizations.models import Organization


# ---------------------------------------------------------------------------
# Catalogue CRUD
# ---------------------------------------------------------------------------


class CatalogueNotFound(Exception):
    code = "catalogue_not_found"


class CatalogueSlugConflict(Exception):
    code = "catalogue_slug_conflict"


class CatalogueSlugInvalid(Exception):
    code = "catalogue_slug_invalid"


class CatalogueIsSystem(Exception):
    """Raised when a mutation targets a system catalogue that forbids it."""

    code = "catalogue_is_system"


_SLUG_REGEX = __import__("re").compile(r"^[a-z][a-z0-9_]{0,63}$")


def list_catalogues(*, organization: Organization) -> QuerySet[Catalogue]:
    """Return catalogues belonging to ``organization`` in slug order."""

    return Catalogue.objects.filter(organization=organization).order_by(
        "-is_system", "slug"
    )


def get_catalogue(
    *, organization: Organization, slug: str
) -> Catalogue:
    """Return a single catalogue in ``organization`` by ``slug``.

    Raises :class:`CatalogueNotFound` if the slug does not exist in
    the given organization, so views can translate to ``404`` without
    leaking existence across tenants.
    """

    catalogue = Catalogue.objects.filter(
        organization=organization, slug=slug
    ).first()
    if catalogue is None:
        raise CatalogueNotFound()
    return catalogue


@transaction.atomic
def create_catalogue(
    *,
    organization: Organization,
    actor: Any = None,
    slug: str,
    name: str,
    description: str = "",
) -> Catalogue:
    """Create a custom (non-system) catalogue inside ``organization``.

    System catalogues are seeded automatically by the
    :mod:`apps.catalogues.signals` ``post_save`` handler and must not
    be created by this function — this service only produces
    ``is_system=False`` rows.

    ``actor`` is optional because the seeding signal calls this
    indirectly during org bootstrap where no user exists; the audit
    row records ``actor=None`` in that case and attributes to "system".
    """

    cleaned_slug = (slug or "").strip().lower()
    if not _SLUG_REGEX.match(cleaned_slug):
        raise CatalogueSlugInvalid()

    duplicate = Catalogue.objects.filter(
        organization=organization, slug=cleaned_slug
    ).exists()
    if duplicate:
        raise CatalogueSlugConflict()

    catalogue = Catalogue.objects.create(
        organization=organization,
        slug=cleaned_slug,
        name=name.strip(),
        description=(description or "").strip(),
        is_system=False,
    )
    record_audit(
        organization=organization,
        actor=actor,
        action="catalogue.create",
        target=catalogue,
        after=snapshot(catalogue),
    )
    return catalogue


@transaction.atomic
def update_catalogue(
    *,
    catalogue: Catalogue,
    actor: Any = None,
    name: str | None = None,
    description: str | None = None,
) -> Catalogue:
    """Update the human-facing metadata on a catalogue.

    Slugs are immutable — renaming would break every cross-module
    reference (formulation engine, permission grants, URLs). The
    ``is_system`` flag is likewise immutable.
    """

    before = snapshot(catalogue)
    if name is not None:
        catalogue.name = name.strip()
    if description is not None:
        catalogue.description = description.strip()
    catalogue.save(update_fields=["name", "description", "updated_at"])
    record_audit(
        organization=catalogue.organization,
        actor=actor,
        action="catalogue.update",
        target=catalogue,
        before=before,
        after=snapshot(catalogue),
    )
    return catalogue


@transaction.atomic
def delete_catalogue(*, catalogue: Catalogue, actor: Any = None) -> None:
    """Hard-delete a non-system catalogue and every item inside it.

    Refuses to touch system catalogues — those are load-bearing for
    downstream features and must never be removed.
    """

    if catalogue.is_system:
        raise CatalogueIsSystem()
    organization = catalogue.organization
    target_id = str(catalogue.pk)
    before = snapshot(catalogue)
    catalogue.delete()
    record_audit(
        organization=organization,
        actor=actor,
        action="catalogue.delete",
        target=None,
        target_type="catalogue",
        target_id=target_id,
        before=before,
    )


# ---------------------------------------------------------------------------
# Item CRUD
# ---------------------------------------------------------------------------


class ItemNotFound(Exception):
    code = "item_not_found"


class ItemInternalCodeConflict(Exception):
    code = "internal_code_conflict"


def list_items(
    *,
    catalogue: Catalogue,
    include_archived: bool = False,
    search: str | None = None,
) -> QuerySet[Item]:
    """Return items inside ``catalogue``, ordered by name.

    ``search`` does a case-insensitive contains match against ``name``
    and ``internal_code``. Empty or whitespace-only strings are ignored
    so the builder's picker can submit whatever the user has typed
    without first trimming it.
    """

    qs = Item.objects.filter(catalogue=catalogue)
    if not include_archived:
        qs = qs.filter(is_archived=False)
    if search:
        trimmed = search.strip()
        if trimmed:
            from django.db.models import Q
            qs = qs.filter(
                Q(name__icontains=trimmed)
                | Q(internal_code__icontains=trimmed)
            )
    return qs.order_by("name")


def get_item(*, catalogue: Catalogue, item_id: Any) -> Item:
    """Return a single item scoped to ``catalogue`` or raise ``ItemNotFound``."""

    item = Item.objects.filter(catalogue=catalogue, id=item_id).first()
    if item is None:
        raise ItemNotFound()
    return item


@transaction.atomic
def create_item(
    *,
    catalogue: Catalogue,
    actor: Any,
    name: str,
    internal_code: str = "",
    unit: str = "",
    base_price: Decimal | None = None,
    attributes: dict[str, Any] | None = None,
) -> Item:
    """Create and return a new :class:`Item` inside ``catalogue``.

    Raises :class:`ItemInternalCodeConflict` if an item with the same
    non-empty ``internal_code`` already exists in the same catalogue.
    ``attributes`` is stored as-is — the caller is expected to have
    validated it through :func:`apps.attributes.services.validate_values`
    before handing it in.
    """

    if internal_code:
        duplicate = Item.objects.filter(
            catalogue=catalogue, internal_code=internal_code
        ).exists()
        if duplicate:
            raise ItemInternalCodeConflict()

    item = Item.objects.create(
        catalogue=catalogue,
        name=name,
        internal_code=internal_code,
        unit=unit,
        base_price=base_price,
        attributes=dict(attributes or {}),
        created_by=actor,
        updated_by=actor,
    )
    record_audit(
        organization=catalogue.organization,
        actor=actor,
        action="catalogue_item.create",
        target=item,
        after=snapshot(item),
    )
    return item


@transaction.atomic
def update_item(
    *,
    item: Item,
    actor: Any,
    name: str | None = None,
    internal_code: str | None = None,
    unit: str | None = None,
    base_price: Decimal | None = None,
    is_archived: bool | None = None,
    attributes: dict[str, Any] | None = None,
) -> Item:
    """Apply partial updates to an existing item in place."""

    before = snapshot(item)
    if internal_code is not None and internal_code != item.internal_code:
        if internal_code:
            duplicate = (
                Item.objects.filter(
                    catalogue=item.catalogue, internal_code=internal_code
                )
                .exclude(pk=item.pk)
                .exists()
            )
            if duplicate:
                raise ItemInternalCodeConflict()
        item.internal_code = internal_code

    if name is not None:
        item.name = name
    if unit is not None:
        item.unit = unit
    if base_price is not None:
        item.base_price = base_price
    if is_archived is not None:
        item.is_archived = is_archived
    if attributes is not None:
        item.attributes = dict(attributes)

    item.updated_by = actor
    item.save()
    record_audit(
        organization=item.catalogue.organization,
        actor=actor,
        action="catalogue_item.update",
        target=item,
        before=before,
        after=snapshot(item),
    )
    return item


@transaction.atomic
def archive_item(*, item: Item, actor: Any) -> Item:
    """Soft-delete an item by flipping ``is_archived`` to ``True``."""

    before = snapshot(item)
    item.is_archived = True
    item.updated_by = actor
    item.save(update_fields=["is_archived", "updated_by", "updated_at"])
    record_audit(
        organization=item.catalogue.organization,
        actor=actor,
        action="catalogue_item.archive",
        target=item,
        before=before,
        after=snapshot(item),
    )
    return item


@transaction.atomic
def delete_item(*, item: Item, actor: Any = None) -> None:
    """Hard-delete an item. The row is removed from the database."""

    organization = item.catalogue.organization
    target_id = str(item.pk)
    before = snapshot(item)
    item.delete()
    record_audit(
        organization=organization,
        actor=actor,
        action="catalogue_item.delete",
        target=None,
        target_type="item",
        target_id=target_id,
        before=before,
    )


# ---------------------------------------------------------------------------
# Bulk import
# ---------------------------------------------------------------------------


class ItemImportError(Exception):
    """Raised for whole-file failures (empty file, missing ``name`` column)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


BUILTIN_IMPORT_KEYS: tuple[str, ...] = (
    "name",
    "internal_code",
    "unit",
    "base_price",
)


@dataclass
class ImportRowError:
    row: int
    errors: dict[str, list[str]]


@dataclass
class ItemImportResult:
    created: int = 0
    errors: list[ImportRowError] = field(default_factory=list)
    unmapped_columns: list[str] = field(default_factory=list)


def _normalize_header(raw: Any) -> str:
    if raw is None:
        return ""
    return str(raw).strip().lower().replace(" ", "_")


def _parse_decimal(raw: Any) -> Decimal | None:
    if raw is None or raw == "":
        return None
    if isinstance(raw, (int, float, Decimal)):
        try:
            return Decimal(str(raw))
        except (InvalidOperation, ValueError):
            return None
    if isinstance(raw, str):
        trimmed = raw.strip()
        if not trimmed:
            return None
        try:
            return Decimal(trimmed)
        except (InvalidOperation, ValueError):
            return None
    return None


def _normalize_attribute_cell(
    definition: AttributeDefinition, raw: Any
) -> Any:
    if raw is None:
        return None
    if definition.data_type == DataType.DATE and isinstance(raw, _dt.datetime):
        return raw.date().isoformat()
    if definition.data_type == DataType.MULTI_SELECT and isinstance(raw, str):
        return [part.strip() for part in raw.split(",") if part.strip()]
    return raw


class _RowValidationError(Exception):
    """Rolls back a per-row savepoint on attribute validation failure."""

    def __init__(self, errors: dict[str, list[str]]) -> None:
        super().__init__("row_validation_failed")
        self.errors = errors


def import_items_from_xlsx(
    *,
    catalogue: Catalogue,
    actor: Any,
    file: IO[bytes],
) -> ItemImportResult:
    """Import items from an ``.xlsx`` file into ``catalogue``.

    Column mapping rules (all case-insensitive, spaces converted to
    underscores):

    * Headers that match a builtin field name (``name``,
      ``internal_code``, ``unit``, ``base_price``) are routed to the
      corresponding ``Item`` column.
    * Every other header is matched against the active
      ``AttributeDefinition`` rows for this catalogue, first by
      ``key`` and then by ``label``.
    * Headers that match nothing are recorded on
      :attr:`ItemImportResult.unmapped_columns` and their values are
      dropped silently.

    Each data row is created inside its own savepoint. A bad row
    rolls back only itself and is recorded on
    :attr:`ItemImportResult.errors`; good rows commit.
    """

    import openpyxl  # local import — dep is only needed for this code path

    try:
        workbook = openpyxl.load_workbook(file, read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001
        raise ItemImportError("file_invalid") from exc

    sheet = workbook.active
    if sheet is None:
        raise ItemImportError("file_empty")

    rows_iter = sheet.iter_rows(values_only=True)
    try:
        header_row = next(rows_iter)
    except StopIteration as exc:
        raise ItemImportError("file_empty") from exc

    headers = [_normalize_header(cell) for cell in header_row]

    definitions = list(
        AttributeDefinition.objects.filter(
            catalogue=catalogue,
            is_archived=False,
        )
    )
    defn_by_key = {d.key.lower(): d for d in definitions}
    defn_by_label = {
        d.label.strip().lower().replace(" ", "_"): d for d in definitions
    }

    column_map: list[tuple[int, str, Any]] = []
    unmapped_columns: list[str] = []
    for idx, header in enumerate(headers):
        if not header:
            continue
        if header in BUILTIN_IMPORT_KEYS:
            column_map.append((idx, "builtin", header))
            continue
        definition = defn_by_key.get(header) or defn_by_label.get(header)
        if definition is not None:
            column_map.append((idx, "attribute", definition))
            continue
        unmapped_columns.append(
            str(header_row[idx]).strip() if header_row[idx] is not None else header
        )

    has_name_column = any(
        kind == "builtin" and target == "name" for _, kind, target in column_map
    )
    if not has_name_column:
        raise ItemImportError("missing_name_column")

    result = ItemImportResult(unmapped_columns=unmapped_columns)

    for row_number, row in enumerate(rows_iter, start=2):
        if all(cell is None or cell == "" for cell in row):
            continue

        builtin_data: dict[str, Any] = {}
        attribute_data: dict[str, Any] = {}
        for idx, kind, target in column_map:
            try:
                raw = row[idx]
            except IndexError:
                raw = None
            if kind == "builtin":
                builtin_data[target] = raw
            else:
                attribute_data[target.key] = _normalize_attribute_cell(target, raw)

        raw_name = builtin_data.get("name")
        if raw_name is None or (isinstance(raw_name, str) and not raw_name.strip()):
            result.errors.append(
                ImportRowError(row=row_number, errors={"name": ["required"]})
            )
            continue

        try:
            with transaction.atomic():
                coerced_attrs, attr_errors = validate_values(
                    catalogue=catalogue,
                    incoming=attribute_data,
                )
                if attr_errors:
                    raise _RowValidationError(attr_errors)

                create_item(
                    catalogue=catalogue,
                    actor=actor,
                    name=str(raw_name).strip(),
                    internal_code=str(
                        builtin_data.get("internal_code") or ""
                    ).strip(),
                    unit=str(builtin_data.get("unit") or "").strip(),
                    base_price=_parse_decimal(builtin_data.get("base_price")),
                    attributes=coerced_attrs,
                )
                result.created += 1
        except _RowValidationError as exc:
            result.errors.append(
                ImportRowError(row=row_number, errors=exc.errors)
            )
        except ItemInternalCodeConflict:
            result.errors.append(
                ImportRowError(
                    row=row_number,
                    errors={"internal_code": ["internal_code_conflict"]},
                )
            )
        except Exception:  # noqa: BLE001
            result.errors.append(
                ImportRowError(
                    row=row_number,
                    errors={"detail": ["import_row_failed"]},
                )
            )

    return result
