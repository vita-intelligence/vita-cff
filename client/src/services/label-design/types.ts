/** DTOs + enums for the label-design domain. */

export type LabelDesignStatus =
  | "payment_pending"
  | "label_path_pending"
  | "design_preferences_pending"
  | "design_in_progress"
  | "scientist_review"
  | "director_review"
  | "customer_approval"
  | "label_approved"
  | "no_label_required"
  | "on_hold";

export type LabelDesignPath =
  | ""
  | "design_by_us"
  | "design_by_customer"
  | "no_label";

export type RevisionSource = "staff_upload" | "customer_upload";
export type ReviewKind = "scientist" | "director";
export type ReviewOutcome = "approved" | "requires_revision";

export interface LabelDesignRevisionDto {
  readonly id: string;
  readonly label_design: string;
  readonly revision_number: number;
  readonly source: RevisionSource;
  readonly submitted_by_user: string | null;
  readonly submitted_by_user_email: string;
  readonly submitted_by_client: string | null;
  readonly submitted_by_client_email: string;
  readonly submitted_at: string;
  readonly artwork_pdf_url: string;
  readonly artwork_preview_png_url: string;
  /** Supplementary artwork files attached to the same revision —
   *  "Back", "Left side", "Bottle mockup". Sorted by ``sort_order``.
   *  Empty when the uploader only sent the primary artwork. */
  readonly additional_assets: ReadonlyArray<LabelDesignRevisionAssetDto>;
  readonly compliance_block_snapshot: Record<string, unknown>;
  readonly customer_approved_own_design: boolean;
  readonly notes: string;
  /** Every verdict written against this revision, sorted
   *  scientist-first then director. Surfaces inline so neither
   *  the staff Versions tab nor the customer portal need a
   *  second round-trip to reconstruct the journey. */
  readonly reviews: ReadonlyArray<LabelDesignReviewDto>;
}

export interface LabelDesignRevisionAssetDto {
  readonly id: string;
  //: Storage URL for the file. Same origin as the primary artwork.
  readonly file_url: string;
  //: User-supplied label ("Back", "Left side"). Empty → the FE
  //: falls back to "View N".
  readonly label: string;
  readonly original_filename: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sort_order: number;
}

export interface LabelDesignReviewDto {
  readonly id: string;
  readonly revision: string;
  readonly kind: ReviewKind;
  readonly reviewer: string;
  readonly reviewer_email: string;
  readonly outcome: ReviewOutcome;
  readonly checklist_responses: Array<{
    readonly item_key: string;
    readonly pass: boolean;
    readonly comment: string;
  }>;
  readonly final_comments: string;
  readonly signature_image: string;
  readonly created_at: string;
}

export interface LabelDesignPreferencesDto {
  readonly id: string;
  readonly submitted_by_client: string;
  readonly submitted_by_client_email: string;
  readonly submitted_at: string;
  readonly company_name: string;
  readonly brand_name: string;
  readonly product_names: string;
  readonly product_codes: string;
  readonly brand_colours: Array<{ name: string; hex: string }>;
  readonly inspiration_urls: ReadonlyArray<string>;
  readonly inspiration_file_urls: ReadonlyArray<{
    readonly id: string;
    readonly url: string;
    readonly original_name: string;
    readonly size_bytes: number;
  }>;
  readonly elements_to_include: string;
  readonly design_style: string;
  readonly material_type: string;
  readonly additional_comments: string;
  readonly declaration_signed_at: string | null;
  readonly declaration_signature_image: string;
  readonly declaration_name: string;
  readonly declaration_position: string;
  readonly raw_payload: Record<string, unknown>;
}

export interface LabelDesignDto {
  readonly id: string;
  readonly organization: string;
  readonly organization_name: string;
  readonly formulation: string;
  readonly formulation_code: string;
  readonly formulation_name: string;
  readonly specification_sheet: string | null;
  /** Spec code used as the disambiguator when a project carries
   *  more than one spec. Each spec produces its own label-design
   *  row sharing the same ``formulation_code``, so this is the
   *  field the UI keys on to render "Spec A label" vs "Spec B
   *  label". Empty string when no spec is attached (legacy / pre-
   *  spec rows). */
  readonly specification_sheet_code: string;
  readonly status: LabelDesignStatus;
  readonly design_path: LabelDesignPath;
  readonly assigned_designer: string | null;
  readonly assigned_designer_email: string;
  readonly current_revision: string | null;
  readonly current_revision_detail: LabelDesignRevisionDto | null;
  readonly preferences_detail: LabelDesignPreferencesDto | null;
  readonly revisions: ReadonlyArray<LabelDesignRevisionDto>;
  readonly rejection_count: number;
  readonly customer_approved_at: string | null;
  //: Notes recorded on the most recent ON_HOLD transition (empty
  //: string when the workflow isn't on hold). Surfaced on the
  //: customer portal so the buyer sees *why* their label was
  //: paused, not just the bare status chip.
  readonly hold_reason: string;
  readonly hold_started_at: string | null;
  //: Design-fee headline surfaced on the choose-path card so the
  //: customer sees the cost of the "Vita designs" lane BEFORE they
  //: commit. Decimal string ("0" when the org hasn't set a fee) —
  //: FE reads 0 as free and hides the price chip.
  readonly design_by_us_fee_amount: string;
  readonly design_by_us_fee_currency: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Slim row used by the staff queue list endpoint. Drops nested
 *  ``revisions``, ``preferences_detail`` and ``current_revision_detail``
 *  so a 100-row page stays compact. The detail page still loads the
 *  full :type:`LabelDesignDto`. */
export interface LabelDesignListItemDto {
  readonly id: string;
  readonly formulation: string;
  readonly formulation_code: string;
  readonly formulation_name: string;
  //: Marketing-facing display name — only set on RTG formulations,
  //: empty string otherwise. UIs should prefer this over
  //: ``formulation_name`` when non-empty so operators see the label
  //: the customer recognises ("Signature Vanilla Whey") instead of
  //: the internal R&D identifier ("PROT-042 · Vanilla Protein v3.2").
  readonly formulation_rtg_display_name: string;
  //: "custom" | "ready_to_go" | "" — drives the RTG badge and the
  //: "prefer display name" branch in the queue row.
  readonly formulation_project_type: string;
  readonly specification_sheet: string | null;
  readonly specification_sheet_code: string;
  readonly status: LabelDesignStatus;
  readonly design_path: LabelDesignPath;
  readonly assigned_designer: string | null;
  readonly assigned_designer_email: string;
  readonly rejection_count: number;
  readonly customer_approved_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}


/** Pagination envelope returned by ``GET /label-designs/``. */
export interface LabelDesignListPage {
  readonly items: ReadonlyArray<LabelDesignListItemDto>;
  readonly total: number;
  readonly has_more: boolean;
  readonly next_offset: number | null;
  /** Per-status counts respecting the current ``search`` but
   *  ignoring the active ``status`` tab — lets the FE render tab
   *  pills that show how many rows live in each tab regardless of
   *  which one is selected. */
  readonly counts_by_status: Partial<Record<LabelDesignStatus, number>>;
}


export interface LabelDesignTransitionDto {
  readonly id: string;
  readonly from_status: string;
  readonly to_status: string;
  readonly actor_email: string;
  readonly actor_client_email: string;
  readonly notes: string;
  readonly metadata: Record<string, unknown>;
  readonly created_at: string;
}

export interface ComplianceContentBlockDto {
  readonly product_name: string;
  readonly product_code: string;
  readonly net_quantity: string;
  readonly serving_size: string;
  readonly servings_per_pack: string;
  readonly directions_of_use: string;
  readonly suggested_dosage: string;
  readonly ingredients_list: ReadonlyArray<{
    readonly name: string;
    readonly qty_label: string;
    readonly nrv_percent: string;
    readonly allergen_flag: boolean;
  }>;
  readonly allergen_statement: string;
  readonly storage_conditions: string;
  readonly shelf_life: string;
  readonly food_contact_status: string;
  readonly business_address: string;
  readonly country_of_origin: string;
  readonly barcode_placeholder: string;
}

export interface ContentBlockTextDto {
  readonly full: string;
  readonly sections: Record<string, string>;
}


// ---------------------------------------------------------------------------
// Template library
// ---------------------------------------------------------------------------


export interface LabelDesignTemplateCategoryDto {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sort_order: number;
  readonly created_at: string;
  readonly updated_at: string;
}


export interface LabelDesignTemplateDto {
  readonly id: string;
  readonly category: string;
  readonly category_name: string;
  readonly name: string;
  readonly description: string;
  readonly file_url: string;
  readonly file_original_name: string;
  readonly file_size_bytes: number;
  readonly content_type: string;
  readonly sort_order: number;
  readonly created_at: string;
  readonly updated_at: string;
}


/** Portal-side aggregate: one category card + its templates. */
export interface PortalLabelDesignTemplateGroup {
  readonly category: LabelDesignTemplateCategoryDto;
  readonly templates: ReadonlyArray<LabelDesignTemplateDto>;
}
