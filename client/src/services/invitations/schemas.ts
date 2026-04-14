/**
 * Zod schemas for the invitations domain.
 *
 * Error messages are machine-readable codes that the UI resolves via
 * ``errors.json`` — same convention as every other services module.
 */

import { z } from "zod";

export const createInvitationSchema = z.object({
  email: z.string().trim().email("invalid"),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const acceptInvitationSchema = z
  .object({
    first_name: z
      .string()
      .trim()
      .min(1, "required")
      .max(150, "max_length"),
    last_name: z
      .string()
      .trim()
      .min(1, "required")
      .max(150, "max_length"),
    password: z
      .string()
      .min(10, "password_too_short")
      .max(128, "max_length"),
    password_confirm: z.string().min(1, "required"),
  })
  .refine((data) => data.password === data.password_confirm, {
    path: ["password_confirm"],
    message: "passwords_do_not_match",
  });

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
