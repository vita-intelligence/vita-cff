/**
 * Transport types for the formulations domain.
 */

export const DOSAGE_FORMS = [
  "powder",
  "capsule",
  "tablet",
  "gummy",
  "liquid",
  "other_solid",
] as const;
export type DosageForm = (typeof DOSAGE_FORMS)[number];

export const FULLY_SUPPORTED_DOSAGE_FORMS: readonly DosageForm[] = [
  "capsule",
  "tablet",
  "powder",
  "gummy",
] as const;

/** Dosage forms whose excipient math depends on a per-unit target
 * fill weight (sachet mass for powders, single-gummy weight for
 * gummies). Builder surfaces an extra input for these. */
export const TARGET_FILL_WEIGHT_FORMS: readonly DosageForm[] = [
  "powder",
  "gummy",
] as const;

/** Sub-variants of the powder dosage form. ``protein`` drops the
 * Trisodium Citrate + Citric Acid rows from the flavour system (the
 * protein matrix already buffers itself). Surfaced in the builder
 * only when ``dosage_form === "powder"``. */
export const POWDER_TYPES = ["standard", "protein"] as const;
export type PowderType = (typeof POWDER_TYPES)[number];

/** Product roadmap status — the single lifecycle chip shown at
 * the top of the project workspace. */
export const PROJECT_STATUSES = [
  "concept",
  "in_development",
  "pilot",
  "approved",
  "discontinued",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Commercial engagement model. Drives which proposal template
 *  renders on the client kiosk — Custom includes the laboratory
 *  development phase + 30% deposit; Ready to Go is straight-to-
 *  production from an existing recipe. */
export const PROJECT_TYPES = ["custom", "ready_to_go"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export interface CapsuleSizeOption {
  readonly key: string;
  readonly label: string;
  readonly max_weight_mg: number;
}

export const CAPSULE_SIZES: readonly CapsuleSizeOption[] = [
  { key: "size_1", label: "Size 1", max_weight_mg: 380 },
  { key: "single_0", label: "Single 0", max_weight_mg: 453 },
  { key: "double_00", label: "Double 00", max_weight_mg: 730 },
  { key: "size_3", label: "Size 3", max_weight_mg: 216 },
] as const;


/**
 * Empty capsule shell weights in mg. Used by the ingredient
 * declaration so the shell contributes to the sort order alongside
 * actives and excipients. Values from ``Lists!K20:L23`` in the
 * workbook and must match ``CapsuleSize.shell_weight_mg`` on the
 * Python side.
 */
export const CAPSULE_SHELL_WEIGHTS: Readonly<Record<string, number>> = {
  size_1: 75,
  single_0: 96,
  double_00: 118,
  size_3: 50,
} as const;


export const COMPLIANCE_FLAGS: readonly {
  readonly key: ComplianceFlagKey;
  readonly label: string;
}[] = [
  { key: "vegan", label: "Vegan" },
  { key: "organic", label: "Organic" },
  { key: "halal", label: "Halal" },
  { key: "kosher", label: "Kosher" },
] as const;

export type ComplianceFlagKey = "vegan" | "organic" | "halal" | "kosher";

export interface TabletSizeOption {
  readonly key: string;
  readonly label: string;
  readonly max_weight_mg: number;
}

export const TABLET_SIZES: readonly TabletSizeOption[] = [
  { key: "round_6mm", label: "6mm Round", max_weight_mg: 150 },
  { key: "round_7_5mm", label: "7.5mm Round", max_weight_mg: 225 },
  { key: "round_8mm", label: "8mm Round", max_weight_mg: 275 },
  { key: "round_11mm", label: "11mm Round", max_weight_mg: 700 },
  { key: "round_13mm", label: "13mm Round", max_weight_mg: 1000 },
  { key: "oval_14_5x8_5mm", label: "14.5mm x 8.5mm", max_weight_mg: 700 },
  { key: "oval_15x7mm", label: "15mm x 7mm", max_weight_mg: 600 },
  { key: "oval_19_5x8_2mm", label: "19.5mm x 8.2mm", max_weight_mg: 1100 },
  { key: "oval_22_5x9mm", label: "22.5mm x 9mm", max_weight_mg: 1500 },
  { key: "oval_22_5x10mm", label: "22.5mm x 10mm", max_weight_mg: 1750 },
] as const;

/**
 * Cursor-paginated list response shape from DRF's
 * :class:`FormulationCursorPagination`. ``next`` / ``previous`` are
 * opaque URLs the client walks verbatim.
 */
export interface PaginatedFormulationsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly FormulationDto[];
}

export interface FormulationsListQuery {
  readonly ordering?: string;
  readonly pageSize?: number;
}

/**
 * Math-critical subset of a raw material's attributes, surfaced by
 * the backend on every formulation line so the builder can run the
 * :func:`computeLine` cascade live without re-fetching the item.
 */
export interface LineItemAttributes {
  readonly type: string | null;
  readonly purity: string | number | null;
  readonly extract_ratio: string | number | null;
  readonly overage: string | number | null;
}

export interface FormulationLineDto {
  readonly id: string;
  readonly item: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly item_attributes: LineItemAttributes;
  readonly display_order: number;
  readonly label_claim_mg: string;
  readonly serving_size_override: number | null;
  readonly mg_per_serving_cached: string | null;
  readonly notes: string;
}

export interface SalesPersonDto {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** Light echo of a gummy-base raw-material item picked for this
 *  formulation. Zero or more items can be picked; the total base
 *  weight is split equally across them. When the list is empty the
 *  spec-sheet declaration emits a generic "Gummy Base" row. */
export interface GummyBaseItemDto {
  readonly id: string;
  readonly name: string;
  readonly internal_code: string;
  readonly ingredient_list_name: string;
  readonly use_as: string;
}


export interface FormulationDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly dosage_form: DosageForm;
  readonly capsule_size: string;
  readonly tablet_size: string;
  readonly serving_size: number;
  readonly servings_per_pack: number;
  readonly target_fill_weight_mg: string | null;
  readonly powder_type: PowderType;
  readonly water_volume_ml: string | null;
  readonly gummy_base_item_ids: readonly string[];
  readonly gummy_base_items: readonly GummyBaseItemDto[];
  readonly flavouring_item_ids: readonly string[];
  //: Echo payload reuses :type:`GummyBaseItemDto` — same fields
  //: (id / name / internal_code / ingredient_list_name / use_as).
  readonly flavouring_items: readonly GummyBaseItemDto[];
  readonly colour_item_ids: readonly string[];
  readonly colour_items: readonly GummyBaseItemDto[];
  readonly glazing_item_ids: readonly string[];
  readonly glazing_items: readonly GummyBaseItemDto[];
  readonly directions_of_use: string;
  readonly suggested_dosage: string;
  readonly appearance: string;
  readonly disintegration_spec: string;
  readonly project_status: ProjectStatus;
  readonly project_type: ProjectType;
  readonly approved_version_number: number | null;
  readonly sales_person: SalesPersonDto | null;
  readonly lines: readonly FormulationLineDto[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AssignSalesPersonRequestDto {
  readonly user_id: string | null;
}

export interface CreateFormulationRequestDto {
  readonly name: string;
  readonly code: string;
  readonly description?: string;
  readonly dosage_form?: DosageForm;
  readonly capsule_size?: string;
  readonly tablet_size?: string;
  readonly serving_size?: number;
  readonly servings_per_pack?: number;
  readonly target_fill_weight_mg?: string | null;
  readonly powder_type?: PowderType;
  readonly water_volume_ml?: string | null;
  readonly directions_of_use?: string;
  readonly suggested_dosage?: string;
  readonly appearance?: string;
  readonly disintegration_spec?: string;
}

export type UpdateFormulationRequestDto = Partial<CreateFormulationRequestDto> & {
  readonly project_status?: ProjectStatus;
  readonly project_type?: ProjectType;
  /** Array of Item ids for the gummy-base blend; empty array clears
   *  the selection. Server rejects items outside the raw_materials
   *  catalogue or whose ``use_as`` isn't a valid gummy-base
   *  category. */
  readonly gummy_base_item_ids?: readonly string[];
  /** Array of Item ids for the Flavouring block; empty array clears.
   *  Server rejects items whose ``use_as`` ≠ 'Flavouring'. */
  readonly flavouring_item_ids?: readonly string[];
  /** Array of Item ids for the Colour block; empty array clears.
   *  Server rejects items whose ``use_as`` ≠ 'Colour'. */
  readonly colour_item_ids?: readonly string[];
  /** Array of Item ids for the Glazing Agent block (wax, coconut
   *  oil, etc.); empty array clears. Server rejects items whose
   *  ``use_as`` ≠ 'Glazing Agent'. */
  readonly glazing_item_ids?: readonly string[];
};

export interface FormulationLineInput {
  readonly item_id: string;
  readonly label_claim_mg: string;
  readonly serving_size_override?: number | null;
  readonly display_order?: number;
  readonly notes?: string;
}

export interface ReplaceLinesRequestDto {
  readonly lines: readonly FormulationLineInput[];
}

export interface ExcipientRowDto {
  readonly slug: string;
  readonly label: string;
  readonly mg: string;
  readonly is_remainder: boolean;
  readonly concentration_mg_per_ml?: string | null;
}

/** One item in the gummy-base blend. Label + category come from the
 *  picked catalogue item so the spec sheet reads "Sweeteners
 *  (Xylitol, Maltitol)"; ``mg`` is the per-item share of the total
 *  base weight (equal split across picks). */
export interface GummyBaseRowDto {
  readonly item_id: string;
  readonly label: string;
  readonly use_as: string;
  readonly mg: string;
}


export interface ExcipientBreakdownDto {
  readonly mg_stearate_mg: string | null;
  readonly silica_mg: string | null;
  readonly mcc_mg: string | null;
  readonly dcp_mg: string | null;
  /** Gummy-only TOTAL base weight (target − water − actives −
   *  flavour, min 65% floor). ``null`` elsewhere. Per-item splits
   *  live on :attr:`gummy_base_rows`. */
  readonly gummy_base_mg: string | null;
  /** Gummy-only: 5.5% of the target gummy weight. ``null`` elsewhere. */
  readonly water_mg: string | null;
  /** Per-item breakdown of the gummy base (empty when none picked). */
  readonly gummy_base_rows: readonly GummyBaseRowDto[];
  /** Flexible per-form list populated for powder + gummy. Empty for
   * capsule + tablet — those consume the typed fields above. */
  readonly rows: readonly ExcipientRowDto[];
}

export interface ViabilityDto {
  readonly fits: boolean;
  readonly comfort_ok: boolean;
  readonly codes: readonly string[];
}

export interface FormulationTotalsDto {
  readonly total_active_mg: string | null;
  readonly dosage_form: DosageForm;
  readonly size_key: string | null;
  readonly size_label: string | null;
  readonly max_weight_mg: string | null;
  readonly total_weight_mg: string | null;
  readonly excipients: ExcipientBreakdownDto | null;
  readonly viability: ViabilityDto;
  readonly warnings: readonly string[];
  readonly line_values: Readonly<Record<string, string>>;
}

export interface FormulationVersionDto {
  readonly id: string;
  readonly version_number: number;
  readonly label: string;
  readonly snapshot_metadata: Readonly<Record<string, unknown>>;
  readonly snapshot_lines: readonly Readonly<Record<string, unknown>>[];
  readonly snapshot_totals: Readonly<Record<string, unknown>>;
  readonly created_at: string;
}

export interface SaveVersionRequestDto {
  readonly label?: string;
}

export interface RollbackRequestDto {
  readonly version_number: number;
}


// ---------------------------------------------------------------------------
// Project overview DTO — mirrors apps/formulations/overview.py
// ---------------------------------------------------------------------------


export interface SpecSheetCountsDto {
  readonly total: number;
  readonly draft: number;
  readonly in_review: number;
  readonly approved: number;
  readonly sent: number;
  readonly accepted: number;
  readonly rejected: number;
}

export interface TrialBatchCountsDto {
  readonly total: number;
  readonly in_flight: number;
  readonly latest_label: string;
  readonly latest_packs: number;
}

export interface QCCountsDto {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly in_progress: number;
}

export interface AllergenSnapshotDto {
  readonly sources: readonly string[];
  readonly count: number;
}

export interface ComplianceSnapshotDto {
  readonly vegan: boolean | null;
  readonly organic: boolean | null;
  readonly halal: boolean | null;
  readonly kosher: boolean | null;
}

export interface OverviewTotalsDto {
  readonly total_active_mg: string | null;
  readonly total_weight_mg: string | null;
  readonly filled_total_mg: string | null;
  readonly viability: string | null;
}

export interface ProjectActivityEntryDto {
  readonly id: string;
  /** Action slug in ``{module}.{verb}`` form (e.g. ``formulation.update``,
   * ``spec_sheet.status_transition``). Kept as a free-form string so
   * new audit-log events don't require a TS widening. */
  readonly kind: string;
  readonly text: string;
  readonly actor_name: string;
  readonly created_at: string;
}

export interface ProjectOverviewDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly project_status: ProjectStatus;
  readonly dosage_form: string;
  readonly size_label: string;
  readonly updated_at: string;
  readonly created_at: string;
  readonly owner_name: string;
  readonly sales_person: SalesPersonDto | null;
  readonly latest_version: number | null;
  readonly latest_version_label: string;
  readonly latest_version_saved_at: string | null;
  readonly spec_sheets: SpecSheetCountsDto;
  readonly trial_batches: TrialBatchCountsDto;
  readonly qc: QCCountsDto;
  readonly allergens: AllergenSnapshotDto;
  readonly compliance: ComplianceSnapshotDto;
  readonly totals: OverviewTotalsDto;
  readonly activity: readonly ProjectActivityEntryDto[];
}
