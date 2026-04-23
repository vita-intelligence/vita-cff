/**
 * Transport types for the trial-batches domain.
 */

/** ``pack`` means the entered number is multiplied by the
 *  formulation's ``servings_per_pack`` snapshot to reach a finished
 *  unit count; ``unit`` means the entered number IS the raw count of
 *  finished units. Scientists pick ``unit`` for bench-scale QC tests
 *  (e.g. 10 capsules) so the BOM doesn't silently scale it to 3 600. */
export type BatchSizeMode = "pack" | "unit";

export interface TrialBatchDto {
  readonly id: string;
  readonly label: string;
  readonly batch_size_units: number;
  readonly batch_size_mode: BatchSizeMode;
  readonly notes: string;
  readonly formulation_version: string;
  readonly formulation_id: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number;
  readonly created_by_name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateTrialBatchRequestDto {
  readonly formulation_version_id: string;
  readonly batch_size_units: number;
  readonly batch_size_mode?: BatchSizeMode;
  readonly label?: string;
  readonly notes?: string;
}

export type UpdateTrialBatchRequestDto = Partial<{
  readonly label: string;
  readonly batch_size_units: number;
  readonly batch_size_mode: BatchSizeMode;
  readonly notes: string;
}>;

/** One line in the scaled-up bill of materials — all weights come
 * back as strings so JS number imprecision never touches procurement
 * quantities. Three granularities (per unit / per pack / per batch)
 * ship on every row so the scientist can sanity-check the scale-up
 * at whichever level is relevant to the decision they're making. */
export interface BOMEntry {
  readonly category: "active" | "excipient" | "shell";
  readonly label: string;
  readonly internal_code: string;
  /** Procurement UOM — ``"weight"`` for powders / oils / extracts
   * bought in kg, ``"count"`` for discrete components like empty
   * capsule shells tracked as ``each`` in every ERP. */
  readonly uom: "weight" | "count";
  readonly mg_per_unit: string;
  readonly g_per_pack: string;
  readonly mg_per_batch: string;
  readonly g_per_batch: string;
  readonly kg_per_batch: string;
  /** For count-UOM lines, total discrete pieces the batch needs (one
   * shell per capsule). Zero for weight-UOM lines so procurement
   * never misreads a kg figure as a piece count. */
  readonly count_per_batch: number;
}

export interface BOMResult {
  readonly batch_id: string;
  readonly label: string;
  /** Entered number; interpretation depends on ``batch_size_mode``. */
  readonly batch_size_units: number;
  readonly batch_size_mode: BatchSizeMode;
  /** Individual capsules/tablets/etc. inside each finished pack. */
  readonly units_per_pack: number;
  /** Total individual units the BOM multiplies mg-per-unit against.
   * In ``pack`` mode that's ``batch_size_units × units_per_pack``;
   * in ``unit`` mode it equals ``batch_size_units`` directly. */
  readonly total_units_in_batch: number;
  readonly formulation_id: string;
  readonly formulation_name: string;
  readonly version_number: number;
  readonly version_label: string;
  readonly dosage_form: string;
  readonly size_label: string | null;
  readonly entries: readonly BOMEntry[];
  /** Fill-weight totals — sum of weight-UOM lines only (active +
   * excipient). Excludes the capsule shell because shells are
   * procured by count, not weight. */
  readonly total_mg_per_unit: string;
  readonly total_g_per_pack: string;
  readonly total_mg_per_batch: string;
  readonly total_g_per_batch: string;
  readonly total_kg_per_batch: string;
  /** Sum of count-UOM lines — how many empty shells procurement
   * orders for the run. Zero for dosage forms with no shell. */
  readonly total_count_per_batch: number;
}
