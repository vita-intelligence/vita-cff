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

// Powder + gummy do NOT auto-compute excipient rows. The reference
// workbooks treat the carrier / bulking agent / gummy base as a
// real catalogue ingredient the scientist explicitly adds. See
// ``apps/formulations/constants.py`` for the detailed rationale.

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
}

export interface ExcipientBreakdown {
  readonly mgStearateMg: number;
  readonly silicaMg: number;
  readonly mccMg: number;
  readonly dcpMg: number | null;
  /** Powder / gummy flexible list. Empty for capsule + tablet. */
  readonly rows: readonly ExcipientRow[];
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

export function computeLine(
  attributes: ItemAttributesForMath,
  labelClaimMg: number,
  servingSize: number,
): LineComputation {
  if (!Number.isFinite(labelClaimMg) || labelClaimMg <= 0) {
    return { mgPerServing: null, failureReason: "missing_claim" };
  }
  if (servingSize <= 0) {
    return { mgPerServing: null, failureReason: "missing_claim" };
  }

  const perUnitClaim = labelClaimMg / servingSize;

  if (isBotanical(attributes)) {
    const extractRatio = coerceFloat(attributes.extract_ratio);
    if (extractRatio === null || extractRatio <= 0) {
      return { mgPerServing: null, failureReason: "missing_extract_ratio" };
    }
    return { mgPerServing: perUnitClaim / extractRatio, failureReason: null };
  }

  const purity = coerceFloat(attributes.purity);
  if (purity === null || purity <= 0) {
    return { mgPerServing: null, failureReason: "missing_purity" };
  }
  let raw = perUnitClaim / purity;
  const overage = coerceFloat(attributes.overage);
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
): string | null {
  if (!Number.isFinite(labelClaimMg) || labelClaimMg <= 0) return null;

  if (isBotanical(attributes)) {
    const extractRatio = coerceFloat(attributes.extract_ratio);
    if (extractRatio === null || extractRatio <= 0) return null;
    return `${formatNumber(labelClaimMg)} / ${formatNumber(extractRatio)}:1 extract`;
  }

  const purity = coerceFloat(attributes.purity);
  if (purity === null || purity <= 0) return null;
  const overage = coerceFloat(attributes.overage);

  const parts: string[] = [formatNumber(labelClaimMg)];
  if (purity !== 1) {
    parts.push(`/ ${formatNumber(purity)} purity`);
  }
  if (overage !== null && overage > 0) {
    parts.push(`× ${formatNumber(1 + overage)} (${formatPercent(overage)} overage)`);
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
}


export interface IngredientDeclaration {
  readonly text: string;
  readonly entries: readonly IngredientDeclarationEntry[];
}


export function buildIngredientDeclaration({
  lines,
  totals,
}: {
  lines: readonly {
    readonly externalId: string;
    readonly attributes: ItemAttributesForMath;
    readonly fallbackName?: string;
  }[];
  totals: FormulationTotals;
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

  const excipients = totals.excipients;
  if (excipients) {
    if (excipients.mccMg > 0) {
      entries.push({
        label: EXCIPIENT_LABEL_MCC,
        mg: excipients.mccMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
    }
    if (excipients.dcpMg !== null && excipients.dcpMg > 0) {
      entries.push({
        label: EXCIPIENT_LABEL_DCP,
        mg: excipients.dcpMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
    }
    // Mg Stearate + Silica collapse into a single "Anticaking
    // Agents" row on the consumer-facing declaration — same merge
    // the server's ``build_ingredient_declaration`` does. Combined
    // mg drives the sort order so the merged entry sits at the
    // right rank rather than each half landing at the bottom on
    // its own tiny weight.
    const anticakingMg = excipients.mgStearateMg + excipients.silicaMg;
    if (anticakingMg > 0) {
      entries.push({
        label: EXCIPIENT_LABEL_ANTICAKING,
        mg: anticakingMg,
        category: "excipient",
        isAllergen: false,
        allergenSource: "",
      });
    }
  }

  if (totals.dosageForm === "capsule" && totals.sizeKey) {
    const shellWeight = CAPSULE_SHELL_WEIGHTS[totals.sizeKey];
    if (shellWeight && shellWeight > 0) {
      entries.push({
        label: CAPSULE_SHELL_LABEL,
        mg: shellWeight,
        category: "shell",
        isAllergen: false,
        allergenSource: "",
      });
    }
  }

  entries.sort((a, b) => b.mg - a.mg || a.label.localeCompare(b.label));
  return {
    text: entries.map((e) => e.label).join(", "),
    entries,
  };
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

// ---------------------------------------------------------------------------
// Totals block
// ---------------------------------------------------------------------------

const EMPTY_VIABILITY: Viability = {
  fits: false,
  comfortOk: false,
  codes: ["more_info_required"],
};

function computeCapsule(
  totalActive: number,
  requestedSizeKey: string | null,
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
  if (requestedSizeKey) {
    size = capsuleSizeByKey(requestedSizeKey);
  } else {
    size = autoPickCapsuleSize(totalActive);
    if (size === null) warnings.push("capsule_too_large");
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

  const stearate = totalActive * CAPSULE_MG_STEARATE_PCT;
  const silica = totalActive * CAPSULE_SILICA_PCT;
  const mcc = size.max_weight_mg - totalActive - stearate - silica;
  const totalWeight =
    mcc >= 0
      ? totalActive + stearate + silica + mcc
      : totalActive + stearate + silica;

  const fits = size.max_weight_mg >= totalWeight;
  const comfortOk = fits && mcc >= totalActive * 0.01;
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
      rows: [],
    },
    viability: { fits, comfortOk, codes },
    warnings,
  };
}

function computeTablet(
  totalActive: number,
  requestedSizeKey: string | null,
): {
  sizeKey: string | null;
  sizeLabel: string | null;
  maxWeight: number | null;
  totalWeight: number;
  excipients: ExcipientBreakdown;
  viability: Viability;
  warnings: readonly string[];
} {
  const stearate = totalActive * TABLET_MG_STEARATE_PCT;
  const silica = totalActive * TABLET_SILICA_PCT;
  const dcp = totalActive * TABLET_DCP_PCT;
  const mcc = totalActive * TABLET_MCC_PCT;
  const totalWeight = totalActive + stearate + silica + dcp + mcc;

  const excipients: ExcipientBreakdown = {
    mgStearateMg: stearate,
    silicaMg: silica,
    mccMg: mcc,
    dcpMg: dcp,
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
): {
  sizeKey: string | null;
  sizeLabel: string | null;
  maxWeight: number | null;
  totalWeight: number | null;
  excipients: ExcipientBreakdown | null;
  viability: Viability;
  warnings: readonly string[];
} {
  if (!targetFillWeightMg || targetFillWeightMg <= 0) {
    return {
      sizeKey: null,
      sizeLabel: null,
      maxWeight: null,
      totalWeight: totalActive,
      excipients: null,
      viability: {
        fits: false,
        comfortOk: false,
        codes: ["fill_weight_required"],
      },
      warnings: [],
    };
  }

  const tolerance = Math.max(targetFillWeightMg * 0.005, 0.1);
  const fits = totalActive <= targetFillWeightMg + tolerance;
  const matches = Math.abs(totalActive - targetFillWeightMg) <= tolerance;
  const codes: string[] = [];
  const warnings: string[] = [];
  if (!fits) {
    codes.push("cannot_make");
    warnings.push("fill_overshoot");
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
    totalWeight: totalActive,
    excipients: null,
    viability: { fits, comfortOk: matches, codes },
    warnings,
  };
}

export function computeTotals({
  lines,
  dosageForm,
  capsuleSizeKey,
  tabletSizeKey,
  defaultServingSize,
  targetFillWeightMg,
}: {
  lines: readonly ComputeLineInput[];
  dosageForm: DosageForm;
  capsuleSizeKey: string | null;
  tabletSizeKey: string | null;
  defaultServingSize: number;
  targetFillWeightMg?: number | null;
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
    );
    if (result.mgPerServing !== null) {
      lineValues.set(line.externalId, result.mgPerServing);
      totalActive += result.mgPerServing;
    } else if (result.failureReason !== null) {
      lineFailures.set(line.externalId, result.failureReason);
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
      warnings: [],
      lineValues,
      lineFailures,
    };
  }

  if (dosageForm === "capsule") {
    const r = computeCapsule(totalActive, capsuleSizeKey);
    return {
      totalActiveMg: totalActive,
      dosageForm,
      sizeKey: r.sizeKey,
      sizeLabel: r.sizeLabel,
      maxWeightMg: r.maxWeight,
      totalWeightMg: r.totalWeight,
      excipients: r.excipients,
      viability: r.viability,
      warnings: r.warnings,
      lineValues,
      lineFailures,
    };
  }

  if (dosageForm === "tablet") {
    const r = computeTablet(totalActive, tabletSizeKey);
    return {
      totalActiveMg: totalActive,
      dosageForm,
      sizeKey: r.sizeKey,
      sizeLabel: r.sizeLabel,
      maxWeightMg: r.maxWeight,
      totalWeightMg: r.totalWeight,
      excipients: r.excipients,
      viability: r.viability,
      warnings: r.warnings,
      lineValues,
      lineFailures,
    };
  }

  if (dosageForm === "powder" || dosageForm === "gummy") {
    const r = computeFillTarget(
      dosageForm,
      totalActive,
      targetFillWeightMg ?? null,
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
      warnings: r.warnings,
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
    warnings: [],
    lineValues,
    lineFailures,
  };
}
