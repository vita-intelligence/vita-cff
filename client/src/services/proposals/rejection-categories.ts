/**
 * Rejection category registry — mirrored from the Python side
 * (``server/apps/proposals/constants.py``). Keep the two in sync.
 *
 * Used by:
 *   * Portal reject form (checkbox list + mandatory ≥1 pick)
 *   * Staff RejectionPanel on the proposal detail page
 *   * Project page cancellation banner
 *   * R&D workspace rejection banner
 *   * "Previously rejected" retry banner
 */

export type RejectionCategoryKey =
  | "price"
  | "moq"
  | "lead_time"
  | "formulation"
  | "packaging"
  | "payment_terms"
  | "certifications"
  | "logistics"
  | "timing"
  | "other_supplier"
  | "other";

export interface RejectionCategoryEntry {
  readonly key: RejectionCategoryKey;
  readonly label: string;
}

export const REJECTION_CATEGORIES: ReadonlyArray<RejectionCategoryEntry> = [
  { key: "price", label: "Price is too high" },
  { key: "moq", label: "Minimum order quantity doesn't work" },
  { key: "lead_time", label: "Lead time is too long" },
  { key: "formulation", label: "Want to change the formulation" },
  { key: "packaging", label: "Need different packaging options" },
  { key: "payment_terms", label: "Payment terms don't work" },
  { key: "certifications", label: "Missing certifications we need" },
  { key: "logistics", label: "Shipping / logistics issue" },
  { key: "timing", label: "Not ready to commit right now" },
  { key: "other_supplier", label: "Going with another manufacturer" },
  { key: "other", label: "Something else" },
];

const LABEL_BY_KEY: Record<string, string> = Object.fromEntries(
  REJECTION_CATEGORIES.map((entry) => [entry.key, entry.label]),
);

/** Look up a label for a category key. Falls back to the raw key
 *  for legacy rows carrying a renamed/removed category. */
export function rejectionCategoryLabel(key: string): string {
  return LABEL_BY_KEY[key] ?? key;
}
