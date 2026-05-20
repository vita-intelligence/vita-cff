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


export interface CFFSubmissionDto {
  readonly id: string;
  readonly wix_submission_id: string;
  readonly wix_form_id: string;
  readonly wix_namespace: string;
  readonly wix_status: CFFSubmissionStatus;
  readonly wix_created_date: string;
  readonly wix_updated_date: string;
  /** Raw Wix payload — the UI walks ``submissions`` to render the
   *  form fields with labels from the schema cache. */
  readonly raw_payload: Record<string, unknown>;
  readonly project: CFFProjectRefDto | null;
  readonly assigned_by: CFFAuthorDto | null;
  readonly assigned_at: string | null;
  readonly imported_at: string;
  readonly last_synced_at: string;
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
