/**
 * Zod schemas for the attributes domain.
 *
 * Error messages are machine-readable codes that the UI resolves via
 * ``errors.json``, matching the rest of the codebase.
 */

import { z } from "zod";

import { DATA_TYPES } from "./types";

const optionSchema = z.object({
  value: z.string().trim().min(1, "required").max(100, "max_length"),
  label: z.string().trim().min(1, "required").max(200, "max_length"),
});

const keyRegex = /^[a-z][a-z0-9_]{0,63}$/;

export const createAttributeDefinitionSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1, "required")
      .max(64, "max_length")
      .regex(keyRegex, "attribute_key_invalid"),
    label: z.string().trim().min(1, "required").max(150, "max_length"),
    data_type: z.enum(DATA_TYPES as unknown as [string, ...string[]]),
    required: z.boolean(),
    options: z.array(optionSchema),
  })
  .superRefine((data, ctx) => {
    const needsOptions =
      data.data_type === "single_select" || data.data_type === "multi_select";
    if (needsOptions && data.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "attribute_options_invalid",
      });
    }
    if (!needsOptions && data.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "attribute_options_invalid",
      });
    }
  });

export type CreateAttributeDefinitionInput = z.infer<
  typeof createAttributeDefinitionSchema
>;

export const updateAttributeDefinitionSchema = z.object({
  label: z.string().trim().min(1, "required").max(150, "max_length"),
  required: z.boolean(),
  options: z.array(optionSchema),
  display_order: z.number().int(),
});

export type UpdateAttributeDefinitionInput = z.infer<
  typeof updateAttributeDefinitionSchema
>;
