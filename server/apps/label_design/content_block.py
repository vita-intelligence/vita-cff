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
class CanonicalNutrition:
    """Per-100g + per-serving canonical nutrition values.

    The single source of truth that every regional panel reads from.
    Values are strings so we can carry "TBC" placeholders alongside
    real numbers without losing the regional template's column shape.

    Salt → sodium conversion uses the regulatory ratio (1 g salt =
    393 mg sodium ≈ salt ÷ 2.5). Derivation happens in
    :func:`_resolve_canonical_nutrition`, not on the dataclass, so
    this stays a frozen value type the template can read without
    side effects.
    """

    # Energy — both units required by UK/EU; US uses kcal only;
    # JP/CN/AU report kJ + kcal (or kJ only for CN).
    energy_kj_per_100g: str = ""
    energy_kcal_per_100g: str = ""
    energy_kj_per_serving: str = ""
    energy_kcal_per_serving: str = ""

    # Fat group — total, saturated, trans (TBC). US is the only
    # regime that mandates trans. Cholesterol is US-only.
    fat_per_100g: str = ""
    fat_per_serving: str = ""
    fat_saturated_per_100g: str = ""
    fat_saturated_per_serving: str = ""
    fat_trans_per_100g: str = "TBC"
    fat_trans_per_serving: str = "TBC"
    cholesterol_per_100g: str = "TBC"
    cholesterol_per_serving: str = "TBC"

    # Carbohydrate group — total, sugars, added sugars (TBC, US-only),
    # fibre. EU mandates total + sugars; US mandates added sugars too.
    carbohydrate_per_100g: str = ""
    carbohydrate_per_serving: str = ""
    sugar_per_100g: str = ""
    sugar_per_serving: str = ""
    added_sugars_per_100g: str = "TBC"
    added_sugars_per_serving: str = "TBC"
    fibre_per_100g: str = ""
    fibre_per_serving: str = ""

    protein_per_100g: str = ""
    protein_per_serving: str = ""

    # UK/EU report Salt; US/JP/CN/AU report Sodium. We carry both —
    # sodium is derived from salt when only salt is on the snapshot.
    salt_per_100g: str = ""
    salt_per_serving: str = ""
    sodium_per_100g: str = ""
    sodium_per_serving: str = ""

    # US-only daily-value extras. TBC until the scientist captures
    # them in the LabelDesign nutrition-extras form (future work).
    vitamin_d_per_serving: str = "TBC"
    calcium_per_serving: str = "TBC"
    iron_per_serving: str = "TBC"
    potassium_per_serving: str = "TBC"

    #: ``True`` iff at least one contributor row is non-zero. Drives
    #: the "no nutrition data yet" empty state on each panel.
    has_data: bool = False


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
    nutrition: CanonicalNutrition = field(default_factory=CanonicalNutrition)
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
    """Resolve the brand-owner's address for the label.

    The label business address identifies the food business
    operator under whose name the product is marketed
    (EU 1169/2011 Art. 9 §1(h)). For Vita's private-label model
    that is **the customer**, not Vita — Vita is the contract
    manufacturer; the brand the consumer reads on the shelf is the
    customer's.

    Resolution order:
    1. ``Proposal.customer`` linked to the spec sheet (or its
       formulation version) → ``customer.company`` +
       ``customer.invoice_address``.
    2. Fallback to the spec sheet's denormalised
       ``client_company`` / ``client_name`` — single line, no
       address (designer fills the rest in their tool).
    3. Empty if neither is available.

    Manufacturing tenant (``sheet.organization``) is intentionally
    NOT used here — putting Vita's address on a customer-branded
    label would be a labelling error.
    """

    # Path 1: spec → proposal (OneToOne reverse) → customer.
    customer = None
    proposal = getattr(sheet, "proposal", None)
    if proposal is not None:
        customer = getattr(proposal, "customer", None)

    # Path 2: spec.formulation_version → any Proposal for the
    # same version with a customer set. Falls back when the spec
    # has no direct proposal link (rare — auto-generated FINAL
    # specs on trial-batch PASS go straight to LabelDesign).
    if customer is None:
        version = getattr(sheet, "formulation_version", None)
        if version is not None:
            try:
                from apps.proposals.models import Proposal

                fallback = (
                    Proposal.objects.filter(
                        formulation_version=version, customer__isnull=False
                    )
                    .select_related("customer")
                    .order_by("-updated_at")
                    .first()
                )
                if fallback is not None:
                    customer = fallback.customer
            except Exception:
                customer = None

    if customer is not None:
        lines = []
        company = (getattr(customer, "company", "") or "").strip()
        if company:
            lines.append(company)
        address = (getattr(customer, "invoice_address", "") or "").strip()
        if address:
            lines.append(address)
        if lines:
            return "\n".join(lines)

    # Path 3: denormalised client_company on the spec sheet itself.
    client_company = (
        getattr(sheet, "client_company", "")
        or getattr(sheet, "client_name", "")
        or ""
    ).strip()
    if client_company:
        return client_company

    return ""


def _resolve_country_of_origin(sheet: SpecificationSheet) -> str:
    """Country of origin = country where the food was manufactured.

    For Vita's UK contract-manufacturing model this is the
    manufacturing tenant's country (UK by default). Country of
    origin is distinct from the brand-owner address — it's
    factually where the goods were made, and that is Vita's
    facility, not the customer's HQ.
    """
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


#: Conversion factor from grams of salt to grams of sodium.
#: 1 g NaCl ≈ 0.393 g Na — used by EU Regulation 1169/2011 Annex I
#: (salt = sodium × 2.5) and reciprocally for sodium-on-label
#: regimes (US, JP, CN, AU). Applied bidirectionally so a spec that
#: records one axis can populate the other for the matching panel.
SALT_TO_SODIUM_FACTOR = Decimal("0.393")
SODIUM_TO_SALT_FACTOR = Decimal("2.5")


def _format_nutrition_value(value: Any, *, places: int = 1) -> str:
    """Format a nutrition value to ``places`` decimal places.

    Returns the empty string for ``None`` / ``""`` so the template can
    cleanly distinguish "data not derived" from the literal zero
    that means "ingredient contributes none of this nutrient". A
    contributors-aware caller decides which of those two stories the
    panel tells.
    """

    if value is None or value == "":
        return ""
    try:
        return format(
            Decimal(str(value)).quantize(Decimal(10) ** -places), "f"
        )
    except Exception:
        return _safe_str(value)


def _format_energy(value: Any) -> str:
    """Energy values are whole-number kJ/kcal in every regime."""
    return _format_nutrition_value(value, places=0)


def _resolve_canonical_nutrition(sheet: SpecificationSheet) -> CanonicalNutrition:
    """Build the canonical per-100g + per-serving nutrition payload.

    Reads :attr:`FormulationVersion.snapshot_totals` (frozen at the
    spec's birth, so this is deterministic — re-running on the same
    spec returns the same values). The snapshot stores rows under
    the keys defined in
    :data:`apps.formulations.constants.NUTRITION_KEYS`.

    Sodium is back-derived from salt where the snapshot records
    salt only — every regime except UK/EU expects sodium on the
    label. We never overwrite a value the snapshot already has.
    """

    version = getattr(sheet, "formulation_version", None)
    if version is None:
        return CanonicalNutrition()
    totals = getattr(version, "snapshot_totals", None) or {}
    rows = (totals.get("nutrition") or {}).get("rows") or []

    by_key: dict[str, dict[str, Any]] = {}
    has_data = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = row.get("key") or row.get("slug")
        if not key:
            continue
        by_key[key] = row
        if (row.get("contributors") or 0) > 0:
            has_data = True

    def per_100g(key: str) -> Any:
        return (by_key.get(key) or {}).get("per_100g")

    def per_serving(key: str) -> Any:
        return (by_key.get(key) or {}).get("per_serving")

    # Salt → sodium back-derivation. UK/EU snapshot has salt; the
    # other panels want sodium. If sodium isn't on the snapshot and
    # salt is, derive it; otherwise leave both empty so the template
    # shows nothing (rather than a misleading derived zero).
    raw_salt_100g = per_100g("salt")
    raw_salt_serving = per_serving("salt")

    def _derive_sodium(salt_value: Any) -> str:
        if salt_value is None or salt_value == "":
            return ""
        try:
            grams = Decimal(str(salt_value)) * SALT_TO_SODIUM_FACTOR
            # Sodium is reported in mg in every regime that uses it
            # (US, JP, CN, AU/NZ) — convert grams → mg.
            return _format_nutrition_value(grams * Decimal(1000), places=0)
        except Exception:
            return ""

    return CanonicalNutrition(
        energy_kj_per_100g=_format_energy(per_100g("energy_kj")),
        energy_kcal_per_100g=_format_energy(per_100g("energy_kcal")),
        energy_kj_per_serving=_format_energy(per_serving("energy_kj")),
        energy_kcal_per_serving=_format_energy(per_serving("energy_kcal")),
        fat_per_100g=_format_nutrition_value(per_100g("fat")),
        fat_per_serving=_format_nutrition_value(per_serving("fat")),
        fat_saturated_per_100g=_format_nutrition_value(per_100g("fat_saturated")),
        fat_saturated_per_serving=_format_nutrition_value(
            per_serving("fat_saturated")
        ),
        carbohydrate_per_100g=_format_nutrition_value(per_100g("carbohydrate")),
        carbohydrate_per_serving=_format_nutrition_value(
            per_serving("carbohydrate")
        ),
        sugar_per_100g=_format_nutrition_value(per_100g("sugar")),
        sugar_per_serving=_format_nutrition_value(per_serving("sugar")),
        fibre_per_100g=_format_nutrition_value(per_100g("fibre")),
        fibre_per_serving=_format_nutrition_value(per_serving("fibre")),
        protein_per_100g=_format_nutrition_value(per_100g("protein")),
        protein_per_serving=_format_nutrition_value(per_serving("protein")),
        salt_per_100g=_format_nutrition_value(raw_salt_100g, places=2),
        salt_per_serving=_format_nutrition_value(raw_salt_serving, places=2),
        sodium_per_100g=_derive_sodium(raw_salt_100g),
        sodium_per_serving=_derive_sodium(raw_salt_serving),
        has_data=has_data,
    )


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
        nutrition_table=(),  # legacy field — superseded by ``nutrition``
        nutrition=_resolve_canonical_nutrition(spec),
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


#: Region slugs the template recognises. ``"all"`` (the default)
#: renders the full document with brand header + 9 panels +
#: ingredients + footer; any other slug renders just that single
#: regulatory panel for a per-region download.
REGION_SLUGS: tuple[str, ...] = (
    "all",
    "uk-eu",
    "us",
    "japan",
    "china",
    "australia-nz",
    "codex-asean",
    "gso-dubai",
    "africa",
)


def render_content_block_html(
    block: ComplianceContentBlock, *, region: str = "all"
) -> str:
    """Render the block to an HTML string.

    Same template feeds the PDF + PNG renderers, so every format
    stays visually aligned. ``region`` controls whether the full
    document or a single regional panel is rendered — see
    :data:`REGION_SLUGS` for the supported values. Unknown slugs
    fall back to ``"all"`` so a malformed query parameter doesn't
    blow up the renderer.
    """
    if region not in REGION_SLUGS:
        region = "all"
    return render_to_string(
        "label_design/content_block.html",
        {
            "block": block,
            "ingredients": block.ingredients_list,
            "region": region,
        },
    )


def render_content_block_pdf(
    block: ComplianceContentBlock, *, region: str = "all"
) -> bytes:
    """Render the block to a PDF byte string via WeasyPrint.

    Lazy import: WeasyPrint loads cairo/pango at module-load time
    via cffi; importing it eagerly would crash on any host without
    the system libraries (including the local Mac dev image without
    Homebrew pango). The lazy import lets tests skip cleanly via
    ``pytest.importorskip``.
    """

    from weasyprint import HTML  # noqa: WPS433 — see docstring

    html_string = render_content_block_html(block, region=region)
    return HTML(string=html_string).write_pdf()


def render_content_block_png(
    block: ComplianceContentBlock, *, dpi: int = 300, region: str = "all"
) -> bytes:
    """Rasterise the PDF to PNG via pypdfium2.

    pypdfium2 bundles its own pdfium binary so no system library
    install is needed at runtime. We render only page 1 — the
    content block is single-page by design (multi-page label
    artwork lives in the design tool, not in our derived block).
    """

    import pypdfium2 as pdfium  # noqa: WPS433 — lazy for symmetry

    pdf_bytes = render_content_block_pdf(block, region=region)
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
