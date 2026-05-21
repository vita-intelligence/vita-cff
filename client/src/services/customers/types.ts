/** Transport types for the customers domain. */

export interface CustomerDto {
  readonly id: string;
  readonly name: string;
  readonly company: string;
  readonly email: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
  readonly notes: string;
  /** Dataverse GUID this customer mirrors. ``null`` for customers
   *  the team entered locally; populated for ones imported from
   *  the Microsoft Dynamics picker. Drives the "From Dynamics"
   *  chip on the picker + the customers list. */
  readonly dynamics_id: string | null;
  readonly dynamics_synced_at: string | null;
  /** ``true`` when at least one ``ClientAccount`` row exists for
   *  this customer — covers both pending (issued but not yet
   *  activated) and fully-activated portal logins. Drives the
   *  "Portal login" badge on the customers list and the
   *  delete-affordance guard (a customer with a portal account
   *  cannot be deleted from the staff side). */
  readonly has_portal_account: boolean;
  /** ``true`` when at least one of the customer's portal accounts
   *  has set a password (``activated_at`` populated). Used to
   *  distinguish "Active" from "Pending" on the badge tooltip. */
  readonly portal_account_activated: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateCustomerRequestDto {
  readonly name?: string;
  readonly company?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly invoice_address?: string;
  readonly delivery_address?: string;
  readonly notes?: string;
}

export type UpdateCustomerRequestDto = CreateCustomerRequestDto;


/**
 * One Dynamics contact returned by the search endpoint. Same shape
 * as :class:`DynamicsContact` on the server. The picker resolves
 * these to local :class:`CustomerDto` rows via the import endpoint
 * (called on selection — no preemptive bulk import).
 */
export interface DynamicsContactSuggestion {
  readonly dynamics_id: string;
  readonly name: string;
  readonly company: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
}


export interface DynamicsSearchResponse {
  readonly results: readonly DynamicsContactSuggestion[];
  /** ``false`` when the org has no usable Dynamics integration
   *  (no config, missing credentials, or decryption failure).
   *  The picker uses this to hide the Dynamics-specific UI strips
   *  when the integration isn't set up. */
  readonly configured: boolean;
}


/** Wire shape for ``GET /integrations/dynamics/`` — owner-only.
 *  ``has_secret`` is a boolean stand-in for the plaintext client
 *  secret so the form can render a "●●●●●●●" placeholder without
 *  ever exposing the value. */
export interface DynamicsIntegrationConfigDto {
  readonly enabled: boolean;
  readonly dataverse_url: string;
  readonly tenant_id: string;
  readonly client_id: string;
  readonly has_secret: boolean;
  readonly last_tested_at: string | null;
}


export interface DynamicsIntegrationConfigUpdateDto {
  readonly enabled: boolean;
  readonly dataverse_url: string;
  readonly tenant_id: string;
  readonly client_id: string;
  /** Empty string or omitted means "keep the previously stored
   *  secret". Non-empty rotates it. Lets admins edit the
   *  Dataverse URL without re-typing the secret. */
  readonly client_secret?: string;
}
