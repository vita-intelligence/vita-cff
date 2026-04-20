/**
 * Transport types for the organizations domain.
 *
 * Mirrors the backend ``OrganizationReadSerializer`` output. Member
 * management types will land here later when we expose those endpoints.
 */

export interface OrganizationDto {
  readonly id: string;
  readonly name: string;
  /**
   * Pre-billing access gate. New workspaces default to ``false`` and
   * a platform admin flips them on before members can use the app.
   * The frontend routes unauthorized members to a "pending activation"
   * screen when this is ``false`` for a workspace they own or belong to.
   */
  readonly is_active: boolean;
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
