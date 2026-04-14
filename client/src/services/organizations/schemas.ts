/**
 * Zod schemas for organizations-domain forms.
 *
 * Error messages are machine-readable codes matching the backend's
 * convention; components resolve them to translated strings via
 * ``errors.json``.
 */

import { z } from "zod";

export const createOrganizationSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "required")
    .max(150, "max_length"),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
