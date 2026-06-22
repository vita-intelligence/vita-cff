/**
 * Transport types for the proposals domain.
 *
 * A Proposal is the commercial counterpart to the spec sheet — it
 * quotes a price for a frozen formulation version, renders against
 * one of two .docx-derived templates (Custom vs Ready to Go), and
 * can be attached to a spec sheet so both are signed together on
 * the kiosk.
 */

export const PROPOSAL_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "sent",
  "accepted",
  "rejected",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_TEMPLATE_TYPES = ["custom", "ready_to_go"] as const;
export type ProposalTemplateType = (typeof PROPOSAL_TEMPLATE_TYPES)[number];

export interface ProposalLineDto {
  readonly id: string;
  readonly formulation_version: string | null;
  readonly formulation_id: string | null;
  readonly formulation_name: string | null;
  readonly formulation_version_number: number | null;
  readonly specification_sheet: string | null;
  readonly specification_sheet_id: string | null;
  readonly product_code: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit_cost: string | null;
  readonly unit_price: string | null;
  readonly display_order: number;
  readonly subtotal: string | null;
}

export interface CreateProposalLineRequestDto {
  readonly formulation_version_id?: string | null;
  readonly specification_sheet_id?: string | null;
  readonly product_code?: string;
  readonly description?: string;
  readonly quantity?: number;
  readonly unit_cost?: string | null;
  readonly unit_price?: string | null;
  readonly display_order?: number;
}

export type UpdateProposalLineRequestDto = Partial<CreateProposalLineRequestDto>;

/**
 * Detail-endpoint shape — what ``GET /proposals/<id>/`` returns.
 *
 * The org-wide list endpoint serves the lighter :type:`ProposalListItemDto`
 * (no nested ``lines`` array, no signature image blobs) — see that
 * type below. Callers reading from list endpoints should consume the
 * list type so they pull only the fields the UI actually needs.
 */
export interface ProposalDto {
  readonly id: string;
  readonly code: string;
  readonly status: ProposalStatus;
  readonly template_type: ProposalTemplateType;
  readonly formulation_version: string;
  readonly formulation_id: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number;
  readonly specification_sheet_id: string | null;
  //: FK to the linked ``Customer`` record (addressbook entry). ``null``
  //: when the proposal was created before customer-picker rollout — the
  //: edit panel still shows the manual customer fields for those.
  readonly customer_id: string | null;
  readonly lines: readonly ProposalLineDto[];
  readonly customer_name: string;
  readonly customer_email: string;
  readonly customer_phone: string;
  readonly customer_company: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
  readonly dear_name: string;
  readonly reference: string;
  //: Per-proposal sales-person override. ``null`` means "inherit
  //: from the linked project's sales_person"; any value here takes
  //: precedence over the project when the proposal renders.
  readonly sales_person_id: string | null;
  readonly sales_person_name: string;
  //: Effective signatory rendered on the proposal (override when set,
  //: otherwise the project's sales_person). Convenience field so the
  //: UI can show "inherited from project" hints without chasing
  //: another endpoint.
  readonly effective_sales_person_id: string | null;
  readonly effective_sales_person_name: string;
  readonly currency: string;
  readonly quantity: number;
  readonly unit_price: string | null;
  readonly freight_amount: string | null;
  readonly material_cost_per_pack: string | null;
  readonly margin_percent: string | null;
  //: Deposit % printed in the Custom-template deposit clause.
  //: Always populated (defaults to "50.00" on the server) so the
  //: editor never has to guess between "unset" and "zero".
  readonly deposit_percent: string;
  readonly subtotal: string | null;
  readonly total_excl_vat: string | null;
  readonly cover_notes: string;
  readonly valid_until: string | null;
  readonly public_token: string | null;
  readonly prepared_by_signed_at: string | null;
  readonly director_signed_at: string | null;
  //: Structured signature payloads. ``null`` means "not captured
  //: yet"; any non-null value carries name + ISO timestamp + the
  //: signature image data URL so the contract renders it inline.
  readonly prepared_by: ProposalSignatureSlot | null;
  readonly director: ProposalSignatureSlot | null;
  readonly customer_signature: ProposalCustomerSignature | null;
  readonly customer_signer_name: string;
  readonly customer_signer_email: string;
  readonly customer_signer_company: string;
  readonly customer_signed_at: string | null;
  //: Set when the customer declines via the kiosk's Decline button.
  //: ``customer_rejection_reason`` is whatever they typed in the
  //: modal (empty string if they declined without explaining).
  readonly customer_rejected_at: string | null;
  readonly customer_rejection_reason: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Row shape returned by the org-wide / per-project / status-filtered
 * list endpoints. Two deliberate trims vs. :type:`ProposalDto`:
 *
 *   * No ``lines`` array — the list UI only reads ``lines_count`` to
 *     render the "N products" badge. Shipping the array per row was
 *     the dominant wire-size cost on the proposals page (and the
 *     entry point for an N+1 query per line's formulation chain).
 *   * Signature image data URLs are blanked. The list cards still
 *     show "Signed on X" pills (the name + timestamp keys are kept),
 *     but the base64 PNG bytes are stripped — they're only ever
 *     rendered on the detail page.
 *
 * Every other key lines up with :type:`ProposalDto` so the existing
 * row renderers continue to work after the swap.
 */
export interface ProposalListItemDto
  extends Omit<ProposalDto, "lines"> {
  readonly lines_count: number;
}


/**
 * Cursor-paginated envelope from ``GET /proposals/`` — same shape
 * the formulations + catalogues list endpoints emit. ``next`` /
 * ``previous`` are opaque URLs the client walks verbatim; the
 * pagination class lives at
 * :class:`apps.proposals.api.pagination.ProposalCursorPagination`.
 */
export interface PaginatedProposalsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly ProposalListItemDto[];
}


export interface CreateProposalRequestDto {
  readonly formulation_version_id: string;
  readonly specification_sheet_id?: string | null;
  readonly customer_id?: string | null;
  readonly template_type?: ProposalTemplateType | null;
  readonly code?: string;
  readonly customer_name?: string;
  readonly customer_email?: string;
  readonly customer_phone?: string;
  readonly customer_company?: string;
  readonly invoice_address?: string;
  readonly delivery_address?: string;
  readonly dear_name?: string;
  readonly reference?: string;
  readonly currency?: string;
  readonly quantity?: number;
  readonly unit_price?: string | null;
  readonly freight_amount?: string | null;
  readonly margin_percent?: string | null;
  readonly deposit_percent?: string | null;
  readonly material_cost_per_pack?: string | null;
  readonly cover_notes?: string;
  readonly valid_until?: string | null;
}

export type UpdateProposalRequestDto = Partial<
  Omit<CreateProposalRequestDto, "formulation_version_id">
> & {
  //: Explicit ``null`` clears the override and falls back to the
  //: project's sales_person. Omitting the key leaves the current
  //: value in place.
  readonly sales_person_id?: string | null;
};

export interface ProposalTransitionDto {
  readonly id: string;
  readonly from_status: ProposalStatus;
  readonly to_status: ProposalStatus;
  readonly actor: string;
  readonly actor_name: string;
  readonly notes: string;
  readonly created_at: string;
}

export interface ProposalStatusRequestDto {
  readonly status: ProposalStatus;
  readonly signature_image?: string;
  readonly notes?: string;
  readonly customer_name?: string;
  readonly customer_email?: string;
  readonly customer_company?: string;
}

export interface CostPreviewDto {
  readonly material_cost_per_pack: string;
  readonly margin_percent: string | null;
  readonly suggested_unit_price: string;
  readonly currency: string;
}


// ---------------------------------------------------------------------------
// Proposal-centric kiosk (``/p/proposal/<token>``)
// ---------------------------------------------------------------------------


/** Three structured signature slots on the proposal. Each one is
 *  ``null`` until captured, then carries name + timestamp + the
 *  signature image data URL. */
export interface ProposalSignatureSlot {
  readonly name: string;
  readonly signed_at: string;
  readonly image: string;
}


export interface ProposalCustomerSignature {
  readonly name: string;
  readonly email: string;
  readonly company: string;
  readonly signed_at: string;
  readonly image: string;
}


/** One specification sheet attached to a proposal, as exposed on
 *  the public kiosk payload. ``customer_signed_at`` goes non-null
 *  once the client has captured their signature for this doc but
 *  the status stays ``sent`` until the finalize call advances the
 *  whole bundle. */
export interface ProposalKioskSpecDto {
  readonly id: string;
  readonly code: string;
  readonly document_kind: "draft" | "final";
  readonly formulation_name: string;
  readonly formulation_version_number: number | null;
  readonly public_token: string | null;
  readonly status: string;
  readonly customer_signed_at: string | null;
  readonly has_signature: boolean;
  /** Inline render data — same payload the standalone spec kiosk
   *  consumes. Driven through the ``SpecSheetContent`` React
   *  component so the proposal kiosk renders each attached spec
   *  client-side from JSON rather than iframing a heavyweight PDF
   *  render. Typed as ``unknown`` here to avoid pulling the
   *  specifications-domain types into the proposals type module
   *  (circular concern) — consumers cast at the import site. */
  readonly render_context: unknown;
}


/** Full kiosk payload for one proposal — the proposal's own
 *  cover-letter fields plus every attached spec sheet's per-doc
 *  signature state. The client renders one signature pad per
 *  document and the finalize button flips the whole set atomically
 *  once every ``has_signature`` is true. */
export interface ProposalKioskLineDto {
  readonly id: string;
  readonly product_code: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit_price: string | null;
  readonly subtotal: string | null;
}

export interface ProposalKioskDto {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  /** ``custom`` triggers the lab-dev letter + Appendix 1; ``ready_to_go``
   *  uses the shorter terms block + adds the Freight / Total rows. */
  readonly template_type: "custom" | "ready_to_go";
  /** Effective sales-person name (proposal-level override wins,
   *  otherwise inherited from the parent project's ``sales_person``).
   *  Empty string when neither slot is set — the kiosk falls back
   *  to a generic team label in that case. */
  readonly sales_person_name: string;
  readonly customer_company: string;
  readonly customer_name: string;
  readonly customer_email: string;
  readonly customer_phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
  readonly reference: string;
  readonly dear_name: string;
  readonly currency: string;
  readonly quantity: number;
  readonly unit_price: string | null;
  readonly freight_amount: string | null;
  readonly subtotal: string | null;
  readonly total_excl_vat: string | null;
  readonly valid_until: string | null;
  /** Per-line pricing rows — driven by ``ProposalLine`` rows on the
   *  proposal, ordered by ``display_order``. Empty when the proposal
   *  was created before the multi-line refactor; the kiosk reading
   *  panel falls back to a single header-level row in that case. */
  readonly lines: readonly ProposalKioskLineDto[];
  readonly customer_signed_at: string | null;
  readonly has_signature: boolean;
  /** Customer-facing acknowledgement tickboxes — three required
   *  consents matching the ☐ boxes in the docx template. The kiosk
   *  disables the Sign button until all three are ticked, and the
   *  rendered PDF flips ☐ → ☑ for each one when set. */
  readonly ack_spec_signing: boolean;
  readonly ack_lead_times: boolean;
  readonly ack_terms: boolean;
  /** Custom-template-only — the R&D / Sampling Terms acknowledgement.
   *  Ready-to-Go proposals don't show this row and the value stays
   *  ``false`` for them; the backend only enforces it on Custom. */
  readonly ack_rd_terms: boolean;
  readonly attached_specs: readonly ProposalKioskSpecDto[];
}

/**
 * E-signature audit-trail row for one document on a proposal.
 * Backed by the columns the kiosk writes at sign time:
 * IP (X-Forwarded-For-aware), raw User-Agent, and a SHA-256 hash of
 * the rendered HTML the signer saw. ``current_hash`` is computed
 * fresh by the backend on every request — if it disagrees with
 * ``stored_hash``, ``hash_matches`` flips to ``false`` and the
 * document has drifted since signing.
 */
export interface ProposalAuditDocumentDto {
  readonly signer_name: string;
  readonly signer_email: string;
  readonly signer_company: string;
  readonly signed_at: string | null;
  readonly ip: string;
  readonly user_agent: string;
  readonly stored_hash: string;
  readonly current_hash: string;
  readonly hash_matches: boolean;
}

export interface ProposalAuditSpecDto extends ProposalAuditDocumentDto {
  readonly id: string;
  readonly code: string;
  readonly formulation_name: string;
}

export interface ProposalAuditDto {
  readonly proposal: ProposalAuditDocumentDto;
  readonly specs: readonly ProposalAuditSpecDto[];
}


/**
 * Customer-portal activity event recorded against the proposal —
 * one row per observable thing the customer did (clicked the
 * activation link, signed in, opened the proposal, …). Kinds match
 * :class:`apps.client_portal.models.PortalEvent.Kind` server-side;
 * leaving the field as ``string`` so the FE can render an unknown
 * kind as plain text rather than crashing if the backend adds a
 * new one before the FE bundle ships.
 */
/**
 * Optional pointer to the specific artifact this event acted on.
 * Today only ``spec`` events carry a target (so the FE can render
 * "Opened spec: Strawberry Powder" instead of just "Opened spec");
 * left as a discriminated union so a future ``signature`` /
 * ``download`` target can land without re-shaping the DTO.
 */
export type ProposalActivityTarget =
  | {
      readonly kind: "spec";
      readonly id: string;
      readonly code: string;
      readonly formulation_name: string;
    };

export interface ProposalActivityEventDto {
  readonly id: string;
  readonly kind: string;
  readonly created_at: string;
  readonly client_account: {
    readonly id: string;
    readonly email: string;
  } | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly target: ProposalActivityTarget | null;
}

export interface ProposalActivitySummarySlot {
  readonly first_at: string | null;
  readonly last_at: string | null;
  readonly count: number;
}

export interface ProposalActivityDto {
  readonly events: readonly ProposalActivityEventDto[];
  /** Per-kind rollup so the panel header can show
   *  "First opened: 2h ago · Last opened: 12m ago" without
   *  iterating ``events`` on the client. */
  readonly summary: Readonly<
    Record<string, ProposalActivitySummarySlot>
  >;
}
