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
  /** PSP Manufacturing Order uuid this batch spawned. ``null``
   *  when the scientist hasn't clicked "Create MO on PSP" yet;
   *  populated on that action + used as the PSP-side idempotency
   *  key so retries don't duplicate. */
  readonly psp_manufacturing_order_uuid: string | null;
  /** Terminal-or-in-progress validation status attached to this
   *  batch. ``null`` when no validation record exists yet. When
   *  ``"passed"``, the batch is the evidentiary root of downstream
   *  artefacts (the FINAL spec's audit row cites it) — server
   *  refuses to delete it and the FE hides the delete button. */
  readonly validation_status:
    | "draft"
    | "in_progress"
    | "passed"
    | "failed"
    | null;
  readonly created_by_name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateTrialBatchPspMoRequestDto {
  /** Optional. When omitted, the server defaults to the trial
   *  batch's ``batch_size_units``. Only override for the rare case
   *  when a scientist wants PSP to run a smaller MO than the planned
   *  scale. */
  readonly quantity?: number;
  /** Required. PSP warehouse UUID picked from the R&D warehouse
   *  dropdown. Was previously a global setting; per-MO now so
   *  multi-site R&D setups can route each trial batch to the right
   *  warehouse without editing settings. */
  readonly warehouse_uuid: string;
  /** Optional. Defaults to ``"trial"`` server-side. */
  readonly project_type?: "trial" | "sample";
  /** Optional finished-product item override. When absent, the
   *  server resolves from ``formulation.psp_finished_product_uuid``. */
  readonly item_uuid?: string;
  readonly due_date?: string;
  readonly notes?: string;
}

/** MO summary PSP returns on create — shape mirrors PSP's
 *  ``IntegrationManufacturingOrderController.mo_summary`` verbatim. */
export interface PspManufacturingOrderSummaryDto {
  readonly uuid: string;
  readonly status: string;
  readonly quantity: string;
  readonly project_type: string;
  readonly npd_trial_batch_uuid: string;
  readonly due_date: string | null;
  readonly inserted_at: string;
}

export interface CreateTrialBatchPspMoResponseDto {
  readonly manufacturing_order: PspManufacturingOrderSummaryDto;
  readonly trial_batch: TrialBatchDto;
}

/** One booking on the trial MO — shape mirrors PSP's
 *  ``IntegrationManufacturingOrderController.booking_payload``. */
export interface PspTrialMoBookingDto {
  readonly uuid: string;
  readonly status: string;
  readonly quantity: string;
  readonly picked_at: string | null;
  readonly item: { readonly uuid: string; readonly name: string } | null;
  readonly lot:
    | { readonly uuid: string; readonly status: string }
    | null;
  readonly cell: { readonly uuid: string; readonly name: string } | null;
}

export interface PspTrialMoBookingsResponseDto {
  readonly bookings: readonly PspTrialMoBookingDto[];
  readonly summary: {
    readonly total: number;
    readonly picked: number;
    readonly released: number;
    readonly consumed: number;
    readonly outstanding: number;
  };
}

/** One node in the parent → child MO tree. Depth is 0 for the root
 *  (finished-product MO); every semi-finished child adds 1. Sorted
 *  by (depth, inserted_at) on the server so the FE can render as a
 *  flat indented list without re-computing the tree. */
export interface PspTrialMoChainNodeDto {
  readonly uuid: string;
  readonly status: string;
  readonly quantity: string;
  readonly project_type: string;
  readonly npd_trial_batch_uuid: string | null;
  readonly due_date: string | null;
  readonly inserted_at: string;
  readonly parent_uuid: string | null;
  readonly depth: number;
  readonly is_root: boolean;
  readonly item: { readonly uuid: string; readonly name: string } | null;
}

export interface PspTrialMoChainResponseDto {
  readonly chain: readonly PspTrialMoChainNodeDto[];
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
