"""Compliance Content Block: spec-derived label content + exports.

This is the unique value of the label-design workflow. Given a
:class:`SpecificationSheet`, we derive every legally-required label
element (ingredients list in correct order, nutrition table with
NRV %, allergen statement, dosage instructions, business address,
country of origin, storage conditions, net quantity, certification
logo placeholders) into a frozen dataclass. That dataclass renders
into four formats so a designer can grab it in whichever shape
suits their tool:

* JSON dict — for on-screen previews and structured inspection.
* HTML — internal preview, also the source for PDF + PNG.
* PDF — vector; scales cleanly when pasted into Canva / Illustrator
  / Figma.
* PNG — raster; pasted anywhere as a plain image.
* Plain text — copy-to-clipboard, with per-section copy buttons in
  the UI.

The deriver is a pure function: identical spec → identical block.
PDF / PNG bytes are also deterministic (fixed creation timestamp on
the PDF) so a content-block change is a real change and not metadata
noise.
"""

from __future__ import annotations

import io
from dataclasses import asdict, dataclass, field
from decimal import Decimal
from typing import Any

from django.template.loader import render_to_string

from apps.specifications.models import SpecificationSheet


# ---------------------------------------------------------------------------
# Data shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IngredientLine:
    name: str
    qty_label: str
    nrv_percent: str
    allergen_flag: bool


@dataclass(frozen=True)
class NutritionRow:
    nutrient: str
    per_serving: str
    nrv_percent: str
    unit: str


@dataclass(frozen=True)
class CertLogoSlot:
    slug: str
    label: str


@dataclass(frozen=True)
class ComplianceContentBlock:
    """The spec-derived "what must appear on the label" payload."""

    product_name: str
    product_code: str
    net_quantity: str
    serving_size: str
    servings_per_pack: str
    directions_of_use: str
    suggested_dosage: str
    ingredients_list: tuple[IngredientLine, ...] = ()
    allergen_statement: str = ""
    nutrition_table: tuple[NutritionRow, ...] = ()
    claims: tuple[str, ...] = ()
    storage_conditions: str = ""
    shelf_life: str = ""
    food_contact_status: str = ""
    business_address: str = ""
    country_of_origin: str = ""
    cert_logo_slots: tuple[CertLogoSlot, ...] = ()
    barcode_placeholder: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Plain-data dict for JSON serialisation and DB snapshots.

        We materialise the tuples into lists so the dict round-trips
        cleanly through JSONField (which would otherwise turn the
        nested IngredientLine dataclasses into lists-of-dicts on the
        next load).
        """
        return asdict(self)


@dataclass(frozen=True)
class ContentBlockText:
    """Plain-text payload for clipboard copy.

    ``full`` is the one-shot dump; ``sections`` keys the same content
    per logical group so the UI can offer per-section copy buttons.
    """

    full: str
    sections: dict[str, str] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Derivation
# ---------------------------------------------------------------------------


def _safe_str(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip() or default


def _format_decimal(value: Any, *, places: int = 2) -> str:
    if value is None or value == "":
        return ""
    try:
        d = Decimal(str(value)).quantize(Decimal(10) ** -places)
        return format(d.normalize(), "f")
    except Exception:
        return _safe_str(value)


def _resolve_ingredients(sheet: SpecificationSheet) -> tuple[IngredientLine, ...]:
    """Extract the active ingredients list from the spec's
    formulation version snapshot.

    Reads ``version.snapshot_lines`` (the JSON list saved by
    :func:`apps.formulations.services._snapshot_lines`) — each entry
    is ``{item_id, item_name, item_internal_code, item_attributes,
    label_claim_mg, mg_per_serving, ...}``. We sort by descending
    ``mg_per_serving`` (falling back to ``label_claim_mg``) to
    mirror the regulatory "predominance" convention that the
    ingredient list appears in descending quantity order.
    """

    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return ()

    snapshot_lines = list(version.snapshot_lines or [])

    def _quantity_key(entry: dict) -> Decimal:
        for key in ("mg_per_serving", "label_claim_mg"):
            raw = entry.get(key)
            if raw is None or raw == "":
                continue
            try:
                return Decimal(str(raw))
            except Exception:
                continue
        return Decimal("0")

    snapshot_lines.sort(
        key=lambda entry: (-(_quantity_key(entry)), str(entry.get("item_name", "")))
    )

    out: list[IngredientLine] = []
    for entry in snapshot_lines:
        name = (entry.get("item_name") or "").strip()
        if not name:
            continue
        qty_raw = entry.get("mg_per_serving") or entry.get("label_claim_mg")
        qty_label = f"{_format_decimal(qty_raw)} mg" if qty_raw else ""
        attributes = entry.get("item_attributes") or {}
        allergen_flag = bool(attributes.get("allergen"))
        out.append(
            IngredientLine(
                name=name,
                qty_label=qty_label,
                nrv_percent="",
                allergen_flag=allergen_flag,
            )
        )
    return tuple(out)


def _resolve_allergen_statement(
    ingredients: tuple[IngredientLine, ...],
) -> str:
    flagged = [i.name for i in ingredients if i.allergen_flag]
    if not flagged:
        return ""
    return "Contains: " + ", ".join(flagged)


def _resolve_business_address(sheet: SpecificationSheet) -> str:
    organization = getattr(sheet, "organization", None)
    if organization is None:
        return ""
    parts = [
        getattr(organization, "name", "") or "",
        getattr(organization, "address_line_1", "") or "",
        getattr(organization, "address_line_2", "") or "",
        getattr(organization, "city", "") or "",
        getattr(organization, "postal_code", "") or "",
        getattr(organization, "country", "") or "",
    ]
    return "\n".join(part for part in parts if part.strip())


def _resolve_country_of_origin(sheet: SpecificationSheet) -> str:
    organization = getattr(sheet, "organization", None)
    if organization is None:
        return ""
    return _safe_str(getattr(organization, "country", "")) or "United Kingdom"


def _resolve_product_name(sheet: SpecificationSheet) -> str:
    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return ""
    formulation = getattr(version, "formulation", None)
    if formulation is None:
        return ""
    return _safe_str(formulation.name)


def _resolve_product_code(sheet: SpecificationSheet) -> str:
    code = _safe_str(getattr(sheet, "code", ""))
    if code:
        return code
    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return ""
    formulation = getattr(version, "formulation", None)
    if formulation is None:
        return ""
    return _safe_str(formulation.code)


def _resolve_net_quantity(sheet: SpecificationSheet) -> str:
    explicit = _safe_str(getattr(sheet, "unit_quantity", ""))
    if explicit:
        return explicit
    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return ""
    formulation = getattr(version, "formulation", None)
    if formulation is None:
        return ""
    servings = getattr(formulation, "servings_per_pack", None)
    if servings:
        return f"{servings} servings"
    return ""


def _resolve_serving_size(sheet: SpecificationSheet) -> str:
    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return ""
    formulation = getattr(version, "formulation", None)
    if formulation is None:
        return ""
    serving = getattr(formulation, "serving_size", None)
    if not serving:
        return ""
    return f"{serving}"


def _resolve_servings_per_pack(sheet: SpecificationSheet) -> str:
    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return ""
    formulation = getattr(version, "formulation", None)
    if formulation is None:
        return ""
    servings = getattr(formulation, "servings_per_pack", None)
    return str(servings) if servings is not None else ""


def _resolve_directions_and_dosage(
    sheet: SpecificationSheet,
) -> tuple[str, str]:
    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return "", ""
    formulation = getattr(version, "formulation", None)
    if formulation is None:
        return "", ""
    directions = _safe_str(getattr(formulation, "directions_of_use", ""))
    dosage = _safe_str(getattr(formulation, "suggested_dosage", ""))
    return directions, dosage


def compute_content_block(spec: SpecificationSheet) -> ComplianceContentBlock:
    """Derive the Compliance Content Block from ``spec``.

    Pure function: same input → same output. Tests pin this so a
    content-block change is a real change and not metadata noise.
    """

    ingredients = _resolve_ingredients(spec)
    directions, dosage = _resolve_directions_and_dosage(spec)

    return ComplianceContentBlock(
        product_name=_resolve_product_name(spec),
        product_code=_resolve_product_code(spec),
        net_quantity=_resolve_net_quantity(spec),
        serving_size=_resolve_serving_size(spec),
        servings_per_pack=_resolve_servings_per_pack(spec),
        directions_of_use=directions,
        suggested_dosage=dosage,
        ingredients_list=ingredients,
        allergen_statement=_resolve_allergen_statement(ingredients),
        nutrition_table=(),  # populated in a later slice — kept empty here
        claims=(),
        storage_conditions=_safe_str(getattr(spec, "storage_conditions", "")),
        shelf_life=_safe_str(getattr(spec, "shelf_life", "")),
        food_contact_status=_safe_str(getattr(spec, "food_contact_status", "")),
        business_address=_resolve_business_address(spec),
        country_of_origin=_resolve_country_of_origin(spec),
        cert_logo_slots=(),  # opt-in via formulation flags — empty for v1
        barcode_placeholder="",
    )


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------


def render_content_block_html(block: ComplianceContentBlock) -> str:
    """Render the block to an HTML string. The same template feeds
    the PDF + PNG renderers, so all three formats stay visually
    aligned."""

    return render_to_string(
        "label_design/content_block.html",
        {"block": block, "ingredients": block.ingredients_list},
    )


def render_content_block_pdf(block: ComplianceContentBlock) -> bytes:
    """Render the block to a PDF byte string via WeasyPrint.

    Lazy import: WeasyPrint loads cairo/pango at module-load time
    via cffi; importing it eagerly would crash on any host without
    the system libraries (including the local Mac dev image without
    Homebrew pango). The lazy import lets tests skip cleanly via
    ``pytest.importorskip``.
    """

    from weasyprint import HTML  # noqa: WPS433 — see docstring

    html_string = render_content_block_html(block)
    return HTML(string=html_string).write_pdf()


def render_content_block_png(
    block: ComplianceContentBlock, *, dpi: int = 300
) -> bytes:
    """Rasterise the PDF to PNG via pypdfium2.

    pypdfium2 bundles its own pdfium binary so no system library
    install is needed at runtime. We render only page 1 — the
    content block is single-page by design (multi-page label
    artwork lives in the design tool, not in our derived block).
    """

    import pypdfium2 as pdfium  # noqa: WPS433 — lazy for symmetry

    pdf_bytes = render_content_block_pdf(block)
    pdf = pdfium.PdfDocument(pdf_bytes)
    page = pdf[0]
    bitmap = page.render(scale=dpi / 72)
    pil_image = bitmap.to_pil()
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    return buffer.getvalue()


def render_content_block_text(block: ComplianceContentBlock) -> ContentBlockText:
    """Structured plain-text payload for clipboard copy.

    No formatting tricks — pasting this into Canva, Word, or a plain
    text field "just works". Each section has a stable key so the
    frontend can show a per-section copy button next to the matching
    chunk in the preview UI.
    """

    sections: dict[str, str] = {}

    sections["product"] = (
        f"Product: {block.product_name}\n"
        f"Code: {block.product_code}\n"
        f"Net quantity: {block.net_quantity}".strip()
    )
    sections["serving"] = (
        f"Serving size: {block.serving_size}\n"
        f"Servings per pack: {block.servings_per_pack}".strip()
    )
    sections["directions"] = (
        f"Directions of use: {block.directions_of_use}\n"
        f"Suggested dosage: {block.suggested_dosage}".strip()
    )

    if block.ingredients_list:
        lines = []
        for ing in block.ingredients_list:
            bits = [ing.name]
            if ing.qty_label:
                bits.append(ing.qty_label)
            if ing.nrv_percent:
                bits.append(f"{ing.nrv_percent}% NRV")
            if ing.allergen_flag:
                bits.append("[ALLERGEN]")
            lines.append(" — ".join(bits))
        sections["ingredients"] = "Ingredients:\n" + "\n".join(lines)
    else:
        sections["ingredients"] = "Ingredients: (none derived)"

    sections["allergen"] = (
        block.allergen_statement or "Allergen statement: (none)"
    )

    sections["storage"] = (
        f"Storage conditions: {block.storage_conditions}\n"
        f"Shelf life: {block.shelf_life}".strip()
    )

    sections["business"] = (
        f"Business address:\n{block.business_address}\n"
        f"Country of origin: {block.country_of_origin}".strip()
    )

    # Order matters — this is what "copy all" pastes.
    ordering = (
        "product",
        "serving",
        "directions",
        "ingredients",
        "allergen",
        "storage",
        "business",
    )
    full = "\n\n".join(sections[key] for key in ordering if sections.get(key))
    return ContentBlockText(full=full, sections=sections)
