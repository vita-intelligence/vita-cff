/**
 * Transport types for the organizations domain.
 *
 * Mirrors the backend ``OrganizationReadSerializer`` output. Member
 * management types will land here later when we expose those endpoints.
 */

export interface OrganizationDto {
  readonly id: string;
  readonly name: string;
  /** ``true`` when the currently-authenticated caller is the owner. */
  readonly is_owner: boolean;
  /**
   * Caller's grants on this org as ``{ module_key: level }``. Always
   * empty for owners (they bypass the map); for non-owners this is
   * the raw map stored on their membership.
   */
  readonly permissions: Record<string, string>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateOrganizationRequestDto {
  readonly name: string;
}

export type CreateOrganizationResponseDto = OrganizationDto;
