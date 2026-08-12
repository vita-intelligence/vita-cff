/**
 * Transport types for the CFF submissions domain.
 *
 * Mirror of the backend ``CFFSubmissionSerializer`` and the
 * ``serialize_wix_cff_config_for_api`` shape. The plaintext Wix
 * API key is never on the wire — the form uses ``has_api_key`` to
 * decide between "type a new key" and the ●●● masked placeholder
 * (same UX as the MRPEasy and Dynamics settings cards).
 */

export type CFFSubmissionStatus =
  | "CONFIRMED"
  | "PENDING"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_PENDING"
  | "PAYMENT_CANCELED"
  | "UNKNOWN";


export interface CFFProjectRefDto {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}


export interface CFFAuthorDto {
  readonly id: string;
  readonly full_name: string;
  readonly email: string;
}


/**
 * One CFF↔project link as it appears in
 * :class:`CFFSubmissionDto.assignments`.
 *
 * Each link carries its own audit row (who attached the CFF to this
 * project and when). A CFF can hold zero, one, or many of these —
 * the empty array is the "still in triage" state the inbox keys on
 * via :attr:`CFFSubmissionDto.is_assigned`.
 */
export interface CFFAssignmentDto {
  readonly project: CFFProjectRefDto;
  readonly assigned_by: CFFAuthorDto | null;
  readonly assigned_at: string;
}


export interface CFFSubmissionDto {
  readonly id: string;
  /** ``"wix"`` for rows ingested from the marketing form,
   *  ``"portal"`` for rows submitted by an authenticated customer in
   *  the portal wizard. Drives whether the ``wix_*`` fields carry
   *  values or come back nullish. */
  readonly provenance?: "wix" | "portal";
  /** ``"custom"`` (default) or ``"ready_to_go"``. RTG rows carry a
   *  pre-drafted proposal via ``drafted_proposal_id``. */
  readonly submission_kind?: "custom" | "ready_to_go";
  /** Every ``wix_*`` field is null / empty on portal-provenance rows
   *  because they were never a Wix form submission. Wix-provenance
   *  rows always carry them. Consumers should either branch on
   *  ``provenance`` or fall back to a safe default. */
  readonly wix_submission_id: string | null;
  readonly wix_form_id: string | null;
  readonly wix_namespace: string;
  readonly wix_status: CFFSubmissionStatus | "" | null;
  readonly wix_created_date: string | null;
  readonly wix_updated_date: string | null;
  /** Raw Wix payload — the UI walks ``submissions`` to render the
   *  form fields with labels from the schema cache. */
  readonly raw_payload: Record<string, unknown>;
  /** Every project this CFF is currently linked to, ordered by the
   *  backend (most recent assignment first). Replaces the single
   *  ``project`` FK the v1 schema exposed. */
  readonly assignments: ReadonlyArray<CFFAssignmentDto>;
  /** Derived flag — ``true`` when ``assignments.length > 0``. The
   *  backend pre-computes it so the inbox can render the binary
   *  Assigned / Unassigned chip without walking the array. */
  readonly is_assigned: boolean;
  /** Rejected state — the alternative to assigning. When true the
   *  CFF sits in the Rejected tab and the details below are set. */
  readonly is_rejected: boolean;
  readonly rejected_at: string | null;
  readonly rejected_by: CFFAuthorDto | null;
  /** Reason typed by the triager when they rejected the CFF. Empty
   *  string when ``is_rejected`` is false. */
  readonly rejection_reason: string;
  readonly imported_at: string;
  readonly last_synced_at: string;
  /** UUID of the auto-drafted proposal for RTG submissions. ``null``
   *  on Custom rows (which don't get a proposal until triage picks a
   *  project and the sales rep clicks New proposal). Populated the
   *  moment the RTG order flow finishes on the backend. */
  readonly drafted_proposal_id?: string | null;
  /** Human-readable code of the drafted proposal — e.g.
   *  ``"PROP-0042"``. Present iff ``drafted_proposal_id`` is. Used by
   *  the triage inbox to render "Drafted as PROP-0042" instead of a
   *  bare UUID. */
  readonly drafted_proposal_code?: string | null;
}


export interface CFFSyncStatusDto {
  readonly enabled: boolean;
  /** ISO timestamp of the last successful poll cycle, or ``null``
   *  when the poller has not yet run for this org. */
  readonly last_poll_at: string | null;
  /** Celery beat cadence in seconds. The UI shows it verbatim
   *  (e.g. "every 5 minutes") so a future cadence change in
   *  ``CELERY_BEAT_SCHEDULE`` propagates without a frontend
   *  update. ``null`` for non-numeric schedules (cron expressions). */
  readonly poll_interval_seconds: number | null;
}


/** Cursor-paginated wrapper (DRF ``CursorPagination``).
 *
 *  ``sync`` carries the just-completed lazy-poll metadata so the
 *  banner can stay in sync with the actual list refresh without a
 *  second round-trip. Same shape as :class:`CFFSyncStatusDto`; the
 *  list hook hydrates the sync-status query cache from this on
 *  every page load. */
export interface PaginatedCFFSubmissionsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: ReadonlyArray<CFFSubmissionDto>;
  readonly sync?: CFFSyncStatusDto;
  /** Per-state totals for the pipeline board's tab badges. Same
   *  block on every column's response so any query landing
   *  first refreshes every badge. Scoped by the current
   *  ``search`` param so a narrowing query updates counts too. */
  readonly counts?: {
    readonly unassigned: number;
    readonly assigned: number;
    readonly rejected: number;
  };
}


export interface CFFFieldLabelsDto {
  /** ``{form_id: {slug: label}}`` map for every form the cache
   *  knows about. The list page fetches this once on mount and
   *  reuses it across rows. */
  readonly field_labels_by_form: Record<string, Record<string, string>>;
}


// ---------------------------------------------------------------------------
// Integration settings (owner-only)
// ---------------------------------------------------------------------------


export interface WixCFFConfigDto {
  readonly enabled: boolean;
  /** True when the org has a stored Wix API key. The plaintext
   *  value is never returned. Drives the "Connected — last tested …"
   *  badge and the Test button's enabled state. */
  readonly has_api_key: boolean;
  readonly site_id: string;
  readonly form_id: string;
  readonly namespace: string;
  /** ISO timestamp of the last successful Test, or ``null`` when
   *  never tested (or when the key was rotated since). */
  readonly last_tested_at: string | null;
  /** Only populated by the ``POST /test/`` endpoint — the count
   *  endpoint returns the total number of submissions on Wix's
   *  side so the settings card can show "11 submissions
   *  discovered". */
  readonly total_submissions?: number;
}


export interface SaveWixCFFConfigRequestDto {
  readonly enabled: boolean;
  readonly site_id: string;
  readonly form_id: string;
  readonly namespace: string;
  /** Plaintext API key. ``null`` (or empty string) is the
   *  "keep existing key" sentinel — the backend preserves
   *  whatever's already on file. */
  readonly api_key?: string | null;
}


// ---------------------------------------------------------------------------
// Create-project-from-CFF (one-click triage)
// ---------------------------------------------------------------------------


export interface CreateProjectFromCFFRequestDto {
  readonly name: string;
  readonly code: string;
  readonly description?: string;
  readonly dosage_form?: string;
  readonly capsule_size?: string;
  readonly tablet_size?: string;
  readonly serving_size?: number;
  readonly servings_per_pack?: number;
  readonly directions_of_use?: string;
  readonly suggested_dosage?: string;
  readonly appearance?: string;
  readonly disintegration_spec?: string;
  /** Decimal as string — matches the manual new-project payload. */
  readonly target_fill_weight_mg?: string | null;
  readonly powder_type?: string;
  readonly water_volume_ml?: string | null;
}


export interface CreateProjectFromCFFResponseDto {
  readonly submission: CFFSubmissionDto;
  readonly project: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
  };
  /** Populated when the server matched the customer's
   *  ``vita_manufacture_account_manager_email`` against an org
   *  member with the ``formulations.assign_sales_person`` cap
   *  in scope. ``null`` when the email was missing, the match
   *  failed, or the caller's role couldn't auto-assign. */
  readonly auto_assigned_sales_person:
    | { readonly id: string; readonly email: string }
    | null;
  /** The email value the server tried to match against. Surfaced
   *  even when the match failed so the UI can show "tried Y —
   *  no team member matches, assign manually". */
  readonly cff_sales_person_email_hint: string | null;
  /** ``false`` when the caller lacks ``formulations.assign_sales_person``.
   *  Drives the "Sales person auto-assignment was skipped — you
   *  don't have permission" copy on the success toast. */
  readonly can_assign_sales_person: boolean;
}
