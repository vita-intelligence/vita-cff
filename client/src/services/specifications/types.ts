/**
 * Transport types for the specifications domain.
 */

export const SPECIFICATION_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "sent",
  "accepted",
  "rejected",
] as const;
export type SpecificationStatus = (typeof SPECIFICATION_STATUSES)[number];

//: Document kind — independent of lifecycle status. Drives whether
//: the rendered sheet carries the diagonal "DRAFT" watermark.
export const SPECIFICATION_DOCUMENT_KINDS = ["draft", "final"] as const;
export type SpecificationDocumentKind =
  (typeof SPECIFICATION_DOCUMENT_KINDS)[number];

/**
 * Allowed status transitions — mirrors ``ALLOWED_TRANSITIONS`` in
 * ``apps/specifications/services.py``. Keeps the UI's enable/disable
 * logic in one place so the forward buttons grey out whenever the
 * backend would reject.
 */
export const ALLOWED_TRANSITIONS: Readonly<
  Record<SpecificationStatus, readonly SpecificationStatus[]>
> = {
  draft: ["in_review"],
  in_review: ["approved", "draft"],
  approved: ["sent", "draft"],
  sent: ["accepted", "rejected"],
  accepted: [],
  rejected: ["draft"],
};

export interface SpecificationSheetDto {
  readonly id: string;
  readonly code: string;
  readonly client_name: string;
  readonly client_email: string;
  readonly client_company: string;
  readonly margin_percent: string | null;
  readonly final_price: string | null;
  readonly cover_notes: string;
  readonly total_weight_label: string;
  readonly unit_quantity: string;
  readonly food_contact_status: string;
  readonly shelf_life: string;
  readonly storage_conditions: string;
  readonly weight_uniformity: string;
  readonly public_token: string | null;
  readonly packaging_lid: string | null;
  readonly packaging_container: string | null;
  readonly packaging_label: string | null;
  readonly packaging_antitemper: string | null;
  readonly packaging_details: PackagingDetails;
  readonly status: SpecificationStatus;
  readonly document_kind: SpecificationDocumentKind;
  /** Phase G5a — last-mile per-section overrides applied at render
   *  time. Schema:
   *    formulation.{directions_of_use, suggested_dosage, appearance,
   *                 disintegration_spec}: string
   *    declaration.text: string
   *    allergens.sources: string[]
   *    compliance.{vegan, organic, halal, kosher}: "yes"|"no"|"unknown"
   *    actives.<line_id>.{label_claim_mg, nrv_pct}: string
   *  Empty / missing keys fall back to the snapshot value. */
  readonly snapshot_overrides: SnapshotOverrides;
  readonly formulation_version: string;
  readonly formulation_id: string;
  readonly formulation_name: string;
  readonly formulation_version_number: number;
  /** Set on render payloads when a :class:`Proposal` is attached to
   *  the sheet. Drives the kiosk's bundled "Accept & Sign" flow. */
  readonly has_proposal?: boolean;
  /** Customer-side signature state. ``customer_signed_at`` is the
   *  ISO timestamp of the kiosk acceptance; the matching
   *  ``customer_*`` fields carry whoever signed (name / email /
   *  company captured on the kiosk identity step). All four are
   *  empty/null on draft sheets — they only populate once the
   *  client signs in the kiosk. */
  readonly customer_name?: string;
  readonly customer_email?: string;
  readonly customer_company?: string;
  readonly customer_signed_at?: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface SnapshotOverrides {
  readonly formulation?: Readonly<{
    directions_of_use?: string;
    suggested_dosage?: string;
    appearance?: string;
    disintegration_spec?: string;
  }>;
  readonly declaration?: Readonly<{ text?: string }>;
  readonly allergens?: Readonly<{ sources?: readonly string[] }>;
  readonly compliance?: Readonly<{
    vegan?: "yes" | "no" | "unknown";
    organic?: "yes" | "no" | "unknown";
    halal?: "yes" | "no" | "unknown";
    kosher?: "yes" | "no" | "unknown";
  }>;
  readonly actives?: Readonly<
    Record<string, Readonly<{ label_claim_mg?: string; nrv_pct?: string }>>
  >;
  /** ``excipients_mg`` — per-row mg override applied at render time.
   *  Keys are either the typed cell names (``water_mg``,
   *  ``gummy_base_mg``, ``mg_stearate_mg``, ``silica_mg``,
   *  ``mcc_mg``, ``dcp_mg``) or one of the rows-list slugs
   *  (``acidity``, ``flavouring:<id>``, ``gummy_base:<id>``).
   *  Values are decimal mg strings. Empty/missing keys keep the
   *  snapshot value. */
  readonly excipients_mg?: Readonly<Record<string, string>>;
}

export const PACKAGING_SLOTS = [
  "packaging_lid",
  "packaging_container",
  "packaging_label",
  "packaging_antitemper",
] as const;
export type PackagingSlot = (typeof PACKAGING_SLOTS)[number];

export interface PackagingOption {
  readonly id: string;
  readonly name: string;
  readonly internal_code: string;
}

/** Response shape for the slot-scoped packaging search endpoint. */
export interface PackagingOptionsPageDto {
  readonly slot: PackagingSlot;
  readonly limit: number;
  readonly results: readonly PackagingOption[];
}

export interface PackagingDetails {
  readonly lid: PackagingOption | null;
  readonly container: PackagingOption | null;
  readonly label: PackagingOption | null;
  readonly antitemper: PackagingOption | null;
}

/** Shape of ``sheet.packaging_details`` — the four currently-selected
 * items decorated with code + name so the picker can paint its
 * preselected label without an extra round-trip. */
export const PACKAGING_DETAIL_KEYS: Readonly<
  Record<PackagingSlot, keyof PackagingDetails>
> = {
  packaging_lid: "lid",
  packaging_container: "container",
  packaging_label: "label",
  packaging_antitemper: "antitemper",
} as const;

export type SetPackagingRequestDto = Partial<
  Record<PackagingSlot, string | null>
>;

export interface PaginatedSpecificationsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly SpecificationSheetDto[];
}

export interface CreateSpecificationRequestDto {
  readonly formulation_version_id: string;
  readonly code?: string;
  readonly client_name?: string;
  readonly client_email?: string;
  readonly client_company?: string;
  readonly margin_percent?: string | null;
  readonly final_price?: string | null;
  readonly cover_notes?: string;
  readonly total_weight_label?: string;
  readonly document_kind?: SpecificationDocumentKind;
}

export type UpdateSpecificationRequestDto = Partial<
  Omit<CreateSpecificationRequestDto, "formulation_version_id">
> & {
  readonly unit_quantity?: string;
  readonly food_contact_status?: string;
  readonly shelf_life?: string;
  readonly storage_conditions?: string;
  readonly weight_uniformity?: string;
  /** Per-sheet override ``{slug: value}`` for the microbial / PAH /
   *  heavy-metal block. Empty or unset falls back to the org default. */
  readonly limits_override?: Readonly<Record<string, string>>;
  /** Phase G5a — per-section last-mile overrides. Pass ``{}`` to
   *  clear all overrides; ``null`` means no change. Server validates
   *  shape and rejects unknown sections / keys with
   *  ``invalid_snapshot_overrides``. */
  readonly snapshot_overrides?: SnapshotOverrides | null;
};

/** Visibility / ordering write. Either field is optional:
 *  - ``visibility`` is a partial ``{slug: bool}`` — omitted keys are
 *    left untouched on the stored map.
 *  - ``order`` is a full top-down list of slugs. Unknown slugs are
 *    dropped; missing slugs are backfilled at render time. */
export interface UpdateVisibilityRequestDto {
  readonly visibility?: Readonly<Record<string, boolean>>;
  readonly order?: readonly string[];
}

export interface TransitionStatusRequestDto {
  readonly status: SpecificationStatus;
  readonly notes?: string;
  /** Base64 PNG data URL captured on the signature pad. Required
   *  for ``draft → in_review`` (prepared-by signature) and
   *  ``in_review → approved`` (director signature). Customer
   *  sign-off (``sent → accepted``) goes through the kiosk endpoint
   *  instead. */
  readonly signature_image?: string;
}


export interface PublicAcceptRequestDto {
  readonly name: string;
  readonly email?: string;
  readonly company?: string;
  readonly signature_image: string;
}

// ---------------------------------------------------------------------------
// Render view-model — shape returned by ``/render/`` endpoint
// ---------------------------------------------------------------------------

export interface RenderedActive {
  /** Stable identifier — equal to the snapshot line's ``item_id``.
   *  Used as the key when patching ``snapshot_overrides.actives``. */
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly ingredient_list_name: string;
  readonly label_claim_mg: string;
  readonly label_claim_overridden?: boolean;
  readonly mg_per_serving: string;
  readonly nrv_percent: string | null;
  readonly nrv_overridden?: boolean;
}

export interface RenderedCompliance {
  readonly flags: readonly {
    readonly key: string;
    readonly label: string;
    readonly status: boolean | null;
    readonly compliant_count: number;
    readonly non_compliant_count: number;
    readonly unknown_count: number;
    readonly override_applied?: boolean;
  }[];
}

export interface RenderedDeclaration {
  readonly text: string;
  /** Set by the render layer when ``snapshot_overrides.declaration.text``
   *  is in effect — the UI uses it to show an "Edited" badge and the
   *  reset button next to the declaration block. */
  readonly text_overridden?: boolean;
  readonly entries: readonly {
    readonly label: string;
    readonly mg: string;
    readonly category: "active" | "excipient" | "shell";
    readonly is_allergen: boolean;
    readonly allergen_source: string;
  }[];
}

/** Aggregated allergen classes across the product's actives. Matches
 * the EU 1169/2011 requirement to list allergens explicitly — the
 * ``sources`` list is distinct across ingredients so two milk proteins
 * surface once. Empty list ⇒ suppress the whole Allergens row, per
 * the workbook's ``IF(T10=0,"","Allergen:")`` convention. */
export interface RenderedAllergens {
  readonly sources: readonly string[];
  readonly allergen_count: number;
  readonly sources_overridden?: boolean;
}

/** One row of the nutrition facts panel. ``key`` matches the
 * catalogue attribute name; ``per_serving`` and ``per_100g`` are
 * already scaled and quantised to four decimals on the backend. */
export interface RenderedNutrientRow {
  readonly key: string;
  readonly per_serving: string;
  readonly per_100g: string;
  readonly contributors: number;
}

export interface RenderedNutrition {
  readonly rows: readonly RenderedNutrientRow[];
}

export interface RenderedAminoGroup {
  readonly key: "essential" | "conditionally_essential" | "non_essential";
  readonly acids: readonly RenderedNutrientRow[];
}

export interface RenderedAminoAcids {
  readonly groups: readonly RenderedAminoGroup[];
}

export interface RenderedTransition {
  readonly id: string;
  readonly from_status: SpecificationStatus;
  readonly to_status: SpecificationStatus;
  readonly actor_id: string;
  readonly actor_name: string;
  readonly actor_email: string;
  readonly notes: string;
  readonly created_at: string;
}

export interface RenderedInternalSignature {
  readonly user_id: string;
  readonly name: string;
  readonly email: string;
  readonly signed_at: string;
  readonly image: string;
}

export interface RenderedCustomerSignature {
  readonly name: string;
  readonly email: string;
  readonly company: string;
  readonly signed_at: string | null;
  readonly image: string;
}

export interface RenderedSignatures {
  readonly prepared_by: RenderedInternalSignature | null;
  readonly director: RenderedInternalSignature | null;
  readonly customer: RenderedCustomerSignature;
}

export interface RenderedSheetContext {
  readonly sheet: SpecificationSheetDto;
  readonly signatures: RenderedSignatures;
  readonly formulation: {
    readonly id: string;
    readonly version_number: number;
    readonly version_label: string;
    readonly code: string;
    readonly name: string;
    readonly description: string;
    readonly dosage_form: string;
    readonly capsule_size: string;
    readonly tablet_size: string;
    readonly serving_size: number;
    readonly servings_per_pack: number;
    readonly directions_of_use: string;
    readonly suggested_dosage: string;
    readonly appearance: string;
    readonly disintegration_spec: string;
    readonly directions_of_use_overridden?: boolean;
    readonly suggested_dosage_overridden?: boolean;
    readonly appearance_overridden?: boolean;
    readonly disintegration_spec_overridden?: boolean;
  };
  readonly totals: {
    readonly total_active_mg: string | null;
    readonly total_weight_mg: string | null;
    readonly filled_total_mg: string | null;
    readonly max_weight_mg: string | null;
    readonly size_label: string | null;
    readonly excipients: {
      readonly mg_stearate_mg: string | null;
      readonly silica_mg: string | null;
      readonly mcc_mg: string | null;
      readonly dcp_mg: string | null;
      /** Gummy-only TOTAL base weight. ``null`` on every other form. */
      readonly gummy_base_mg: string | null;
      /** Gummy-only: 5.5% of target. ``null`` elsewhere. */
      readonly water_mg: string | null;
      /** Per-item breakdown of the gummy base; empty list when
       *  nothing picked or for non-gummy forms. */
      readonly gummy_base_rows?: readonly {
        readonly item_id: string;
        readonly label: string;
        readonly use_as: string;
        readonly mg: string;
      }[];
      /** Powder + gummy flexible row list — acidity / flavouring /
       *  colour / glazing / gelling / premix-sweetener picks plus
       *  the powder flavour-system rows. ``mg_overridden`` is
       *  ``true`` when the spec sheet's ``snapshot_overrides.
       *  excipients_mg.<slug>`` swapped the value at render time. */
      readonly rows?: readonly {
        readonly slug: string;
        readonly label: string;
        readonly mg: string;
        readonly is_remainder?: boolean;
        readonly concentration_mg_per_ml?: string | null;
        readonly use_as?: string;
        readonly is_allergen?: boolean;
        readonly allergen_source?: string;
        readonly mg_overridden?: boolean;
      }[];
    } | null;
    readonly viability: {
      readonly fits: boolean;
      readonly comfort_ok: boolean;
      readonly codes: readonly string[];
    } | null;
    /** Powder-only: per-serving weight (scoops × per-scoop mg). */
    readonly powder_per_serving_mg?: string | null;
    /** Powder-only: servings_per_pack × per-serving-mg. */
    readonly powder_pack_total_mg?: string | null;
  };
  readonly actives: readonly RenderedActive[];
  readonly compliance: RenderedCompliance;
  readonly declaration: RenderedDeclaration;
  readonly allergens: RenderedAllergens;
  readonly nutrition: RenderedNutrition;
  readonly amino_acids: RenderedAminoAcids;
  readonly history: readonly RenderedTransition[];
  readonly packaging: {
    readonly lid_description: string;
    readonly bottle_pouch_tub: string;
    readonly label_size: string;
    readonly antitemper: string;
    readonly unit_quantity: number | string | null;
    readonly food_contact_status: string;
    readonly shelf_life: string;
    readonly storage_conditions: string;
  };
  readonly limits: readonly {
    readonly slug: string;
    readonly name: string;
    readonly value: string;
  }[];
  readonly weight_uniformity: string;
  /** Per-section on/off map. Keys match the backend's ``SECTION_SLUGS``
   *  tuple; missing keys are treated as visible so pre-feature sheets
   *  keep rendering in full. */
  readonly visibility: Readonly<Record<string, boolean>>;
  /** Effective render order of section slugs, top-down. Always
   *  includes every known section — the server backfills any slugs
   *  missing from the sheet's stored override before sending. */
  readonly section_order: readonly string[];
  /** ``true`` when the sheet is in a non-final status — the renderer
   *  overlays a diagonal ``DRAFT`` stamp across every page. */
  readonly watermark: boolean;
}
