/**
 * Transport types for the specifications domain.
 */

export const SPECIFICATION_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "sent",
  "accepted",
  "rejected",
] as const;
export type SpecificationStatus = (typeof SPECIFICATION_STATUSES)[number];

/**
 * Allowed status transitions — mirrors ``ALLOWED_TRANSITIONS`` in
 * ``apps/specifications/services.py``. Keeps the UI's enable/disable
 * logic in one place so the forward buttons grey out whenever the
 * backend would reject.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<SpecificationStatus, readonly SpecificationStatus[]>
> = {
  draft: ["in_review"],
  in_review: ["approved", "draft"],
  approved: ["sent", "draft"],
  sent: ["accepted", "rejected"],
  accepted: [],
  rejected: ["draft"],
};

export interface SpecificationSheetDto {
  readonly id: string;
  readonly code: string;
  readonly client_name: string;
  readonly client_email: string;
  readonly client_company: string;
  readonly margin_percent: string | null;
  readonly final_price: string | null;
  readonly cover_notes: string;
  readonly total_weight_label: string;
  readonly public_token: string | null;
  readonly status: SpecificationStatus;
  readonly formulation_version: string;
  readonly formulation_id: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PaginatedSpecificationsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly SpecificationSheetDto[];
}

export interface CreateSpecificationRequestDto {
  readonly formulation_version_id: string;
  readonly code?: string;
  readonly client_name?: string;
  readonly client_email?: string;
  readonly client_company?: string;
  readonly margin_percent?: string | null;
  readonly final_price?: string | null;
  readonly cover_notes?: string;
  readonly total_weight_label?: string;
}

export type UpdateSpecificationRequestDto = Partial<
  Omit<CreateSpecificationRequestDto, "formulation_version_id">
>;

export interface TransitionStatusRequestDto {
  readonly status: SpecificationStatus;
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Render view-model — shape returned by ``/render/`` endpoint
// ---------------------------------------------------------------------------

export interface RenderedActive {
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly ingredient_list_name: string;
  readonly label_claim_mg: string;
  readonly mg_per_serving: string;
  readonly nrv_percent: string | null;
}

export interface RenderedCompliance {
  readonly flags: readonly {
    readonly key: string;
    readonly label: string;
    readonly status: boolean | null;
    readonly compliant_count: number;
    readonly non_compliant_count: number;
    readonly unknown_count: number;
  }[];
}

export interface RenderedDeclaration {
  readonly text: string;
  readonly entries: readonly {
    readonly label: string;
    readonly mg: string;
    readonly category: "active" | "excipient" | "shell";
  }[];
}

/** One row of the nutrition facts panel. ``key`` matches the
 * catalogue attribute name; ``per_serving`` and ``per_100g`` are
 * already scaled and quantised to four decimals on the backend. */
export interface RenderedNutrientRow {
  readonly key: string;
  readonly per_serving: string;
  readonly per_100g: string;
  readonly contributors: number;
}

export interface RenderedNutrition {
  readonly rows: readonly RenderedNutrientRow[];
}

export interface RenderedAminoGroup {
  readonly key: "essential" | "conditionally_essential" | "non_essential";
  readonly acids: readonly RenderedNutrientRow[];
}

export interface RenderedAminoAcids {
  readonly groups: readonly RenderedAminoGroup[];
}

export interface RenderedTransition {
  readonly id: string;
  readonly from_status: SpecificationStatus;
  readonly to_status: SpecificationStatus;
  readonly actor_id: string;
  readonly actor_name: string;
  readonly actor_email: string;
  readonly notes: string;
  readonly created_at: string;
}

export interface RenderedSheetContext {
  readonly sheet: SpecificationSheetDto;
  readonly formulation: {
    readonly id: string;
    readonly version_number: number;
    readonly version_label: string;
    readonly code: string;
    readonly name: string;
    readonly description: string;
    readonly dosage_form: string;
    readonly capsule_size: string;
    readonly tablet_size: string;
    readonly serving_size: number;
    readonly servings_per_pack: number;
    readonly directions_of_use: string;
    readonly suggested_dosage: string;
    readonly appearance: string;
    readonly disintegration_spec: string;
  };
  readonly totals: {
    readonly total_active_mg: string | null;
    readonly total_weight_mg: string | null;
    readonly filled_total_mg: string | null;
    readonly max_weight_mg: string | null;
    readonly size_label: string | null;
    readonly excipients: {
      readonly mg_stearate_mg: string | null;
      readonly silica_mg: string | null;
      readonly mcc_mg: string | null;
      readonly dcp_mg: string | null;
    } | null;
    readonly viability: {
      readonly fits: boolean;
      readonly comfort_ok: boolean;
      readonly codes: readonly string[];
    } | null;
  };
  readonly actives: readonly RenderedActive[];
  readonly compliance: RenderedCompliance;
  readonly declaration: RenderedDeclaration;
  readonly nutrition: RenderedNutrition;
  readonly amino_acids: RenderedAminoAcids;
  readonly history: readonly RenderedTransition[];
  readonly packaging: {
    readonly lid_description: string;
    readonly bottle_pouch_tub: string;
    readonly label_size: string;
    readonly antitemper: string;
    readonly unit_quantity: number | null;
  };
  readonly limits: readonly {
    readonly name: string;
    readonly value: string;
  }[];
  readonly weight_uniformity: string;
}
