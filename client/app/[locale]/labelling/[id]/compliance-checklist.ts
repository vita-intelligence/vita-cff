/**
 * Backwards-compatible re-export of the shared checklist
 * constants. The authoritative copy lives in
 * ``client/src/lib/label-design/checklist`` so the customer
 * portal workspace can render the same MA-PD-B-012 readout
 * without cross-importing from this route segment.
 */
export type {
  ChecklistItem,
  ChecklistSectionKey,
} from "@/lib/label-design/checklist";
export {
  CHECKLIST_ITEMS,
  CHECKLIST_SECTIONS,
} from "@/lib/label-design/checklist";
