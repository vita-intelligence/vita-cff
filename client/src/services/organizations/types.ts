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
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateOrganizationRequestDto {
  readonly name: string;
}

export type CreateOrganizationResponseDto = OrganizationDto;
