/**
 * Zod schemas for the catalogues domain.
 *
 * Error messages are machine-readable codes the UI resolves via the
 * i18n error dictionary, matching the rest of the codebase.
 */

import { z } from "zod";

const priceField = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .refine(
    (value) => value === null || /^\d+(\.\d{1,4})?$/.test(value),
    "invalid",
  )
  .nullable();

export const createItemSchema = z.object({
  name: z.string().trim().min(1, "required").max(200, "max_length"),
  internal_code: z.string().trim().max(64, "max_length"),
  unit: z.string().trim().max(32, "max_length"),
  base_price: priceField,
});

export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z.object({
  name: z.string().trim().min(1, "required").max(200, "max_length"),
  internal_code: z.string().trim().max(64, "max_length"),
  unit: z.string().trim().max(32, "max_length"),
  base_price: priceField,
  is_archived: z.boolean(),
});

export type UpdateItemInput = z.infer<typeof updateItemSchema>;


const slugRegex = /^[a-z][a-z0-9_]{0,63}$/;

export const createCatalogueSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1, "required")
    .max(64, "max_length")
    .regex(slugRegex, "catalogue_slug_invalid"),
  name: z.string().trim().min(1, "required").max(150, "max_length"),
  description: z.string().trim().max(2000, "max_length"),
});

export type CreateCatalogueInput = z.infer<typeof createCatalogueSchema>;
