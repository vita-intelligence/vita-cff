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

import { CAPSULE_SIZES, TABLET_SIZES } from "./types";
import type { CapsuleSizeOption, DosageForm, TabletSizeOption } from "./types";

// ---------------------------------------------------------------------------
// Constants — copied verbatim from apps/formulations/constants.py
// ---------------------------------------------------------------------------

const CAPSULE_MG_STEARATE_PCT = 0.01;
const CAPSULE_SILICA_PCT = 0.004;

const TABLET_MG_STEARATE_PCT = 0.01;
const TABLET_SILICA_PCT = 0.004;
const TABLET_DCP_PCT = 0.10;
const TABLET_MCC_PCT = 0.20;

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
}

export interface ComputeLineInput {
  readonly externalId: string;
  readonly attributes: ItemAttributesForMath;
  readonly labelClaimMg: number;
  readonly servingSizeOverride?: number | null;
}

export type LineFailureReason =
  | "missing_claim"
  | "missing_purity"
  | "missing_extract_ratio";

export interface LineComputation {
  readonly mgPerServing: number | null;
  readonly failureReason: LineFailureReason | null;
}

export interface ExcipientBreakdown {
  readonly mgStearateMg: number;
  readonly silicaMg: number;
  readonly mccMg: number;
  readonly dcpMg: number | null;
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

export function computeTotals({
  lines,
  dosageForm,
  capsuleSizeKey,
  tabletSizeKey,
  defaultServingSize,
}: {
  lines: readonly ComputeLineInput[];
  dosageForm: DosageForm;
  capsuleSizeKey: string | null;
  tabletSizeKey: string | null;
  defaultServingSize: number;
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

  // Powder / gummy / liquid / other — track the total but no excipient
  // block and a clear "manual review" viability code.
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
