/**
 * Hard-coded view-model for the design preview, shaped like the
 * future ``/projects/<id>/overview`` endpoint will return. Mirrors
 * the Valley Low Fat Burner project (MA210367) so numbers feel real.
 * Deleted after the design decision lands.
 */

export type ProjectStatus =
  | "concept"
  | "in_development"
  | "pilot"
  | "approved"
  | "discontinued";

export interface MockProjectOverview {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly dosage_form: string;
  readonly size_label: string;
  readonly project_status: ProjectStatus;
  readonly latest_version: number;
  readonly latest_version_label: string;
  readonly updated_at: string;
  readonly owner_name: string;
  readonly spec_sheets: {
    readonly total: number;
    readonly draft: number;
    readonly in_review: number;
    readonly approved: number;
    readonly sent: number;
    readonly accepted: number;
  };
  readonly trial_batches: {
    readonly total: number;
    readonly in_flight: number;
    readonly latest_label: string;
    readonly latest_packs: number;
  };
  readonly qc: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly in_progress: number;
  };
  readonly allergens: {
    readonly sources: readonly string[];
    readonly count: number;
  };
  readonly compliance: {
    readonly vegan: boolean;
    readonly organic: boolean;
    readonly halal: boolean;
    readonly kosher: boolean;
  };
  readonly totals: {
    readonly total_active_mg: string;
    readonly total_weight_mg: string;
    readonly filled_total_mg: string;
    readonly viability: "can_make" | "cannot_make" | "challenging";
  };
  readonly activity: readonly {
    readonly id: string;
    readonly text: string;
    readonly actor: string;
    readonly ago: string;
  }[];
}


export const MOCK_PROJECT: MockProjectOverview = {
  code: "MA210367",
  name: "Valley Low Fat Burner",
  description:
    "Daily fat-metabolism support capsule — caffeine + botanical blend.",
  dosage_form: "Capsule",
  size_label: "Double 00",
  project_status: "pilot",
  latest_version: 8,
  latest_version_label: "fixed DCP purity",
  updated_at: "2026-04-16T20:22:04Z",
  owner_name: "Max Chergik",
  spec_sheets: {
    total: 3,
    draft: 1,
    in_review: 0,
    approved: 1,
    sent: 1,
    accepted: 0,
  },
  trial_batches: {
    total: 4,
    in_flight: 2,
    latest_label: "10K pilot run",
    latest_packs: 500,
  },
  qc: {
    total: 2,
    passed: 1,
    failed: 0,
    in_progress: 1,
  },
  allergens: {
    sources: [],
    count: 0,
  },
  compliance: {
    vegan: true,
    organic: false,
    halal: true,
    kosher: true,
  },
  totals: {
    total_active_mg: "477.41",
    total_weight_mg: "730.00",
    filled_total_mg: "848.00",
    viability: "can_make",
  },
  activity: [
    {
      id: "1",
      text: "Advanced spec sheet SPEC-001 to Approved",
      actor: "Max Chergik",
      ago: "2d",
    },
    {
      id: "2",
      text: "Saved version v8",
      actor: "Max Chergik",
      ago: "3d",
    },
    {
      id: "3",
      text: "Planned trial batch 10K pilot run",
      actor: "Max Chergik",
      ago: "3d",
    },
    {
      id: "4",
      text: "Product validation for Lot #1 passed",
      actor: "Max Chergik",
      ago: "5d",
    },
    {
      id: "5",
      text: "Created formulation",
      actor: "Max Chergik",
      ago: "14d",
    },
  ],
};
