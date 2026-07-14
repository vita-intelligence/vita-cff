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
  /**
   * ``true`` when the org has a live Microsoft Dynamics integration
   * (enabled + credentials stored). Drives the "manual customer
   * creation is disabled" banner + hides every ``Create new``
   * affordance in the customer surfaces — those orgs require all
   * customers to flow through the Dynamics import path so Dataverse
   * stays the single source of truth.
   *
   * Edits remain allowed regardless: a local field tweak on a
   * previously-imported customer isn't a divergence from Dataverse
   * (we have no auto-sync today), it's an explicit local override.
   */
  readonly dynamics_customers_managed: boolean;
  /**
   * ``true`` when the org has a live MRPEasy integration
   * (enabled + credentials stored). Drives the render gate on the
   * ``<MrpeasyPriceHint>`` component — without it set, the hint
   * stays silent so we don't surface "no MRPEasy match" alarmism
   * to orgs that haven't connected the integration yet.
   */
  readonly mrpeasy_live: boolean;
  /**
   * ``true`` when the org has a live PSP integration (enabled +
   * base URL + integration token stored). Mutually exclusive with
   * ``mrpeasy_live`` at the setter level — enabling one clears the
   * other on the same org. The FE reads both to route picker /
   * price-hint components at the correct backend (PSP wins when
   * live).
   */
  readonly psp_live: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateOrganizationRequestDto {
  readonly name: string;
}

export type CreateOrganizationResponseDto = OrganizationDto;
