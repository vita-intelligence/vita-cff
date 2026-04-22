/**
 * Transport types for the product-validation domain.
 */

export const VALIDATION_STATUSES = [
  "draft",
  "in_progress",
  "passed",
  "failed",
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Mirrors ``ALLOWED_TRANSITIONS`` in services.py. Drives which
 * "Advance to" buttons appear in the UI for each current state. */
export const ALLOWED_VALIDATION_TRANSITIONS: Readonly<
  Record<ValidationStatus, readonly ValidationStatus[]>
> = {
  draft: ["in_progress"],
  in_progress: ["passed", "failed", "draft"],
  passed: ["in_progress"],
  failed: ["in_progress"],
};


export interface ActorSummary {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}


// --- Test payloads ---------------------------------------------------------

export interface WeightTestPayload {
  readonly target_mg: number | null;
  readonly tolerance_pct: number;
  readonly samples: readonly number[];
  readonly notes: string;
}

export interface HardnessTestPayload {
  readonly target_min_n: number | null;
  readonly target_max_n: number | null;
  readonly samples: readonly number[];
  readonly notes: string;
}

export interface ThicknessTestPayload {
  readonly target_mm: number | null;
  readonly tolerance_mm: number | null;
  readonly samples: readonly number[];
  readonly notes: string;
}

export interface DisintegrationTestPayload {
  readonly limit_minutes: number | null;
  readonly temperature_c: number | null;
  readonly samples: readonly number[];
  readonly notes: string;
}

export interface OrganolepticTestPayload {
  readonly target: {
    readonly colour: string;
    readonly taste: string;
    readonly odour: string;
  };
  readonly actual: {
    readonly colour: string;
    readonly taste: string;
    readonly odour: string;
  };
  readonly passed: boolean | null;
  readonly notes: string;
}

export interface MrpeasyChecklistPayload {
  readonly raw_materials_created: boolean;
  readonly finished_product_created: boolean;
  readonly boms_verified: boolean;
}


// --- Read DTO --------------------------------------------------------------

export interface ProductValidationDto {
  readonly id: string;
  readonly trial_batch_id: string;
  readonly formulation_id: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number;
  readonly batch_label: string;

  readonly weight_test: WeightTestPayload;
  readonly hardness_test: HardnessTestPayload;
  readonly thickness_test: ThicknessTestPayload;
  readonly disintegration_test: DisintegrationTestPayload;
  readonly organoleptic_test: OrganolepticTestPayload;
  readonly mrpeasy_checklist: MrpeasyChecklistPayload;

  readonly notes: string;
  readonly status: ValidationStatus;
  readonly scientist: ActorSummary | null;
  readonly scientist_signed_at: string | null;
  readonly scientist_signature_image: string;
  readonly rd_manager: ActorSummary | null;
  readonly rd_manager_signed_at: string | null;
  readonly rd_manager_signature_image: string;
  readonly created_at: string;
  readonly updated_at: string;
}


// --- Stats DTO (from /stats/ endpoint) ------------------------------------

export interface WeightStatsDto {
  readonly target_mg: number | null;
  readonly tolerance_pct: number;
  readonly min_allowed_mg: number | null;
  readonly max_allowed_mg: number | null;
  readonly samples: readonly number[];
  readonly per_sample_passed: readonly boolean[];
  readonly mean: number | null;
  readonly stdev: number | null;
  readonly passed: boolean | null;
}

export interface HardnessStatsDto {
  readonly target_min_n: number | null;
  readonly target_max_n: number | null;
  readonly samples: readonly number[];
  readonly per_sample_passed: readonly boolean[];
  readonly mean: number | null;
  readonly stdev: number | null;
  readonly passed: boolean | null;
}

export interface ThicknessStatsDto {
  readonly target_mm: number | null;
  readonly tolerance_mm: number | null;
  readonly min_allowed_mm: number | null;
  readonly max_allowed_mm: number | null;
  readonly samples: readonly number[];
  readonly per_sample_passed: readonly boolean[];
  readonly mean: number | null;
  readonly stdev: number | null;
  readonly passed: boolean | null;
}

export interface DisintegrationStatsDto {
  readonly limit_minutes: number | null;
  readonly temperature_c: number | null;
  readonly samples: readonly number[];
  readonly per_sample_passed: readonly boolean[];
  readonly worst_minutes: number | null;
  readonly passed: boolean | null;
}

export interface OrganolepticStatsDto {
  readonly target: {
    readonly colour: string;
    readonly taste: string;
    readonly odour: string;
  };
  readonly actual: {
    readonly colour: string;
    readonly taste: string;
    readonly odour: string;
  };
  readonly passed: boolean | null;
}

export interface ChecklistStatsDto {
  readonly raw_materials_created: boolean;
  readonly finished_product_created: boolean;
  readonly boms_verified: boolean;
  readonly passed: boolean;
}

export interface ValidationStatsDto {
  readonly weight: WeightStatsDto;
  readonly hardness: HardnessStatsDto;
  readonly thickness: ThicknessStatsDto;
  readonly disintegration: DisintegrationStatsDto;
  readonly organoleptic: OrganolepticStatsDto;
  readonly checklist: ChecklistStatsDto;
  readonly overall_passed: boolean | null;
}


// --- Request DTOs ----------------------------------------------------------

export interface CreateValidationRequestDto {
  readonly trial_batch_id: string;
  readonly notes?: string;
}

export type UpdateValidationRequestDto = Partial<{
  readonly weight_test: WeightTestPayload;
  readonly hardness_test: HardnessTestPayload;
  readonly thickness_test: ThicknessTestPayload;
  readonly disintegration_test: DisintegrationTestPayload;
  readonly organoleptic_test: OrganolepticTestPayload;
  readonly mrpeasy_checklist: MrpeasyChecklistPayload;
  readonly notes: string;
}>;

export interface TransitionValidationRequestDto {
  readonly status: ValidationStatus;
  /** Base64 PNG data URL captured on the signature pad. Required
   *  for sign-off transitions (``draft → in_progress``, and
   *  ``in_progress → passed|failed``); optional for rewind
   *  transitions back to ``draft`` or ``in_progress``. */
  readonly signature_image?: string;
}
