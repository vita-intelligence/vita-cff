/**
 * Zod schemas for the formulations domain.
 */

import { z } from "zod";

import { DOSAGE_FORMS } from "./types";

export const createFormulationSchema = z.object({
  name: z.string().trim().min(1, "required").max(200, "max_length"),
  code: z.string().trim().max(64, "max_length"),
  description: z.string().trim(),
  dosage_form: z.enum(DOSAGE_FORMS as unknown as [string, ...string[]]),
  capsule_size: z.string().trim(),
  tablet_size: z.string().trim(),
  serving_size: z.number().int().min(1, "invalid"),
  servings_per_pack: z.number().int().min(1, "invalid"),
  directions_of_use: z.string().trim(),
  suggested_dosage: z.string().trim(),
  appearance: z.string().trim().max(200, "max_length"),
  disintegration_spec: z.string().trim().max(200, "max_length"),
});

export type CreateFormulationInput = z.infer<typeof createFormulationSchema>;
