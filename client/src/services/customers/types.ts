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

/** Payload shape for ``GET /customers/<id>/overview/`` — the
 *  aggregator endpoint the staff customer detail page renders from.
 *  Every field the page needs to render in one round-trip so we
 *  don't waterfall spinners for each panel. */
export interface CustomerOverviewDto {
  readonly customer: CustomerDto;
  readonly portal_accounts: readonly CustomerPortalAccountDto[];
  readonly proposals: readonly CustomerProposalSummaryDto[];
  readonly cff_submissions: readonly CustomerCFFSummaryDto[];
  readonly totals: {
    readonly proposals_count: number;
    readonly accepted_proposals_count: number;
    /** ``total_excl_vat`` summed across every ``status="accepted"``
     *  proposal for this customer. Renders as the "Revenue" chip on
     *  the header. Decimal string so display code preserves the
     *  precise value from the backend. */
    readonly accepted_revenue: string;
    readonly cff_submissions_count: number;
    readonly portal_accounts_count: number;
  };
}


export interface CustomerPortalAccountDto {
  readonly id: string;
  readonly email: string;
  readonly is_active: boolean;
  readonly activated_at: string | null;
  readonly last_login_at: string | null;
  readonly created_at: string;
  readonly privacy_accepted_at: string | null;
}


export interface CustomerProposalSummaryDto {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly template_type: "custom" | "ready_to_go";
  readonly currency: string;
  readonly quantity: number | null;
  readonly unit_price: string | null;
  readonly total_excl_vat: string | null;
  readonly valid_until: string | null;
  readonly updated_at: string;
  readonly created_at: string;
  readonly formulation: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly project_type: "custom" | "ready_to_go";
  } | null;
  readonly sales_person: {
    readonly id: string;
    readonly full_name: string;
    readonly email: string;
  } | null;
}


/** Trimmed CFFSubmission shape. Only the fields the detail page's
 *  requests section actually renders; ``raw_payload`` and the Wix
 *  meta are dropped because they're not on this surface. Server
 *  serialiser still returns the full shape — the FE type is a
 *  narrower view of the same JSON. */
export interface CustomerCFFSummaryDto {
  readonly id: string;
  readonly submission_kind: "custom" | "ready_to_go";
  readonly provenance: "wix" | "portal";
  readonly is_rejected: boolean;
  readonly is_assigned: boolean;
  readonly rejection_reason: string;
  readonly imported_at: string;
  readonly drafted_proposal_id: string | null;
  readonly drafted_proposal_code: string | null;
  readonly assignments: readonly {
    readonly project: {
      readonly id: string;
      readonly code: string;
      readonly name: string;
    };
  }[];
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
 * Response from ``POST /api/organizations/<org>/customers/<id>/
 * portal-invites/``.
 *
 * The 6-digit verification code is **not** in the payload — it goes
 * out over email to the customer's own inbox so it stays out of band
 * from the URL the staff caller is about to paste somewhere. The
 * staff-side UI just copies ``activation_url`` to the clipboard and
 * shows a hint that the customer also needs to check their email.
 */
export interface CustomerPortalInviteResponseDto {
  readonly activation_url: string;
  readonly expires_at: string;
  readonly email_snapshot: string;
}


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
  /** Parent Dataverse account GUID. ``null`` when the picked row
   *  is a contact with no parent account (rare — freelancer
   *  records). The import endpoint anchors on this so the same
   *  business never duplicates into two local customers. */
  readonly account_id: string | null;
  /** Dataverse contact GUID. ``null`` when the picked row is an
   *  account directly (no specific person chosen yet). */
  readonly contact_id: string | null;
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
