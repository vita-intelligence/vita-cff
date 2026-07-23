/**
 * Client-side port of the formulation math service.
 *
 * Mirrors :mod:`apps.formulations.services` line for line so the
 * builder can compute totals live as the scientist types, without a
 * round-trip to the backend. The backend remains authoritative for
 * saved versions (``snapshot_totals``); this port is only for the
 * working state.
 *
 * If you change anything here, update ``server/apps/formulations/
 * services.py`` at the same time and re-run both test suites — the
 * golden Valley workbook values are the single source of truth.
 */

import {
  CAPSULE_SHELL_WEIGHTS,
  CAPSULE_SIZES,
  COMPLIANCE_FLAGS,
  TABLET_SIZES,
} from "./types";
import type {
  CapsuleSizeOption,
  ComplianceFlagKey,
  DosageForm,
  PowderType,
  TabletSizeOption,
} from "./types";

// ---------------------------------------------------------------------------
// Constants — copied verbatim from apps/formulations/constants.py
// ---------------------------------------------------------------------------

const CAPSULE_MG_STEARATE_PCT = 0.01;
const CAPSULE_SILICA_PCT = 0.004;

const TABLET_MG_STEARATE_PCT = 0.01;
const TABLET_SILICA_PCT = 0.004;
const TABLET_DCP_PCT = 0.10;
const TABLET_MCC_PCT = 0.20;

/** Powder flavour system — each row is mg per **gram of finished
 * powder**. The per-serving mg total is
 * ``mgPerGPowder × per_scoop_g × scoops_per_serving``, matching how
 * Excel's ``Formulation Calculation Sheet`` sums the BOM (per-gram
 * column × Serving Size = per-serving mass). Must stay in lock-step
 * with ``POWDER_FLAVOUR_SYSTEM`` on the Python side. */
const POWDER_FLAVOUR_SYSTEM: ReadonlyArray<{
  readonly slug: string;
  readonly label: string;
  readonly mgPerGPowder: number;
}> = [
  { slug: "trisodium_citrate", label: "Trisodium Citrate", mgPerGPowder: 25 },
  { slug: "citric_acid", label: "Citric Acid", mgPerGPowder: 75 },
  { slug: "flavouring", label: "Flavouring", mgPerGPowder: 62.5 },
  { slug: "sweetener", label: "Sweetener", mgPerGPowder: 15 },
  { slug: "colour", label: "Colour", mgPerGPowder: 10 },
];

/** Protein-powder variant — drops the acidity regulators (Trisodium
 * Citrate + Citric Acid). Protein matrices buffer themselves. */
const PROTEIN_POWDER_FLAVOUR_SYSTEM: ReadonlyArray<{
  readonly slug: string;
  readonly label: string;
  readonly mgPerGPowder: number;
}> = [
  { slug: "flavouring", label: "Flavouring", mgPerGPowder: 62.5 },
  { slug: "sweetener", label: "Sweetener", mgPerGPowder: 15 },
  { slug: "colour", label: "Colour", mgPerGPowder: 10 },
];

function powderFlavourSystemFor(
  powderType: PowderType | null | undefined,
): ReadonlyArray<{
  readonly slug: string;
  readonly label: string;
  readonly mgPerGPowder: number;
}> {
  return powderType === "protein"
    ? PROTEIN_POWDER_FLAVOUR_SYSTEM
    : POWDER_FLAVOUR_SYSTEM;
}

/** Default per-scoop fill weight (mg) seeded when the scientist has
 *  not entered ``targetFillWeightMg`` yet. Matches
 *  ``POWDER_REFERENCE_FILL_WEIGHT_MG`` on the Python side — a 5 g
 *  sachet reference (Rave Lytes / Moonlytes). */
const POWDER_DEFAULT_FILL_WEIGHT_MG = 5000;

/** Water is auto-filled at 5.5% of the target gummy weight (fixed),
 *  mirroring :data:`apps.formulations.constants.GUMMY_WATER_PCT`. */
const GUMMY_WATER_PCT = 0.055;

/** Acidity regulator auto-fills at 2% of the target gummy weight —
 *  scales linearly with the recipe, mirrors
 *  :data:`GUMMY_ACIDITY_PCT` on the server. */
const GUMMY_ACIDITY_PCT = 0.02;

/** Flavouring at 0.4% of target — split equally across flavouring
 *  picks; mirrors :data:`GUMMY_FLAVOURING_PCT` on the server. */
const GUMMY_FLAVOURING_PCT = 0.004;

/** Colour at 2% of target — split equally across colour picks;
 *  mirrors :data:`GUMMY_COLOUR_PCT` on the server. */
const GUMMY_COLOUR_PCT = 0.02;

/** Glazing agent (carnauba wax, coconut oil, beeswax, etc.) at 0.1%
 *  of the target gummy weight — applied as a thin surface coating,
 *  also scales linearly, mirrors :data:`GUMMY_GLAZING_PCT` on the
 *  server. */
const GUMMY_GLAZING_PCT = 0.001;

/** Gelling agent (pectin, gelatin, agar, etc.) at 3% of target —
 *  emitted only when the scientist has actually picked at least one
 *  gelling item. Mirrors :data:`GUMMY_GELLING_PCT` on the server. */
const GUMMY_GELLING_PCT = 0.03;

/** Premix sweetener at 6% of target, **carved out** of the gummy
 *  base remainder so the visible base shrinks when the premix is
 *  emitted. Coupled to gelling — only emitted when gelling items are
 *  picked. Mirrors :data:`GUMMY_PREMIX_SWEETENER_PCT` on the server. */
const GUMMY_PREMIX_SWEETENER_PCT = 0.06;

/** Minimum gummy-base ratio. Below this the gel matrix won't set
 *  reliably — mirrors :data:`GUMMY_BASE_MIN_PCT` on the server. */
const GUMMY_BASE_MIN_PCT = 0.65;

/** Default values keyed by override slug. ``resolveBandPct`` reads
 *  this map to fall back when an override is missing. Must stay in
 *  lock-step with ``EXCIPIENT_BAND_DEFAULTS`` on the Python side.
 *  Mixes percentage bands (decimal in 0..1) with powder mg/g rates
 *  (positive floats, often 5+) -- callers know which scale they
 *  expect from the slug name. */
export const EXCIPIENT_BAND_DEFAULTS: Readonly<Record<string, number>> = {
  // Gummy
  water: GUMMY_WATER_PCT,
  acidity: GUMMY_ACIDITY_PCT,
  flavouring: GUMMY_FLAVOURING_PCT,
  colour: GUMMY_COLOUR_PCT,
  glazing: GUMMY_GLAZING_PCT,
  gelling: GUMMY_GELLING_PCT,
  premix_sweetener: GUMMY_PREMIX_SWEETENER_PCT,
  // Anti-caking
  mg_stearate: CAPSULE_MG_STEARATE_PCT,
  silica: CAPSULE_SILICA_PCT,
  // Tablet carriers
  dcp: TABLET_DCP_PCT,
  mcc: TABLET_MCC_PCT,
  // Legacy powder acidity rates -- kept so any pre-existing snapshot
  // override still resolves to a number rather than throwing. The
  // math no longer reads them; powder acidity is per-item now.
  powder_trisodium_citrate: 25,
  powder_citric_acid: 75,
};

/** Override slugs the formulation's ``excipient_overrides`` JSON
 *  recognises. Anything else is ignored (server-side validation
 *  rejects unknown slugs at write time). Mirror of
 *  :data:`EXCIPIENT_OVERRIDE_KEYS` on the Python side. */
export const EXCIPIENT_BAND_SLUGS = [
  "water",
  "acidity",
  "flavouring",
  "colour",
  "glazing",
  "gelling",
  "premix_sweetener",
  "mg_stearate",
  "silica",
  "dcp",
  "mcc",
  // Legacy slugs kept for snapshot compatibility; the math no longer
  // reads them. Powder flavouring / sweetener / colour moved to a
  // per-item rate on the catalogue (powder_<band>_mg_per_g).
  "powder_trisodium_citrate",
  "powder_citric_acid",
] as const;
export type ExcipientBandSlug = (typeof EXCIPIENT_BAND_SLUGS)[number];

/** Backwards-compatible alias for the gummy-only consumers that
 *  imported the original constant by name. */
export const GUMMY_BAND_SLUGS = EXCIPIENT_BAND_SLUGS;
export type GummyBandSlug = ExcipientBandSlug;

/** Resolve the effective value for an excipient band: override if
 *  the formulation has one, otherwise the constant default. Mirrors
 *  :func:`_resolve_band_pct` on the server. Unit-agnostic -- callers
 *  pass a slug name and receive the value in that band's native
 *  unit (decimal pct for percentage bands, mg-per-gram-of-powder for
 *  the powder flavour-system bands). */
function resolveBandPct(
  slug: string,
  overrides: Readonly<Record<string, number>> | null | undefined,
): number {
  if (overrides) {
    const raw = overrides[slug];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      return raw;
    }
  }
  return EXCIPIENT_BAND_DEFAULTS[slug] ?? 0;
}

/**
 * Thresholds for the capsule auto-picker, transcribed from the
 * workbook's ``Lists!G6:G8`` cascade. ``undefined`` skips a size
 * from the ladder (e.g. Size 3 is only selectable manually).
 */
const CAPSULE_AUTO_PICK: ReadonlyArray<{
  readonly key: string;
  readonly threshold: number;
}> = [
  { key: "size_1", threshold: 300.0 },
  { key: "single_0", threshold: 446.658 },
  { key: "double_00", threshold: 719.78 },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Math-critical attribute subset for a raw material. Mirrors the
 * ``item_attributes`` field emitted by ``FormulationLineReadSerializer``.
 * The builder also fills this from ``ItemDto.attributes`` when a new
 * line is added from the picker.
 */
export interface ItemAttributesForMath {
  readonly type?: string | null;
  readonly purity?: string | number | null;
  readonly extract_ratio?: string | number | null;
  readonly overage?: string | number | null;
  //: ``use_as`` classifier. Drives the live "item missing use_as"
  //: warning the builder surfaces in the viability panel. Empty /
  //: null = blank classification → warning. Optional so math-only
  //: callers that don't care can hand in a narrow object.
  readonly use_as?: string | null;
  //: Label-copy + compliance fields. Optional so math-only callers
  //: can hand in a narrow object; the builder always passes the
  //: full set.
  readonly ingredient_list_name?: string | null;
  readonly nutrition_information_name?: string | null;
  readonly vegan?: string | null;
  readonly organic?: string | null;
  readonly halal?: string | null;
  readonly kosher?: string | null;
  //: Allergen flag + source class (e.g. "Milk", "Soybeans"). ``"None"``
  //: and ``"#VALUE!"`` sentinel strings are normalised to empty by
  //: :func:`computeAllergens`.
  readonly allergen?: string | null;
  readonly allergen_source?: string | null;
  //: Nutrient Reference Value in mg (EU). Stored loosely because the
  //: source spreadsheet mixes numerics with "N/A" cells — unparseable
  //: values surface as ``null`` via :func:`computeNrvPercent`.
  readonly nrv_mg?: string | number | null;
}

export interface ComputeLineInput {
  readonly externalId: string;
  readonly attributes: ItemAttributesForMath;
  readonly labelClaimMg: number;
  readonly servingSizeOverride?: number | null;
  //: Per-line overrides for the catalogue's purity/overage/extract
  //: cascade. Null (or undefined) means "use the catalogue value".
  readonly purityOverride?: number | null;
  readonly overageOverride?: number | null;
  readonly extractRatioOverride?: number | null;
  //: Raw-material display name. Falls back here when
  //: ``attributes.ingredient_list_name`` is blank.
  readonly fallbackName?: string;
}

export type LineFailureReason =
  | "missing_claim"
  | "missing_purity"
  | "missing_extract_ratio";

export interface LineComputation {
  readonly mgPerServing: number | null;
  readonly failureReason: LineFailureReason | null;
}

export interface ExcipientRow {
  readonly slug: string;
  readonly label: string;
  readonly mg: number;
  readonly isRemainder: boolean;
  /** Concentration in mg per gram of finished powder. Populated for
   *  powder flavour rows that scale with the powder's mass per
   *  serving (per-scoop fill weight × scoops per serving); null for
   *  gummy and static excipients. */
  readonly concentrationMgPerGPowder?: number | null;
  /** Concentration in mg per ml of reconstitution water. Populated
   *  for powder acidity-regulator rows, which scale with
   *  ``water_volume_ml`` and the catalogue item's per-item dose rate
   *  rather than per gram of powder. Drives the inline ``(0.1 mg/ml)``
   *  hint next to each acidity row so the scientist can see the
   *  formula behind the computed mg. ``null`` for every other row. */
  readonly concentrationMgPerMlWater?: number | null;
  /** Canonical ``use_as`` from the source catalogue item — drives
   *  EU 1169 grouping when this row flows into the ingredient
   *  declaration ("Gelling Agent (Pectin)"). Blank for synthetic
   *  placeholder rows. */
  readonly useAs?: string;
  readonly isAllergen?: boolean;
  readonly allergenSource?: string;
}

export interface ExcipientBreakdown {
  readonly mgStearateMg: number;
  readonly silicaMg: number;
  readonly mccMg: number;
  readonly dcpMg: number | null;
  /** Gummy-only TOTAL base weight. ``target − water − actives −
   *  flavour`` clamped at zero, with a 65% floor enforced via
   *  :attr:`Viability.codes`. ``null`` on every other dosage form. */
  readonly gummyBaseMg: number | null;
  /** Gummy-only: 5.5% of the target gummy weight (fixed). */
  readonly waterMg: number | null;
  /** Local ``Item.id`` for the SKU sourcing the water fraction, when
   *  one of the gummy-base picks is a water/aqua row. ``null`` when
   *  no water-named pick is present — the water row then renders as
   *  a generic synthetic entry without a code chip / PSP link. */
  readonly waterItemId: string | null;
  /** Display label for the water row, pulled from the sourcing pick
   *  when present so procurement sees the exact SKU. Falls back to
   *  "Deionised Water (gummy base)" when no water-named pick is
   *  selected. */
  readonly waterLabel: string;
  /** Per-item breakdown of the blended gummy base. Empty when no
   *  items picked; total is split equally across picks. */
  readonly gummyBaseRows: readonly GummyBaseRow[];
  /** Powder / gummy flexible list. Empty for capsule + tablet. */
  readonly rows: readonly ExcipientRow[];
}


export interface GummyBaseRow {
  readonly itemId: string;
  readonly label: string;
  /** Canonical ``use_as`` category (Sweeteners / Bulking Agent). */
  readonly useAs: string;
  /** Equal share of the total base weight (total / number of picks). */
  readonly mg: number;
}

export interface Viability {
  readonly fits: boolean;
  readonly comfortOk: boolean;
  readonly codes: readonly string[];
}

export interface FormulationTotals {
  readonly totalActiveMg: number;
  readonly dosageForm: DosageForm;
  readonly sizeKey: string | null;
  readonly sizeLabel: string | null;
  readonly maxWeightMg: number | null;
  readonly totalWeightMg: number | null;
  readonly excipients: ExcipientBreakdown | null;
  readonly viability: Viability;
  readonly warnings: readonly string[];
  /** Per-line mg/serving keyed by the caller's external id. */
  readonly lineValues: ReadonlyMap<string, number>;
  /** Per-line failure reasons so the UI can flag broken rows. */
  readonly lineFailures: ReadonlyMap<string, LineFailureReason>;
}

// ---------------------------------------------------------------------------
// Attribute parsing helpers — text columns need tolerant coercion because
// the raw materials catalogue stores purity / extract ratio as text when
// the source spreadsheet mixes numbers and ``N/A`` cells.
// ---------------------------------------------------------------------------

function coerceFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isBotanical(attrs: ItemAttributesForMath): boolean {
  const type = attrs.type;
  if (typeof type !== "string") return false;
  return type.trim().toLowerCase() === "botanical";
}


/**
 * Nutrient Reference Value percentage for a single line.
 *
 * Returns ``(label_claim_mg / nrv_mg) * 100`` when the raw material
 * carries a parseable ``nrv_mg`` attribute. Surfaces ``null`` for
 * every edge case — missing attribute, ``"N/A"`` sentinel, zero /
 * negative NRV — so the caller can render a ``—`` instead of a
 * misleading ``Infinity`` or ``0``.
 */
export function computeNrvPercent(
  attributes: ItemAttributesForMath,
  labelClaimMg: number,
): number | null {
  if (!Number.isFinite(labelClaimMg) || labelClaimMg <= 0) return null;
  const nrv = coerceFloat(attributes.nrv_mg);
  if (nrv === null || nrv <= 0) return null;
  return (labelClaimMg / nrv) * 100;
}

/**
 * Return the raw NRV target in milligrams for a material — i.e. the
 * label claim that would land exactly at 100% NRV. ``null`` for
 * ingredients without a declared NRV (herbs, extracts, excipients).
 */
export function getNrvTargetMg(
  attributes: ItemAttributesForMath,
): number | null {
  const nrv = coerceFloat(attributes.nrv_mg);
  if (nrv === null || nrv <= 0) return null;
  return nrv;
}

// ---------------------------------------------------------------------------
// Line math — Table3 ``mg/serving`` formula
// ---------------------------------------------------------------------------

export interface LineOverrides {
  readonly purityOverride?: number | null;
  readonly overageOverride?: number | null;
  readonly extractRatioOverride?: number | null;
}

export function computeLine(
  attributes: ItemAttributesForMath,
  labelClaimMg: number,
  servingSize: number,
  overrides: LineOverrides = {},
): LineComputation {
  if (!Number.isFinite(labelClaimMg) || labelClaimMg <= 0) {
    return { mgPerServing: null, failureReason: "missing_claim" };
  }
  if (servingSize <= 0) {
    return { mgPerServing: null, failureReason: "missing_claim" };
  }

  const perUnitClaim = labelClaimMg / servingSize;

  if (isBotanical(attributes)) {
    const extractRatio =
      typeof overrides.extractRatioOverride === "number" &&
      Number.isFinite(overrides.extractRatioOverride)
        ? overrides.extractRatioOverride
        : coerceFloat(attributes.extract_ratio);
    if (extractRatio === null || extractRatio <= 0) {
      return { mgPerServing: null, failureReason: "missing_extract_ratio" };
    }
    return { mgPerServing: perUnitClaim / extractRatio, failureReason: null };
  }

  const purity =
    typeof overrides.purityOverride === "number" &&
    Number.isFinite(overrides.purityOverride)
      ? overrides.purityOverride
      : coerceFloat(attributes.purity);
  if (purity === null || purity <= 0) {
    return { mgPerServing: null, failureReason: "missing_purity" };
  }
  let raw = perUnitClaim / purity;
  const overage =
    typeof overrides.overageOverride === "number" &&
    Number.isFinite(overrides.overageOverride)
      ? overrides.overageOverride
      : coerceFloat(attributes.overage);
  if (overage !== null && overage > 0) {
    raw = raw + raw * overage;
  }
  return { mgPerServing: raw, failureReason: null };
}

/**
 * Pre-check a raw material to see whether it has the fields the math
 * cascade needs. Used by the picker to disable unusable ingredients
 * before they enter the builder.
 */
export function canComputeMaterial(
  attributes: ItemAttributesForMath,
): LineFailureReason | null {
  if (isBotanical(attributes)) {
    const extractRatio = coerceFloat(attributes.extract_ratio);
    return extractRatio === null || extractRatio <= 0
      ? "missing_extract_ratio"
      : null;
  }
  const purity = coerceFloat(attributes.purity);
  return purity === null || purity <= 0 ? "missing_purity" : null;
}


/**
 * Produce a short human-readable breakdown of the computed
 * ``mg/serving`` value, suitable for inline display under the
 * number in the builder. Returns ``null`` when the line did not
 * compute (zero claim, missing data) so the caller can hide the
 * hint row entirely.
 *
 * Examples:
 *   100 mg label × 10:1 extract → ``"100 / 10:1 extract"``
 *   10 mg label with 3% overage → ``"10 × 1.03 (3% overage)"``
 *   200 mg label ÷ 98% purity × 1.10 → ``"200 / 0.98 × 1.10 (10% overage)"``
 */
export function explainLine(
  attributes: ItemAttributesForMath,
  labelClaimMg: number,
  overrides: LineOverrides = {},
): string | null {
  if (!Number.isFinite(labelClaimMg) || labelClaimMg <= 0) return null;

  if (isBotanical(attributes)) {
    const extractRatio =
      typeof overrides.extractRatioOverride === "number" &&
      Number.isFinite(overrides.extractRatioOverride)
        ? overrides.extractRatioOverride
        : coerceFloat(attributes.extract_ratio);
    if (extractRatio === null || extractRatio <= 0) return null;
    const overrideTag =
      typeof overrides.extractRatioOverride === "number" ? "*" : "";
    return `${formatNumber(labelClaimMg)} / ${formatNumber(extractRatio)}${overrideTag}:1 extract`;
  }

  const purityOverridden =
    typeof overrides.purityOverride === "number" &&
    Number.isFinite(overrides.purityOverride);
  const overageOverridden =
    typeof overrides.overageOverride === "number" &&
    Number.isFinite(overrides.overageOverride);
  const purity = purityOverridden
    ? overrides.purityOverride!
    : coerceFloat(attributes.purity);
  if (purity === null || purity <= 0) return null;
  const overage = overageOverridden
    ? overrides.overageOverride!
    : coerceFloat(attributes.overage);

  const parts: string[] = [formatNumber(labelClaimMg)];
  if (purity !== 1) {
    parts.push(
      `/ ${formatNumber(purity)}${purityOverridden ? "*" : ""} purity`,
    );
  }
  if (overage !== null && overage > 0) {
    parts.push(
      `× ${formatNumber(1 + overage)}${overageOverridden ? "*" : ""} (${formatPercent(overage)} overage)`,
    );
  }
  // If neither purity nor overage changed the value, there's nothing
  // interesting to show — the label claim IS the raw mg.
  if (parts.length === 1) return null;
  return parts.join(" ");
}


function formatNumber(value: number): string {
  // Short compact form: 0 fraction digits for whole numbers, up to
  // 4 for fractional ones.
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(4).replace(/\.?0+$/, "");
}


function formatPercent(fraction: number): string {
  const pct = fraction * 100;
  if (Number.isInteger(pct)) return `${pct}%`;
  return `${pct.toFixed(1).replace(/\.?0+$/, "")}%`;
}


// ---------------------------------------------------------------------------
// F2a — compliance aggregation (mirror of apps.formulations.services.
// compute_compliance). "Non-X" or "No"/"False" are the only confidently
// non-compliant values; any other non-empty string is compliant by the
// catalogue's convention.
// ---------------------------------------------------------------------------


export interface ComplianceFlagResult {
  readonly key: ComplianceFlagKey;
  readonly label: string;
  /** ``true`` = product is compliant, ``false`` = tainted by at least
   * one ingredient, ``null`` = no confident answer (all unknowns). */
  readonly status: boolean | null;
  readonly compliantCount: number;
  readonly nonCompliantCount: number;
  readonly unknownCount: number;
}


export interface ComplianceResult {
  readonly flags: readonly ComplianceFlagResult[];
}


function normalizeComplianceValue(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const lowered = raw.trim().toLowerCase();
  if (!lowered) return null;
  if (lowered.startsWith("non-") || lowered === "no" || lowered === "false") {
    return false;
  }
  if (lowered === "yes" || lowered === "true") return true;
  return true;
}


export function computeCompliance(
  lines: readonly { readonly attributes: ItemAttributesForMath }[],
): ComplianceResult {
  return {
    flags: COMPLIANCE_FLAGS.map(({ key, label }) => {
      let compliant = 0;
      let nonCompliant = 0;
      let unknown = 0;
      for (const line of lines) {
        const decision = normalizeComplianceValue(line.attributes[key]);
        if (decision === true) compliant += 1;
        else if (decision === false) nonCompliant += 1;
        else unknown += 1;
      }
      let status: boolean | null;
      if (nonCompliant > 0) status = false;
      else if (compliant > 0) status = true;
      else status = null;
      return {
        key,
        label,
        status,
        compliantCount: compliant,
        nonCompliantCount: nonCompliant,
        unknownCount: unknown,
      };
    }),
  };
}


// ---------------------------------------------------------------------------
// Allergen aggregation — mirror of
// apps.formulations.services.compute_allergens
// ---------------------------------------------------------------------------


export interface AllergensResult {
  /** Distinct allergen classes across actives, sorted alphabetically.
   * Empty when the product has no allergenic ingredients — the UI
   * suppresses the whole Allergens line in that case. */
  readonly sources: readonly string[];
  /** Count of actives flagged as allergens. Can exceed
   * ``sources.length`` when two ingredients share a class. */
  readonly allergenCount: number;
}


/** Mirror of the backend's ``_is_item_allergen``. Reads the
 * ``allergen`` flag first; if the flag is blank but a populated
 * ``allergen_source`` names a real EU-14 class (wheat, milk, soy,
 * …) we treat the ingredient as allergenic. Catalogue rows in the
 * wild very often carry the source but leave the flag blank, so
 * leaning only on the flag would under-report on real products
 * (e.g. a wheat-extract Testosterone booster showing "no allergens").
 */
export function isAllergenLine(attrs: ItemAttributesForMath): boolean {
  const raw = attrs.allergen;
  if (raw !== null && raw !== undefined) {
    if (typeof raw === "string") {
      const lowered = raw.trim().toLowerCase();
      if (lowered === "yes" || lowered === "true" || lowered === "1") {
        return true;
      }
    } else if (Boolean(raw)) {
      return true;
    }
  }
  // Source-driven fallback — any non-sentinel class is treated as a
  // positive signal. An explicit ``allergen = "No"`` still wins via
  // the early exit above when the scientist deliberately overrode.
  return cleanAllergenSource(attrs).length > 0;
}


/** Normalise the ``allergen_source`` field. Catalogue rows use
 * ``"None"`` as the empty sentinel — we collapse that and
 * ``"#VALUE!"`` (a spreadsheet error artifact) to empty so the UI
 * never paints the word ``None`` as if it were an allergen class. */
export function cleanAllergenSource(attrs: ItemAttributesForMath): string {
  const raw = attrs.allergen_source;
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase() === "none" || trimmed === "#VALUE!") return "";
  return trimmed;
}


export function computeAllergens(
  lines: readonly { readonly attributes: ItemAttributesForMath }[],
): AllergensResult {
  const sources = new Set<string>();
  let count = 0;
  for (const line of lines) {
    if (!isAllergenLine(line.attributes)) continue;
    count += 1;
    const source = cleanAllergenSource(line.attributes);
    if (source) sources.add(source);
  }
  return {
    sources: Array.from(sources).sort(),
    allergenCount: count,
  };
}


// ---------------------------------------------------------------------------
// F2a — ingredient declaration (mirror of
// apps.formulations.services.build_ingredient_declaration)
// ---------------------------------------------------------------------------


//: Label strings must stay in sync with ``apps/formulations/constants.py``.
export const EXCIPIENT_LABEL_MCC = "Microcrystalline Cellulose (Carrier)";
export const EXCIPIENT_LABEL_MG_STEARATE = "Magnesium Stearate";
export const EXCIPIENT_LABEL_SILICA = "Silicon Dioxide";
export const EXCIPIENT_LABEL_DCP = "Dicalcium Phosphate";
export const CAPSULE_SHELL_LABEL = "Capsule Shell (Hypromellose)";
//: Mg Stearate + Silica are procured separately (different SKUs,
//: different suppliers) but collapse into a single ingredient-list
//: entry on the consumer-facing declaration, matching the workbook's
//: label copy and avoiding exposing unnecessary manufacturing detail
//: to clients.
export const EXCIPIENT_LABEL_ANTICAKING =
  "Anticaking Agents (Magnesium Stearate, Silicon Dioxide)";
export const EXCIPIENT_LABEL_GUMMY_BASE = "Gummy Base";
export const EXCIPIENT_LABEL_WATER = "Water";


export interface IngredientDeclarationEntry {
  readonly label: string;
  readonly mg: number;
  readonly category: "active" | "excipient" | "shell";
  /** ``true`` when the source catalogue row is flagged as an
   * allergen. The spec sheet bolds these names per EU 1169/2011
   * art. 21; the formulation builder's live panel does the same
   * so scientists see the final rendering before save. */
  readonly isAllergen: boolean;
  readonly allergenSource: string;
  /** Canonical ``use_as`` (``"Sweeteners"``, ``"Gelling Agent"``…)
   *  for the source catalogue item. Drives the EU 1169/2011 group
   *  bracket in the joined declaration string ("Gelling Agent
   *  (Pectin)"). Blank for synthetic excipients (MCC, anticaking,
   *  capsule shell) and actives — they sit standalone. */
  readonly useAs?: string;
}


export interface IngredientDeclaration {
  readonly text: string;
  readonly entries: readonly IngredientDeclarationEntry[];
}


export function buildIngredientDeclaration({
  lines,
  totals,
  mccCarrierPicks = [],
  dcpCarrierPicks = [],
  antiCakingPicks = [],
  capsuleShellPick = null,
}: {
  lines: readonly {
    readonly externalId: string;
    readonly attributes: ItemAttributesForMath;
    readonly fallbackName?: string;
  }[];
  totals: FormulationTotals;
  /** Names of items the scientist has ticked in the MCC-carrier
   *  picker. When non-empty, the "Microcrystalline Cellulose
   *  (Carrier)" placeholder is replaced with one entry per pick
   *  (name split, mass shared equally). Same shape for DCP and
   *  anti-caking. Empty array falls back to the canonical
   *  category label — the pre-picker legacy behaviour. */
  mccCarrierPicks?: readonly string[];
  dcpCarrierPicks?: readonly string[];
  antiCakingPicks?: readonly string[];
  /** Picked capsule shell (typically one — the M2M shape mirrors
   *  the other pickers). Non-null overrides the hardcoded
   *  ``CAPSULE_SHELL_LABEL`` + ``CAPSULE_SHELL_WEIGHTS[sizeKey]``
   *  with the pick's own name + ``shell_weight_mg`` from its
   *  attributes. Null / attributes missing → the hardcoded
   *  fallback path fires (legacy behaviour). */
  capsuleShellPick?: {
    readonly name: string;
    readonly shellWeightMg: number | null;
  } | null;
}): IngredientDeclaration {
  const entries: IngredientDeclarationEntry[] = [];

  for (const line of lines) {
    const mg = totals.lineValues.get(line.externalId);
    if (mg === undefined || mg <= 0) continue;
    const listName = line.attributes.ingredient_list_name;
    const label =
      typeof listName === "string" && listName.trim()
        ? listName.trim()
        : line.fallbackName ?? "";
    if (!label) continue;
    const isAllergen = isAllergenLine(line.attributes);
    entries.push({
      label,
      mg,
      category: "active",
      isAllergen,
      allergenSource: isAllergen ? cleanAllergenSource(line.attributes) : "",
    });
  }

  // One declaration entry per pick, equal mg split — falls back
  // to the canonical category label when the band has no picks.
  // Same logic the BOM uses for its excipient rows, kept as a
  // helper so the two views stay in lockstep.
  const pushBand = (
    totalMg: number,
    picks: readonly string[],
    placeholderLabel: string,
  ) => {
    if (totalMg <= 0) return;
    if (picks.length === 0) {
      entries.push({
        label: placeholderLabel,
        mg: totalMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
      return;
    }
    const perPickMg = totalMg / picks.length;
    for (const name of picks) {
      entries.push({
        label: name,
        mg: perPickMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
    }
  };

  const excipients = totals.excipients;
  if (excipients) {
    pushBand(excipients.mccMg, mccCarrierPicks, EXCIPIENT_LABEL_MCC);
    if (excipients.dcpMg !== null) {
      pushBand(excipients.dcpMg, dcpCarrierPicks, EXCIPIENT_LABEL_DCP);
    }
    // Mg Stearate + Silica collapse into a single "Anticaking
    // Agents" total on the consumer-facing declaration — same merge
    // the server's ``build_ingredient_declaration`` does. Combined
    // mg drives the sort order so the merged entry sits at the
    // right rank rather than each half landing at the bottom on
    // its own tiny weight. When picks exist the total splits across
    // them equally; empty picks keeps the pre-picker placeholder.
    const anticakingMg = excipients.mgStearateMg + excipients.silicaMg;
    pushBand(anticakingMg, antiCakingPicks, EXCIPIENT_LABEL_ANTICAKING);
    // Gummy-only: per-pick gummy base rows + water + the flexible
    // ``rows`` list (acidity, flavouring, colour, glazing, gelling,
    // premix sweetener). Each per-pick row carries its source
    // ``useAs`` so the formatter at the bottom of this function can
    // group them under their EU label category.
    if (excipients.gummyBaseRows.length > 0) {
      for (const r of excipients.gummyBaseRows) {
        if (r.mg <= 0) continue;
        entries.push({
          label: r.label,
          mg: r.mg,
          category: "excipient",
          isAllergen: false,
          allergenSource: "",
          useAs: r.useAs || "",
        });
      }
    } else if (excipients.gummyBaseMg !== null && excipients.gummyBaseMg > 0) {
      entries.push({
        label: EXCIPIENT_LABEL_GUMMY_BASE,
        mg: excipients.gummyBaseMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
    }
    if (excipients.waterMg !== null && excipients.waterMg > 0) {
      entries.push({
        label: EXCIPIENT_LABEL_WATER,
        mg: excipients.waterMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
    }
    for (const row of excipients.rows) {
      if (row.mg <= 0) continue;
      entries.push({
        label: row.label,
        mg: row.mg,
        category: "excipient",
        isAllergen: row.isAllergen ?? false,
        allergenSource: row.allergenSource ?? "",
        useAs: row.useAs ?? "",
      });
    }
  }

  if (totals.dosageForm === "capsule" && totals.sizeKey) {
    // Picked shell overrides both the label and the shell mass —
    // scientists procure a specific SKU, and the declaration should
    // print what's actually in the pack, not the pharmaceutical
    // placeholder. Fall back to the hardcoded map only when nothing
    // is picked (legacy formulations or the "still selecting" state).
    const shellWeight =
      capsuleShellPick?.shellWeightMg ??
      CAPSULE_SHELL_WEIGHTS[totals.sizeKey];
    const shellLabel = capsuleShellPick?.name ?? CAPSULE_SHELL_LABEL;
    if (shellWeight && shellWeight > 0) {
      entries.push({
        label: shellLabel,
        mg: shellWeight,
        category: "shell",
        isAllergen: false,
        allergenSource: "",
      });
    }
  }

  entries.sort((a, b) => b.mg - a.mg || a.label.localeCompare(b.label));
  return {
    text: formatGroupedDeclaration(entries),
    entries,
  };
}


/**
 * Mirror of ``_format_grouped_declaration`` on the server — groups
 * entries by canonical ``useAs`` so the joined string reads
 * ``"Sweeteners (Xylitol, Maltitol), Gelling Agent (Pectin)"``
 * rather than each pick rendering individually. Allergen entries
 * wrap in ``<b>`` tags for the spec-sheet HTML render path.
 */
function formatGroupedDeclaration(
  entries: readonly IngredientDeclarationEntry[],
): string {
  const escape = (raw: string): string =>
    raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const renderLabel = (e: IngredientDeclarationEntry): string => {
    const escaped = escape(e.label);
    return e.isAllergen ? `<b>${escaped}</b>` : escaped;
  };

  const groups = new Map<string, IngredientDeclarationEntry[]>();
  const standalone: IngredientDeclarationEntry[] = [];
  for (const entry of entries) {
    if (entry.useAs && entry.useAs !== "Active") {
      const list = groups.get(entry.useAs) ?? [];
      list.push(entry);
      groups.set(entry.useAs, list);
    } else {
      standalone.push(entry);
    }
  }

  const chunks: { leading: number; rendered: string }[] = [];
  for (const entry of standalone) {
    chunks.push({ leading: entry.mg, rendered: renderLabel(entry) });
  }
  for (const [category, members] of groups.entries()) {
    members.sort((a, b) => b.mg - a.mg || a.label.localeCompare(b.label));
    const leading = members[0]?.mg ?? 0;
    const names = members.map(renderLabel).join(", ");
    chunks.push({
      leading,
      rendered: `${escape(category)} (${names})`,
    });
  }
  chunks.sort((a, b) => b.leading - a.leading);
  return chunks.map((c) => c.rendered).join(", ");
}


// ---------------------------------------------------------------------------
// Size lookups
// ---------------------------------------------------------------------------

function capsuleSizeByKey(key: string | null): CapsuleSizeOption | null {
  if (!key) return null;
  return CAPSULE_SIZES.find((s) => s.key === key) ?? null;
}

function tabletSizeByKey(key: string | null): TabletSizeOption | null {
  if (!key) return null;
  return TABLET_SIZES.find((s) => s.key === key) ?? null;
}

function autoPickCapsuleSize(totalActiveMg: number): CapsuleSizeOption | null {
  for (const entry of CAPSULE_AUTO_PICK) {
    if (totalActiveMg < entry.threshold) {
      return capsuleSizeByKey(entry.key);
    }
  }
  return null;
}


/** One capsule-shell candidate for the PSP-backed auto-pick.
 *  Emitted by the compute caller from the org's PSP catalog (items
 *  with ``use_as = "capsule_shell"``) so auto-pick can consider
 *  supplier-specific fill capacities instead of falling back to the
 *  physics-reference ladder. */
export interface CapsuleShellCandidate {
  readonly uuid: string;
  readonly name: string;
  readonly code: string;
  readonly capsuleSize: string | null;
  readonly maxWeightMg: number;
}


/** Auto-pick against PSP's actual shell catalog. Returns the
 *  smallest shell whose ``max_weight_mg`` exceeds ``totalActiveMg``
 *  with the same ~21% headroom the hardcoded ladder gives (Size 1
 *  has 380 mg max but a 300 mg threshold — that headroom is what
 *  MCC carrier + anti-caking + variance fills). ``null`` when the
 *  catalog is empty or nothing fits.
 *
 *  Ordering: ascending by max_weight_mg. Duplicates (multiple
 *  suppliers of the same physical size) resolve on first-hit —
 *  fine for auto-pick since the operator will typically tick the
 *  authoritative supplier manually anyway. */
function autoPickFromPspCatalog(
  totalActiveMg: number,
  catalog: readonly CapsuleShellCandidate[],
): CapsuleShellCandidate | null {
  if (!catalog || catalog.length === 0) return null;
  const sorted = [...catalog]
    .filter((s) => Number.isFinite(s.maxWeightMg) && s.maxWeightMg > 0)
    .sort((a, b) => a.maxWeightMg - b.maxWeightMg);
  const HEADROOM = 0.79;
  for (const shell of sorted) {
    if (totalActiveMg < shell.maxWeightMg * HEADROOM) {
      return shell;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Totals block
// ---------------------------------------------------------------------------

const EMPTY_VIABILITY: Viability = {
  fits: false,
  comfortOk: false,
  codes: ["more_info_required"],
};

/** Substring patterns (case-insensitive) used to classify a picked
 *  anti-caking item. Mirrors ``_classify_anti_caking_picks`` on the
 *  server so the builder live preview matches the snapshot the spec
 *  sheet reads from. Anything that matches neither rule falls back
 *  to the lubricant band so a stray Talc / Calcium Silicate pick
 *  still produces a visible row instead of being silently ignored. */
const STEARATE_NAME_PATTERN = /stear/i;
const SILICA_NAME_PATTERN = /silic/i;

export function classifyAntiCakingPicks(
  items: ReadonlyArray<{ readonly label: string }>,
): { readonly stearate: boolean; readonly silica: boolean } {
  if (items.length === 0) return { stearate: false, silica: false };
  let stearate = false;
  let silica = false;
  let unmatched = false;
  for (const item of items) {
    const label = item.label || "";
    if (SILICA_NAME_PATTERN.test(label)) {
      silica = true;
    } else if (STEARATE_NAME_PATTERN.test(label)) {
      stearate = true;
    } else {
      unmatched = true;
    }
  }
  if (unmatched && !stearate) stearate = true;
  return { stearate, silica };
}


function computeCapsule(
  totalActive: number,
  requestedSizeKey: string | null,
  hasMccCarrier: boolean,
  hasStearateAntiCaking: boolean,
  hasSilicaAntiCaking: boolean,
  excipientOverrides: Readonly<Record<string, number>> | null | undefined,
  /** When a capsule shell is picked, its own attributes drive the
   *  fill capacity + shell mass — no per-size lookup. Overrides
   *  the hardcoded ``CAPSULE_SIZES`` map entirely for the picked
   *  path; the map only kicks in on legacy "no shell picked"
   *  auto-pick where we have no data to read. Nullable fields
   *  fall through the individual override cleanly (a shell that
   *  sets only ``capsule_size`` on PSP still gets the physics-
   *  reference max fill from the map). */
  shellOverride?: {
    readonly sizeKey?: string | null;
    readonly maxWeightMg?: number | null;
  } | null,
  /** PSP capsule-shell catalog for the org (items tagged
   *  ``use_as = "capsule_shell"`` with a ``max_weight_mg``
   *  attribute). Auto-pick prefers this over the hardcoded
   *  ``CAPSULE_SIZES`` ladder so the picked size reflects the
   *  supplier catalog the operator actually has to procure from.
   *  Empty / omitted → falls back to the ladder (matches pre-
   *  catalog behaviour for orgs without PSP or without any
   *  classified shells). */
  capsuleShellCatalog?: readonly CapsuleShellCandidate[] | null,
): {
  sizeKey: string | null;
  sizeLabel: string | null;
  maxWeight: number | null;
  totalWeight: number | null;
  excipients: ExcipientBreakdown | null;
  viability: Viability;
  warnings: readonly string[];
} {
  const warnings: string[] = [];

  let size: CapsuleSizeOption | null = null;
  const overrideSizeKey =
    shellOverride?.sizeKey && shellOverride.sizeKey.trim()
      ? shellOverride.sizeKey.trim()
      : null;
  const overrideMaxWeightMg =
    typeof shellOverride?.maxWeightMg === "number" &&
    Number.isFinite(shellOverride.maxWeightMg) &&
    shellOverride.maxWeightMg > 0
      ? shellOverride.maxWeightMg
      : null;

  // Strict mode: compute requires a picked shell with data. No
  // ``CAPSULE_SIZES`` auto-pick, no ``metadata.capsule_size``
  // legacy fallback. Physics constants aren't the source of truth
  // for a formulation — the shell the operator will actually
  // procure is. When neither the shell's ``max_weight_mg`` nor
  // ``capsule_size`` are set (freshly-added item without
  // attributes populated, or nothing picked at all), viability
  // reports ``pick_capsule_shell`` and compute stops.
  const overrideProvided =
    (overrideSizeKey ?? null) !== null || overrideMaxWeightMg !== null;

  if (overrideProvided && overrideMaxWeightMg) {
    // Prefer the picked shell's fill capacity. If ``capsule_size``
    // matches a standard key we borrow its label ("Single 0", etc.)
    // for display; otherwise fall back to the raw key or "Custom".
    const fromMap = overrideSizeKey ? capsuleSizeByKey(overrideSizeKey) : null;
    size = {
      key: overrideSizeKey ?? "custom",
      label: fromMap?.label ?? overrideSizeKey ?? "Custom",
      max_weight_mg: overrideMaxWeightMg,
    };
  } else if (overrideProvided && overrideSizeKey && !overrideMaxWeightMg) {
    // Shell picked with a ``capsule_size`` but no explicit
    // ``max_weight_mg``. Fall through to the CAPSULE_SIZES physics
    // reference table using the size key — matches the pre-strict
    // behaviour (and the file-level comment on ``shellOverride``:
    // "a shell that sets only capsule_size still gets the physics-
    // reference max fill from the map"). If the size key is a non-
    // standard value that the map doesn't know, surface the gap so
    // procurement / R&D can populate max_weight_mg on the PSP row.
    const fromMap = capsuleSizeByKey(overrideSizeKey);
    if (fromMap) {
      size = {
        key: overrideSizeKey,
        label: fromMap.label,
        max_weight_mg: fromMap.max_weight_mg,
      };
      // Advisory: the shell should really carry its own
      // ``max_weight_mg`` since real fill capacity varies by
      // supplier + material. The warning stays soft — compute
      // proceeds against the physics-reference value.
      warnings.push("capsule_shell_max_weight_from_map");
    } else {
      warnings.push("capsule_shell_missing_max_weight");
      return {
        sizeKey: null,
        sizeLabel: null,
        maxWeight: null,
        totalWeight: null,
        excipients: null,
        viability: { fits: false, comfortOk: false, codes: ["cannot_make"] },
        warnings,
      };
    }
  } else if (requestedSizeKey) {
    // No shell attributes — but the operator has picked a
    // ``capsule_size`` explicitly (legacy metadata field, or a
    // ticked shell whose PSP row is missing both attributes and
    // where the caller has echoed the size). Look it up in the
    // physics-reference table and compute against that.
    const fromMap = capsuleSizeByKey(requestedSizeKey);
    if (fromMap) {
      size = {
        key: requestedSizeKey,
        label: fromMap.label,
        max_weight_mg: fromMap.max_weight_mg,
      };
    } else {
      warnings.push("pick_capsule_shell");
      return {
        sizeKey: null,
        sizeLabel: null,
        maxWeight: null,
        totalWeight: null,
        excipients: null,
        viability: { fits: false, comfortOk: false, codes: ["cannot_make"] },
        warnings,
      };
    }
  } else {
    // No shell picked AND no explicit size — try PSP's actual
    // capsule-shell catalog first, then fall through to the
    // hardcoded physics ladder if the catalog is empty. Preferring
    // the catalog means auto-pick reflects the supplier stock the
    // operator will really procure from, not a synthetic Excel-
    // sourced size.
    const fromPsp = autoPickFromPspCatalog(
      totalActive,
      capsuleShellCatalog ?? [],
    );
    if (fromPsp) {
      size = {
        // Prefer a known key from the physics table (so downstream
        // consumers that look up ``size.key`` in CAPSULE_SIZES for
        // the label still find it). Fallback to "custom" when the
        // shell's capsule_size doesn't map to a standard entry.
        key: fromPsp.capsuleSize && capsuleSizeByKey(fromPsp.capsuleSize)
          ? fromPsp.capsuleSize
          : "custom",
        label: fromPsp.capsuleSize
          ? capsuleSizeByKey(fromPsp.capsuleSize)?.label ?? fromPsp.name
          : fromPsp.name,
        max_weight_mg: fromPsp.maxWeightMg,
      };
      // Soft advisory: identify the auto-picked shell so the
      // operator can lock it manually in the Excipients picker.
      // Interpolation payload lives on the warning code; the FE's
      // ``resolveWarningLabel`` formatter reads it.
      // Warning payload format: ``auto_picked_psp_shell:<label>``
      // where <label> is a human-readable "Name (CODE)" string.
      // The FE viability panel splits on the first colon and feeds
      // the tail into the i18n label as ``{name}``.
      const label = fromPsp.code
        ? `${fromPsp.name} (${fromPsp.code})`
        : fromPsp.name;
      warnings.push(`auto_picked_psp_shell:${label}`);
    } else {
      const auto = autoPickCapsuleSize(totalActive);
      if (auto === null) {
        warnings.push("capsule_too_large");
        return {
          sizeKey: null,
          sizeLabel: null,
          maxWeight: null,
          totalWeight: null,
          excipients: null,
          viability: { fits: false, comfortOk: false, codes: ["cannot_make"] },
          warnings,
        };
      }
      size = auto;
      warnings.push("pick_capsule_shell");
    }
  }

  if (size === null) {
    return {
      sizeKey: null,
      sizeLabel: null,
      maxWeight: null,
      totalWeight: null,
      excipients: null,
      viability: { fits: false, comfortOk: false, codes: ["cannot_make"] },
      warnings,
    };
  }

  // Anti-caking is opt-in AND classified per pick: picking only
  // Silicon Dioxide fires the 0.4% silica band and nothing else;
  // picking only Magnesium Stearate fires the 1.0% lubricant band;
  // picking both lights up the full 1.4% combined. Carrier (MCC) is
  // also opt-in: empty picker leaves an under-filled capsule of pure
  // actives instead of inventing a placeholder MCC remainder.
  // Mirrors the server gating exactly so the builder live preview
  // matches the snapshot the spec sheet reads from.
  const stearatePct = resolveBandPct("mg_stearate", excipientOverrides);
  const silicaPct = resolveBandPct("silica", excipientOverrides);
  const stearate = hasStearateAntiCaking ? totalActive * stearatePct : 0;
  const silica = hasSilicaAntiCaking ? totalActive * silicaPct : 0;
  const mcc = hasMccCarrier
    ? size.max_weight_mg - totalActive - stearate - silica
    : 0;

  let totalWeight: number;
  if (!hasMccCarrier) {
    // No carrier picked → pure actives (+ anti-caking, if picked).
    totalWeight = totalActive + stearate + silica;
  } else if (mcc >= 0) {
    totalWeight = totalActive + stearate + silica + mcc;
  } else {
    totalWeight = totalActive + stearate + silica;
  }

  const fits = size.max_weight_mg >= totalWeight;
  // Comfort criterion only matters when a carrier is present (it's
  // the carrier headroom we'd be measuring); without a carrier the
  // formulation is "compact by design" and we just report fits/cant.
  const comfortOk =
    fits && (!hasMccCarrier || mcc >= totalActive * 0.01);
  const codes: string[] = [];
  if (!fits) {
    codes.push("cannot_make");
  } else {
    codes.push("can_make");
    if (comfortOk) {
      codes.push("less_challenging", "proceed_to_quote");
    } else {
      codes.push("more_challenging_to_make", "consult_r_and_d");
    }
  }

  return {
    sizeKey: size.key,
    sizeLabel: size.label,
    maxWeight: size.max_weight_mg,
    totalWeight,
    excipients: {
      mgStearateMg: stearate,
      silicaMg: silica,
      mccMg: mcc,
      dcpMg: null,
      gummyBaseMg: null,
      waterMg: null,
      waterItemId: null,
      waterLabel: "Deionised Water (gummy base)",
      gummyBaseRows: [],
      rows: [],
    },
    viability: { fits, comfortOk, codes },
    warnings,
  };
}

function computeTablet(
  totalActive: number,
  requestedSizeKey: string | null,
  hasMccCarrier: boolean,
  hasDcpCarrier: boolean,
  hasStearateAntiCaking: boolean,
  hasSilicaAntiCaking: boolean,
  excipientOverrides: Readonly<Record<string, number>> | null | undefined,
): {
  sizeKey: string | null;
  sizeLabel: string | null;
  maxWeight: number | null;
  totalWeight: number;
  excipients: ExcipientBreakdown;
  viability: Viability;
  warnings: readonly string[];
} {
  // Each band is gated on its own picker. Anti-caking is opt-in AND
  // classified per pick (silica-only -> 0.4%, stearate-only -> 1.0%,
  // both -> 1.4%). MCC and DCP carriers opt-in. A scientist can ship
  // pure actives by leaving all pickers empty, or actives + carriers
  // without lubricants. Mirrors the server gating so the builder live
  // preview matches the snapshot the spec sheet renders from.
  const stearatePct = resolveBandPct("mg_stearate", excipientOverrides);
  const silicaPct = resolveBandPct("silica", excipientOverrides);
  const dcpPct = resolveBandPct("dcp", excipientOverrides);
  const mccPct = resolveBandPct("mcc", excipientOverrides);
  const stearate = hasStearateAntiCaking ? totalActive * stearatePct : 0;
  const silica = hasSilicaAntiCaking ? totalActive * silicaPct : 0;
  const dcp = hasDcpCarrier ? totalActive * dcpPct : 0;
  const mcc = hasMccCarrier ? totalActive * mccPct : 0;
  const totalWeight = totalActive + stearate + silica + dcp + mcc;

  const excipients: ExcipientBreakdown = {
    mgStearateMg: stearate,
    silicaMg: silica,
    mccMg: mcc,
    dcpMg: dcp,
    gummyBaseMg: null,
    waterMg: null,
    waterItemId: null,
    waterLabel: "Deionised Water (gummy base)",
    gummyBaseRows: [],
    rows: [],
  };

  if (!requestedSizeKey) {
    return {
      sizeKey: null,
      sizeLabel: null,
      maxWeight: null,
      totalWeight,
      excipients,
      viability: {
        fits: false,
        comfortOk: false,
        codes: ["tablet_size_required"],
      },
      warnings: [],
    };
  }

  const size = tabletSizeByKey(requestedSizeKey);
  if (size === null) {
    return {
      sizeKey: null,
      sizeLabel: null,
      maxWeight: null,
      totalWeight,
      excipients,
      viability: {
        fits: false,
        comfortOk: false,
        codes: ["tablet_size_required"],
      },
      warnings: [],
    };
  }

  const fits = size.max_weight_mg >= totalWeight;
  const comfortOk = fits && totalWeight <= size.max_weight_mg * 0.75;
  const codes: string[] = [];
  if (!fits) {
    codes.push("cannot_make");
  } else {
    codes.push("can_make");
    if (comfortOk) {
      codes.push("less_challenging", "proceed_to_quote");
    } else {
      codes.push("more_challenging_to_make", "consult_r_and_d");
    }
  }

  return {
    sizeKey: size.key,
    sizeLabel: size.label,
    maxWeight: size.max_weight_mg,
    totalWeight,
    excipients,
    viability: { fits, comfortOk, codes },
    warnings: [],
  };
}

function formatFillWeight(mg: number): string {
  if (mg >= 1000) return `${(mg / 1000).toFixed(2)}g`;
  return `${Math.round(mg)}mg`;
}

/** Fill-weight reconciliation for powder + gummy. Mirrors
 * ``_compute_fill_target`` on the Python side. The scientist adds
 * the carrier / bulking agent / gummy base as a real catalogue line;
 * this function only checks whether the line sum matches the sachet
 * / gummy target and surfaces a shortfall or overshoot warning. */
function computeFillTarget(
  dosageForm: "powder" | "gummy",
  totalActive: number,
  targetFillWeightMg: number | null,
  powderType: PowderType | null | undefined,
  waterVolumeMl: number | null | undefined,
  gummyBaseItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }> = [],
  flavouringItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
    /** Per-item mg of flavouring per gram of finished powder.
     *  Sourced from the catalogue item's
     *  ``powder_flavouring_mg_per_g`` attribute. ``null`` / ``0``
     *  -> skip + warn (powder-only; gummy ignores this field). */
    readonly powderRateMgPerG?: number | null;
  }> = [],
  colourItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
    /** Per-item mg of colour per gram of finished powder. Sourced
     *  from ``powder_colour_mg_per_g``. ``null`` / ``0`` -> skip
     *  + warn. */
    readonly powderRateMgPerG?: number | null;
  }> = [],
  glazingItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }> = [],
  gellingItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }> = [],
  premixSweetenerItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }> = [],
  acidityItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
    /** Per-item mg of acid per ml of reconstitution water. Sourced
     *  from the catalogue item's ``powder_water_dose_mg_per_ml``
     *  attribute. ``null``/``undefined``/``0`` -> the row is skipped
     *  and a ``powder_acidity_dose_missing`` warning fires for this
     *  pick. Powder-only; ignored for gummy formulations. */
    readonly waterDoseMgPerMl?: number | null;
  }> = [],
  sweetenerItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
    /** Per-item mg of sweetener per gram of finished powder. Sourced
     *  from ``powder_sweetener_mg_per_g``. ``null`` / ``0`` -> skip
     *  + warn. Gummy formulations consume sweeteners under the
     *  gummy_base pool and ignore this field. */
    readonly powderRateMgPerG?: number | null;
  }> = [],
  antiCakingItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }> = [],
  powderCarrierItems: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }> = [],
  excipientOverrides: Readonly<Record<string, number>> | null | undefined =
    null,
  defaultServingSize: number = 1,
): {
  sizeKey: string | null;
  sizeLabel: string | null;
  maxWeight: number | null;
  totalWeight: number | null;
  excipients: ExcipientBreakdown | null;
  viability: Viability;
  warnings: readonly string[];
} {
  // Powder flavour rows are mg per **gram of finished powder** —
  // multiply by the powder's mass per serving (per-scoop fill weight ×
  // scoops per serving) to produce the per-serving mg, exactly the
  // same way Excel's Formulation Calculation Sheet sums the BOM
  // (per-gram column × Serving Size). Gummy rows scale by percentage
  // of target weight; both forms now respond linearly to changes in
  // the finished product's mass.
  //
  // Powder branch may surface soft warnings (e.g. an acidity pick
  // missing a dose rate, or a powder configured with acidity picks
  // but no water volume). They are accumulated here and merged into
  // the final ``warnings`` tuple after the viability check so the
  // builder shows them alongside fill-weight feedback. Mirrors the
  // ``pre_warnings`` accumulator on the Python side.
  const preWarnings: string[] = [];
  const flavourRows: ExcipientRow[] =
    dosageForm === "powder"
      ? (() => {
          // Every powder excipient band is now opt-in via its
          // picker (flavouring / sweetener / colour / acidity /
          // anti-caking / carrier). The hardcoded preset mg/g
          // values still drive each band's mg total so picks fire
          // at the Excel-derived rate, but empty pickers drop the
          // band entirely instead of leaving a phantom placeholder.
          // Mirrors the server gating in _compute_fill_target.
          const preset = powderFlavourSystemFor(powderType);
          const fillWeightMg =
            targetFillWeightMg && targetFillWeightMg > 0
              ? targetFillWeightMg
              : POWDER_DEFAULT_FILL_WEIGHT_MG;
          const scoops =
            defaultServingSize && defaultServingSize > 0
              ? defaultServingSize
              : 1;
          const powderGPerServing = (fillWeightMg / 1000) * scoops;

          const rows: ExcipientRow[] = [];
          const emitPowderBand = (
            blockSlug: string,
            blockLabel: string,
            blockTotalMg: number,
            picks: ReadonlyArray<{
              readonly id: string;
              readonly label: string;
              readonly useAs?: string;
            }>,
            mgPerGPowder: number | null,
          ) => {
            if (blockTotalMg <= 0 || picks.length === 0) return;
            const perItem = blockTotalMg / picks.length;
            const perItemConcentration =
              mgPerGPowder !== null && picks.length > 0
                ? mgPerGPowder / picks.length
                : null;
            for (const pick of picks) {
              rows.push({
                slug: `${blockSlug}:${pick.id}`,
                label: pick.label,
                mg: perItem,
                isRemainder: false,
                useAs: pick.useAs ?? "",
                concentrationMgPerGPowder: perItemConcentration,
              });
            }
          };

          // Powder Flavouring / Sweetener / Colour all use the
          // per-item rate model: each picked item carries its own
          // ``mg per g of powder`` loading on the catalogue, so a
          // Cocoa Powder at 50 mg/g and a Vanilla Extract at 5 mg/g
          // sit in the same band at their own doses. Items missing
          // a rate fall out with a ``powder_<band>_rate_missing``
          // warning -- mirrors the acidity pattern below.
          const perItemBands: ReadonlyArray<{
            readonly slug: "flavouring" | "sweetener" | "colour";
            readonly useAs: string;
            readonly picks: ReadonlyArray<{
              readonly id: string;
              readonly label: string;
              readonly useAs: string;
              readonly powderRateMgPerG?: number | null;
            }>;
          }> = [
            {
              slug: "flavouring",
              useAs: "Flavouring",
              picks: flavouringItems,
            },
            {
              slug: "sweetener",
              useAs: "Sweeteners",
              picks: sweetenerItems,
            },
            {
              slug: "colour",
              useAs: "Colour",
              picks: colourItems,
            },
          ];
          // Unified water-volume dosing for every per-item powder
          // band -- ACIDITY uses ``waterDoseMgPerMl``, the other three
          // bands carry ``powderRateMgPerG`` (kept for naming, but the
          // unit semantics are identical now: mg per ml of water).
          // Same multiplier across the board so the scientist tunes
          // every band to a target concentration in the reconstituted
          // drink rather than a per-gram-of-powder loading.
          const waterMl =
            waterVolumeMl !== null &&
            waterVolumeMl !== undefined &&
            Number.isFinite(waterVolumeMl)
              ? waterVolumeMl
              : 0;
          const anyPerItemPicks =
            acidityItems.length > 0 ||
            flavouringItems.length > 0 ||
            sweetenerItems.length > 0 ||
            colourItems.length > 0;
          if (anyPerItemPicks && waterMl <= 0) {
            preWarnings.push("powder_flavour_water_volume_missing");
          }
          const allPerItemBands: ReadonlyArray<{
            readonly slug:
              | "acidity"
              | "flavouring"
              | "sweetener"
              | "colour";
            readonly useAs: string;
            readonly picks: ReadonlyArray<{
              readonly id: string;
              readonly label: string;
              readonly useAs: string;
              readonly powderRateMgPerG?: number | null;
              readonly waterDoseMgPerMl?: number | null;
            }>;
          }> = [
            {
              slug: "acidity",
              useAs: "Acidity Regulator",
              picks: acidityItems,
            },
            ...perItemBands,
          ];
          for (const band of allPerItemBands) {
            for (const pick of band.picks) {
              // Direct per-item mg override — takes precedence over
              // both the ``powder_rate:`` rate override and the
              // catalogue rate. Same key the capsule-band editor
              // uses (``excipient_mg:<id>``) so a single Fine-tune
              // input drives both dosing models.
              const mgOverrideRaw = excipientOverrides?.[
                `excipient_mg:${pick.id}`
              ];
              if (
                mgOverrideRaw !== undefined &&
                mgOverrideRaw !== null &&
                Number.isFinite(mgOverrideRaw) &&
                mgOverrideRaw >= 0
              ) {
                rows.push({
                  slug: `${band.slug}:${pick.id}`,
                  label: pick.label,
                  mg: mgOverrideRaw,
                  isRemainder: false,
                  useAs: pick.useAs || band.useAs,
                  concentrationMgPerGPowder: null,
                  concentrationMgPerMlWater:
                    waterMl > 0 ? mgOverrideRaw / waterMl : null,
                });
                continue;
              }
              // Per-formulation rate override beats the catalogue
              // rate: the scientist tweaks one pick's mg/ml here
              // and the math reflects it without touching the raw
              // material that other formulations share.
              const overrideRaw = excipientOverrides?.[
                `powder_rate:${pick.id}`
              ];
              const catalogueRate =
                pick.waterDoseMgPerMl ?? pick.powderRateMgPerG;
              const rawRate =
                overrideRaw !== undefined && overrideRaw !== null
                  ? overrideRaw
                  : catalogueRate;
              const rate =
                rawRate !== null &&
                rawRate !== undefined &&
                Number.isFinite(rawRate)
                  ? rawRate
                  : 0;
              if (rate <= 0) {
                preWarnings.push(
                  `powder_${band.slug}_rate_missing:${pick.label}`,
                );
                continue;
              }
              if (waterMl <= 0) continue;
              rows.push({
                slug: `${band.slug}:${pick.id}`,
                label: pick.label,
                mg: waterMl * rate,
                isRemainder: false,
                useAs: pick.useAs || band.useAs,
                concentrationMgPerGPowder: null,
                concentrationMgPerMlWater: rate,
              });
            }
          }

          // Anti-caking band -- same name classifier as capsule/
          // tablet. Silica-only -> 0.4% of total powder weight;
          // stearate-only -> 1.0%; both -> 1.4%. For powders we take
          // the percentage against the total finished powder mass per
          // serving (per-scoop fill weight × scoops) rather than the
          // actives sum, because a 500 g hydration sachet with 100 mg
          // of actives would otherwise dose anti-caking at 1.4 mg --
          // chemically meaningless. Capsules + tablets keep the
          // actives-based math because their fill is mostly actives.
          // Empty picker = no band.
          const { stearate: hasStearate, silica: hasSilica } =
            classifyAntiCakingPicks(antiCakingItems);
          if (hasStearate || hasSilica) {
            const powderTotalMg = fillWeightMg * scoops;
            const stearatePct = resolveBandPct(
              "mg_stearate",
              excipientOverrides,
            );
            const silicaPct = resolveBandPct("silica", excipientOverrides);
            const stearateMg = hasStearate
              ? powderTotalMg * stearatePct
              : 0;
            const silicaMg = hasSilica ? powderTotalMg * silicaPct : 0;
            emitPowderBand(
              "anti_caking",
              "Anti-caking Agents",
              stearateMg + silicaMg,
              antiCakingItems.map((p) => ({
                id: p.id,
                label: p.label,
                useAs: "Anti-caking Agent",
              })),
              null,
            );
          }

          // Carrier band -- fills the remainder of the sachet
          // after actives + other excipient bands. Empty picker =
          // no carrier (sachet may be under-filled).
          if (
            powderCarrierItems.length > 0 &&
            targetFillWeightMg &&
            targetFillWeightMg > 0
          ) {
            const target = targetFillWeightMg * scoops;
            const otherBands = rows.reduce((acc, r) => acc + r.mg, 0);
            const remainder = target - totalActive - otherBands;
            if (remainder > 0) {
              emitPowderBand(
                "carrier",
                "Carrier",
                remainder,
                powderCarrierItems.map((p) => ({
                  id: p.id,
                  label: p.label,
                  useAs: "Carrier",
                })),
                null,
              );
            }
          }

          return rows;
        })()
      : (() => {
          // Gummy flavour system — six scaled blocks (gelling +
          // premix only emit when gelling items are picked):
          //
          //   acidity         = target × 2%   (default, override-aware)
          //   flavour         = target × 0.4% (split across flavouring picks)
          //   colour          = target × 2%   (split across colour picks)
          //   glazing         = target × 0.1% (split across glazing picks)
          //   gelling         = target × 3%   (split across gelling picks)
          //   premix_sweetener = target × 6%  (split across premix picks,
          //                                    carved from gummy base)
          //
          // Empty gelling picks → no gelling/premix bands at all
          // (non-gelling gummy). Each band's % is override-aware via
          // ``resolveBandPct(slug, excipientOverrides)``.
          const targetForScaled =
            targetFillWeightMg && targetFillWeightMg > 0
              ? targetFillWeightMg
              : 0;
          const acidityPct = resolveBandPct("acidity", excipientOverrides);
          const flavouringPct = resolveBandPct("flavouring", excipientOverrides);
          const colourPct = resolveBandPct("colour", excipientOverrides);
          const glazingPct = resolveBandPct("glazing", excipientOverrides);
          const gellingPct = resolveBandPct("gelling", excipientOverrides);
          const premixSweetenerPct = resolveBandPct(
            "premix_sweetener",
            excipientOverrides,
          );
          const rows: ExcipientRow[] = [];
          const emitPickBand = (
            blockSlug: string,
            blockLabel: string,
            blockTotalMg: number,
            picks: ReadonlyArray<{
              readonly id: string;
              readonly label: string;
              readonly useAs: string;
            }>,
            placeholderWhenEmpty = true,
          ) => {
            if (blockTotalMg <= 0) return;
            if (picks.length > 0) {
              const perItem = blockTotalMg / picks.length;
              for (const pick of picks) {
                rows.push({
                  slug: `${blockSlug}:${pick.id}`,
                  label: pick.label,
                  mg: perItem,
                  isRemainder: false,
                  // Forward the pick's canonical ``use_as`` so the
                  // declaration formatter groups per-pick rows under
                  // the EU 1169 category label
                  // ("Gelling Agent (Pectin, Agar)"). Synthetic
                  // placeholder rows leave it blank — they sit
                  // standalone in the declaration.
                  useAs: pick.useAs || "",
                });
              }
            } else if (placeholderWhenEmpty) {
              rows.push({
                slug: blockSlug,
                label: blockLabel,
                mg: blockTotalMg,
                isRemainder: false,
              });
            }
          };
          emitPickBand(
            "acidity",
            "Acidity Regulator",
            targetForScaled * acidityPct,
            acidityItems,
          );
          emitPickBand(
            "flavouring",
            "Flavouring",
            targetForScaled * flavouringPct,
            flavouringItems,
          );
          emitPickBand(
            "colour",
            "Colour",
            targetForScaled * colourPct,
            colourItems,
          );
          emitPickBand(
            "glazing",
            "Glazing Agent",
            targetForScaled * glazingPct,
            glazingItems,
          );
          // Gelling + premix sweetener are coupled — both emit only
          // when gelling items have been picked. Premix on its own
          // without a gelling pick is meaningless and silently
          // ignored to mirror the server's behaviour.
          if (gellingItems.length > 0) {
            emitPickBand(
              "gelling",
              "Gelling Agent",
              targetForScaled * gellingPct,
              gellingItems,
              false,
            );
            emitPickBand(
              "premix_sweetener",
              "Premix Sweetener",
              targetForScaled * premixSweetenerPct,
              premixSweetenerItems,
            );
          }
          return rows;
        })();
  const flavourTotal = flavourRows.reduce((acc, r) => acc + r.mg, 0);
  const isGummy = dosageForm === "gummy";

  // Gummy excipient math (mirrors the server):
  //   water       = target × 5.5%             (fixed)
  //   gummy_base  = target − water − actives − flavour   (remainder)
  //   floor       = target × GUMMY_BASE_MIN_PCT          (65%)
  // When the scientist loads enough actives that ``gummy_base`` drops
  // below the floor the gel matrix won't set reliably and viability
  // flips to ``cannot_make`` (code ``gummy_base_below_floor``). The
  // ``gummyBaseMg`` value is still exposed so the UI shows what the
  // base *would* be under the current line-up.
  let waterMg: number | null = null;
  let gummyBaseMg: number | null = null;
  let waterItemId: string | null = null;
  let waterLabel = "Deionised Water (gummy base)";
  const gummyBaseRows: GummyBaseRow[] = [];
  if (isGummy && targetFillWeightMg && targetFillWeightMg > 0) {
    const waterPct = resolveBandPct("water", excipientOverrides);
    waterMg = targetFillWeightMg * waterPct;
    // Detect a water-named pick among the gummy_base selections. If
    // one is present, the scientist meant it to satisfy the water
    // fraction — attach its identity to the water row AND drop it
    // from the gummy_base split so its mass isn't double-counted.
    // Match is name-based (contains "water" or "aqua", case-
    // insensitive) rather than a dedicated ``use_as = "Water"``
    // because the catalogue vocab doesn't have one.
    const waterPickIndex = gummyBaseItems.findIndex((p) =>
      /(water|aqua)/i.test(p.label ?? ""),
    );
    let effectivePicks = gummyBaseItems;
    const waterPick =
      waterPickIndex >= 0 ? gummyBaseItems[waterPickIndex] : undefined;
    if (waterPick) {
      waterItemId = waterPick.id;
      waterLabel = waterPick.label;
      effectivePicks = gummyBaseItems.filter((_, i) => i !== waterPickIndex);
    }
    const remainder = targetFillWeightMg - waterMg - totalActive - flavourTotal;
    gummyBaseMg = Math.max(remainder, 0);
    const count = effectivePicks.length;
    if (count > 0 && gummyBaseMg > 0) {
      const perItem = gummyBaseMg / count;
      for (const pick of effectivePicks) {
        gummyBaseRows.push({
          itemId: pick.id,
          label: pick.label,
          useAs: pick.useAs,
          mg: perItem,
        });
      }
    }
  }

  const excipients: ExcipientBreakdown = {
    mgStearateMg: 0,
    silicaMg: 0,
    mccMg: 0,
    dcpMg: null,
    gummyBaseMg,
    waterMg,
    waterItemId,
    waterLabel,
    gummyBaseRows,
    rows: flavourRows,
  };

  if (!targetFillWeightMg || targetFillWeightMg <= 0) {
    return {
      sizeKey: null,
      sizeLabel: null,
      maxWeight: null,
      totalWeight: totalActive + flavourTotal,
      excipients,
      viability: {
        fits: false,
        comfortOk: false,
        codes: ["fill_weight_required"],
      },
      warnings: [...preWarnings],
    };
  }

  // Recipe total behaves differently for gummies: the base absorbs
  // headroom, so the true sum stays at the target unless actives push
  // the remainder below zero (the clamp above), in which case the
  // actual sum = water + actives + flavour > target.
  const recipeTotal = isGummy
    ? Math.max(
        targetFillWeightMg,
        totalActive + flavourTotal + (waterMg ?? 0),
      )
    : totalActive + flavourTotal;
  const tolerance = Math.max(targetFillWeightMg * 0.005, 0.1);
  let fits = recipeTotal <= targetFillWeightMg + tolerance;
  const matches = Math.abs(recipeTotal - targetFillWeightMg) <= tolerance;
  const codes: string[] = [];
  // Seed the warnings list with the soft warnings collected during the
  // powder branch (acidity dose / water-volume gaps) so the viability
  // checks below stack on top of them rather than overwriting them.
  const warnings: string[] = [...preWarnings];

  // Gummy floor check — evaluated first so a below-floor bundle
  // always lands on ``cannot_make`` even when total weight looks fine.
  if (isGummy && gummyBaseMg !== null) {
    const floor = targetFillWeightMg * GUMMY_BASE_MIN_PCT;
    if (gummyBaseMg + tolerance < floor) {
      fits = false;
      if (!codes.includes("cannot_make")) codes.push("cannot_make");
      warnings.push("gummy_base_below_floor");
    }
  }

  if (!fits) {
    if (!codes.includes("cannot_make")) codes.push("cannot_make");
    if (!warnings.includes("gummy_base_below_floor") && !isGummy) {
      warnings.push("fill_overshoot");
    } else if (!warnings.includes("gummy_base_below_floor")) {
      warnings.push("fill_overshoot");
    }
  } else if (matches) {
    codes.push("can_make", "less_challenging", "proceed_to_quote");
  } else {
    codes.push("can_make", "more_challenging_to_make", "fill_shortfall");
    warnings.push("fill_shortfall");
  }

  return {
    sizeKey: dosageForm === "powder" ? "sachet" : "gummy",
    sizeLabel:
      dosageForm === "powder"
        ? `Sachet (${formatFillWeight(targetFillWeightMg)})`
        : `Gummy (${formatFillWeight(targetFillWeightMg)})`,
    maxWeight: targetFillWeightMg,
    totalWeight: recipeTotal,
    excipients,
    viability: { fits, comfortOk: matches, codes },
    warnings,
  };
}

export function computeTotals({
  lines,
  dosageForm,
  capsuleSizeKey,
  capsuleShellOverride,
  capsuleShellCatalog,
  tabletSizeKey,
  defaultServingSize,
  targetFillWeightMg,
  powderType,
  waterVolumeMl,
  gummyBaseItems,
  flavouringItems,
  colourItems,
  glazingItems,
  gellingItems,
  premixSweetenerItems,
  acidityItems,
  mccCarrierItems,
  dcpCarrierItems,
  antiCakingItems,
  powderCarrierItems,
  sweetenerItems,
  excipientOverrides,
}: {
  lines: readonly ComputeLineInput[];
  dosageForm: DosageForm;
  capsuleSizeKey: string | null;
  /** Fill capacity + size key override from the picked capsule
   *  shell. Data-driven from ``attributes.capsule_size`` +
   *  ``attributes.max_weight_mg`` on the shell's PSP row. When
   *  set, wins over ``capsuleSizeKey`` (that's the legacy
   *  dropdown value on the formulation model). */
  capsuleShellOverride?: {
    readonly sizeKey?: string | null;
    readonly maxWeightMg?: number | null;
  } | null;
  /** PSP capsule-shell catalog for the org — used by capsule
   *  auto-pick when the operator hasn't ticked a shell yet.
   *  Ordering is irrelevant (compute sorts ascending by
   *  ``maxWeightMg``). Empty / omitted → auto-pick falls back to
   *  the hardcoded physics ladder. */
  capsuleShellCatalog?: readonly CapsuleShellCandidate[] | null;
  tabletSizeKey: string | null;
  defaultServingSize: number;
  targetFillWeightMg?: number | null;
  powderType?: PowderType | null;
  waterVolumeMl?: number | null;
  /** Picked gummy-base items, for per-item label + category on the
   *  auto-filled rows. Empty / omitted → the builder renders a
   *  generic "Gummy Base" row. Total base weight is split equally
   *  across picks. */
  gummyBaseItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked Flavouring items. The 0.4% flavour total splits equally
   *  across them so the declaration reads "Flavouring (Natural
   *  Strawberry, Lemon Extract)" with real procurement codes behind
   *  each name. */
  flavouringItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked Colour items. The 2% colour total splits equally across
   *  them; same declaration pattern as flavouring. */
  colourItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked Glazing Agent items (carnauba wax, coconut oil, etc.).
   *  The 0.1% glaze total splits equally across them. */
  glazingItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked Gelling Agent items (pectin, gelatin, agar, etc.). The
   *  3% gelling total splits equally across them. Empty / omitted →
   *  no gelling band, no premix-sweetener band (non-gelling gummy). */
  gellingItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked Premix Sweetener items combined with the gelling agent
   *  into the in-house "Pectin Premix" BOM line. The 6% premix
   *  total splits equally across them. Only emitted when
   *  ``gellingItems`` is non-empty. */
  premixSweetenerItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked Acidity Regulator items (Citric Acid, Trisodium
   *  Citrate, etc.). The 2% acidity total splits equally across
   *  picks. Empty / omitted → a generic "Acidity Regulator"
   *  placeholder appears in the totals panel. */
  acidityItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Picked MCC carrier items for capsule + tablet. Empty / omitted
   *  → the capsule ships as pure actives (no MCC remainder), the
   *  tablet skips the 20% MCC fill. */
  mccCarrierItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  /** Picked DCP carrier items for tablet. Empty / omitted → no DCP
   *  band (skips the 10% DCP fill). Tablet-only. */
  dcpCarrierItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  /** Picked anti-caking items for capsule + tablet (typically Mg
   *  Stearate + Silicon Dioxide). Empty / omitted → no anti-caking
   *  band at all. Each item carries its catalogue ``label`` so the
   *  classifier can sub-divide picks into the stearate (1.0%) and
   *  silica (0.4%) bands by name — picking Silicon Dioxide alone
   *  fires only the 0.4% band. */
  antiCakingItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  /** Powder carrier picks (Maltodextrin etc.). Fills the remainder of
   *  the sachet after actives + other excipient bands. Empty /
   *  omitted → no carrier band on the formulation. Powder-only. */
  powderCarrierItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
  }>;
  /** Powder Sweetener picks (Sucralose, Steviol etc.). Powder-only;
   *  the gummy branch consumes premixSweetenerItems via the gummy
   *  base instead. Empty / omitted → no sweetener band. */
  sweetenerItems?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly useAs: string;
  }>;
  /** Per-band % overrides for the gummy excipient system. Missing
   *  keys fall back to constant defaults. */
  excipientOverrides?: Readonly<Record<string, number>> | null;
}): FormulationTotals {
  let totalActive = 0;
  const lineValues = new Map<string, number>();
  const lineFailures = new Map<string, LineFailureReason>();

  for (const line of lines) {
    const servingSize =
      line.servingSizeOverride && line.servingSizeOverride > 0
        ? line.servingSizeOverride
        : defaultServingSize;
    const result = computeLine(
      line.attributes,
      line.labelClaimMg,
      servingSize,
      {
        purityOverride: line.purityOverride ?? null,
        overageOverride: line.overageOverride ?? null,
        extractRatioOverride: line.extractRatioOverride ?? null,
      },
    );
    if (result.mgPerServing !== null) {
      lineValues.set(line.externalId, result.mgPerServing);
      totalActive += result.mgPerServing;
    } else if (result.failureReason !== null) {
      lineFailures.set(line.externalId, result.failureReason);
    }
  }

  // Sweep every selected item (line + every M2M picker) and warn
  // about blank ``use_as`` classifications. A missing value breaks
  // the spec sheet's active-vs-excipient split silently, so we
  // surface it as a viability warning that the scientist can fix in
  // the catalogue. Mirrors the server-side sweep in
  // ``compute_totals`` so the warning shows live without waiting for
  // a save round-trip.
  const useAsWarnings: string[] = [];
  {
    const seen = new Set<string>();
    // Every excipient picker is scoped to a specific compliance
    // category on its ``useAsIn`` prop (the Anti-caking picker only
    // shows Anti-caking Agent items, the MCC picker only shows
    // Carrier / Bulking Agent items, etc.). So an item ticked via
    // a specific bucket is CLASSIFIED by the bucket regardless of
    // whether the PSP-side attribute is populated — the picker's
    // filter is the enforcement, not this compute warning.
    // Consequently we no longer walk bucket picks for missing
    // ``use_as``: doing so fired seven false-positive warnings the
    // moment an operator picked PSP-sourced excipients that hadn't
    // had their ``attributes.use_as`` backfilled yet. Server-side
    // parity for this change landed in the calc-infer-use-as-from-
    // picker PR.
    //
    // Actives (line items) DON'T carry a picker-context — the raw-
    // materials picker is open-ended by design — so a missing
    // ``use_as`` on a line is a genuine data gap worth surfacing.
    for (const line of lines) {
      const key = `line:${line.externalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = line.attributes?.use_as;
      const value = raw == null ? "" : String(raw).trim();
      if (!value) {
        const label =
          line.attributes?.ingredient_list_name ||
          line.fallbackName ||
          line.externalId;
        useAsWarnings.push(`item_missing_use_as:${label}`);
      }
    }
  }

  if (totalActive <= 0) {
    return {
      totalActiveMg: 0,
      dosageForm,
      sizeKey: null,
      sizeLabel: null,
      maxWeightMg: null,
      totalWeightMg: null,
      excipients: null,
      viability: EMPTY_VIABILITY,
      warnings: useAsWarnings,
      lineValues,
      lineFailures,
    };
  }

  const hasMccCarrier = (mccCarrierItems?.length ?? 0) > 0;
  const hasDcpCarrier = (dcpCarrierItems?.length ?? 0) > 0;
  const { stearate: hasStearateAntiCaking, silica: hasSilicaAntiCaking } =
    classifyAntiCakingPicks(antiCakingItems ?? []);

  if (dosageForm === "capsule") {
    const r = computeCapsule(
      totalActive,
      capsuleSizeKey,
      hasMccCarrier,
      hasStearateAntiCaking,
      hasSilicaAntiCaking,
      excipientOverrides,
      capsuleShellOverride ?? null,
      capsuleShellCatalog ?? null,
    );
    return {
      totalActiveMg: totalActive,
      dosageForm,
      sizeKey: r.sizeKey,
      sizeLabel: r.sizeLabel,
      maxWeightMg: r.maxWeight,
      totalWeightMg: r.totalWeight,
      excipients: r.excipients,
      viability: r.viability,
      warnings: [...r.warnings, ...useAsWarnings],
      lineValues,
      lineFailures,
    };
  }

  if (dosageForm === "tablet") {
    const r = computeTablet(
      totalActive,
      tabletSizeKey,
      hasMccCarrier,
      hasDcpCarrier,
      hasStearateAntiCaking,
      hasSilicaAntiCaking,
      excipientOverrides,
    );
    return {
      totalActiveMg: totalActive,
      dosageForm,
      sizeKey: r.sizeKey,
      sizeLabel: r.sizeLabel,
      maxWeightMg: r.maxWeight,
      totalWeightMg: r.totalWeight,
      excipients: r.excipients,
      viability: r.viability,
      warnings: [...r.warnings, ...useAsWarnings],
      lineValues,
      lineFailures,
    };
  }

  if (dosageForm === "powder" || dosageForm === "gummy") {
    const r = computeFillTarget(
      dosageForm,
      totalActive,
      targetFillWeightMg ?? null,
      powderType ?? null,
      waterVolumeMl ?? null,
      gummyBaseItems ?? [],
      flavouringItems ?? [],
      colourItems ?? [],
      glazingItems ?? [],
      gellingItems ?? [],
      premixSweetenerItems ?? [],
      acidityItems ?? [],
      // ``sweetenerItems`` powers the powder Sweetener band (gummy
      // branch ignores it -- its sweetener flow goes through
      // premixSweetenerItems via the gummy base).
      sweetenerItems ?? [],
      antiCakingItems ?? [],
      powderCarrierItems ?? [],
      excipientOverrides ?? null,
      defaultServingSize,
    );
    return {
      totalActiveMg: totalActive,
      dosageForm,
      sizeKey: r.sizeKey,
      sizeLabel: r.sizeLabel,
      maxWeightMg: r.maxWeight,
      totalWeightMg: r.totalWeight,
      excipients: r.excipients,
      viability: r.viability,
      warnings: [...r.warnings, ...useAsWarnings],
      lineValues,
      lineFailures,
    };
  }

  // Liquid / other_solid — track the total but no excipient block and
  // a clear "manual review" viability code.
  return {
    totalActiveMg: totalActive,
    dosageForm,
    sizeKey: null,
    sizeLabel: null,
    maxWeightMg: null,
    totalWeightMg: totalActive,
    excipients: null,
    viability: {
      fits: true,
      comfortOk: true,
      codes: ["manual_review_required"],
    },
    warnings: useAsWarnings,
    lineValues,
    lineFailures,
  };
}
