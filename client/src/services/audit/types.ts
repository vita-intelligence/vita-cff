/**
 * Transport types for the audit log domain.
 *
 * Mirrors :mod:`apps.audit.api.serializers`. ``before`` / ``after``
 * are deliberately ``unknown`` — every caller has its own payload
 * shape and narrowing belongs at the consumer, not in this barrel.
 */


export interface AuditActorDto {
  readonly id: string;
  readonly full_name: string;
  readonly email: string;
}


export interface AuditLogEntryDto {
  readonly id: string;
  /** Action slug in ``{module}.{verb}`` form (e.g.
   * ``formulation.update``, ``spec_sheet.status_transition``). */
  readonly action: string;
  readonly target_type: string;
  readonly target_id: string;
  /** ``null`` when the actor was the system (seed signals, data
   * migrations, a deleted user). */
  readonly actor: AuditActorDto | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly created_at: string;
}


export interface PaginatedAuditLogDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly AuditLogEntryDto[];
}


/** Query filters the caller may attach to an audit list request.
 * All optional; blanks are dropped before being sent. */
export interface AuditLogFilters {
  readonly action?: string;
  readonly action_prefix?: string;
  readonly target_type?: string;
  readonly actor?: string;
  readonly since?: string;
  readonly until?: string;
}
