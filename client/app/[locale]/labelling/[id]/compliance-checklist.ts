/** Frontend mirror of the hard-coded MA-PD-B-012 checklist.
 *
 * Keys + section assignment MUST match the Python tuple at
 * ``server/apps/label_design/constants.py:COMPLIANCE_CHECKLIST``.
 * A mismatch will fail the review serializer at submit time.
 */

export type ChecklistSectionKey =
  | "general"
  | "regulatory"
  | "customer_claims"
  | "allergen"
  | "print_packaging";


export interface ChecklistItem {
  readonly key: string;
  readonly section: ChecklistSectionKey;
  readonly label: string;
  readonly help?: string;
}


export const CHECKLIST_SECTIONS: ReadonlyArray<{
  readonly key: ChecklistSectionKey;
  readonly label: string;
}> = [
  { key: "general", label: "General label compliance" },
  { key: "regulatory", label: "Regulatory & claims" },
  { key: "customer_claims", label: "Customer claims compliance" },
  { key: "allergen", label: "Allergen declaration & warnings" },
  { key: "print_packaging", label: "Print & packaging" },
];


export const CHECKLIST_ITEMS: ReadonlyArray<ChecklistItem> = [
  { key: "general.spelling_grammar", section: "general", label: "Spelling & grammar" },
  { key: "general.formatting_readability", section: "general", label: "Formatting & readability" },
  { key: "general.layout_consistency", section: "general", label: "Label layout consistency" },
  { key: "general.font_legibility", section: "general", label: "Font size & legibility" },

  { key: "regulatory.product_name_description", section: "regulatory", label: "Compliant product name & description" },
  {
    key: "regulatory.health_claims",
    section: "regulatory",
    label: "Permitted health & nutritional claims",
    help:
      "Each claim must map to an authorised EFSA / FSA / FDA register entry.",
  },
  { key: "regulatory.ingredient_list", section: "regulatory", label: "Approved ingredient list in correct order" },
  {
    key: "regulatory.international_compliance",
    section: "regulatory",
    label: "Complies with local & international regulations (FSA / EFSA / FDA)",
  },
  { key: "regulatory.certification_logos", section: "regulatory", label: "Correct use of certification logos" },
  { key: "regulatory.net_quantity", section: "regulatory", label: "Net quantity declared" },
  { key: "regulatory.storage_conditions", section: "regulatory", label: "Storage condition provided" },
  { key: "regulatory.dosage_instructions", section: "regulatory", label: "Instruction of use / dosage provided" },
  { key: "regulatory.business_address", section: "regulatory", label: "Business name and address present" },
  { key: "regulatory.country_of_origin", section: "regulatory", label: "Country of origin declared (if present)" },
  { key: "regulatory.nrv_declared", section: "regulatory", label: "NRV declared" },

  { key: "customer_claims.no_medical_claims", section: "customer_claims", label: "No medical or misleading claims" },
  { key: "customer_claims.nutrition_claims_permitted", section: "customer_claims", label: "Nutrition / health claims permitted" },
  { key: "customer_claims.dosage_safe", section: "customer_claims", label: "Dosage instruction safe and appropriate" },

  { key: "allergen.highlighted", section: "allergen", label: "Allergens clearly highlighted (bold / emphasis)" },
  { key: "allergen.contains_statement", section: "allergen", label: '"Contains" statement correct' },
  { key: "allergen.may_contain", section: "allergen", label: '"May contain" statement justified & risk-assessed' },
  { key: "allergen.matches_specification", section: "allergen", label: "Allergen information matches specification" },

  { key: "print_packaging.barcode_qr_placement", section: "print_packaging", label: "Correct barcode & QR code placement" },
  { key: "print_packaging.size_matches_packaging", section: "print_packaging", label: "Label size matches packaging" },
  { key: "print_packaging.print_colours", section: "print_packaging", label: "Correct print colours & branding" },
  { key: "print_packaging.waterproof", section: "print_packaging", label: "Waterproof & smudge-proof labelling verified" },
];
