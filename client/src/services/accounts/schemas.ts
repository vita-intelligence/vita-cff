/**
 * Zod schemas for accounts-domain forms.
 *
 * Error messages inside these schemas are machine-readable codes — the
 * same convention the backend uses. Components resolve them to
 * translated strings via ``errors.json``. That keeps client-side and
 * server-side error handling symmetrical and gives translators a single
 * dictionary to maintain.
 */

import { z } from "zod";

export const registerSchema = z
  .object({
    email: z.string().trim().email("invalid"),
    first_name: z.string().trim().min(1, "required").max(150, "max_length"),
    last_name: z.string().trim().min(1, "required").max(150, "max_length"),
    password: z.string().min(10, "password_too_short").max(128, "max_length"),
    password_confirm: z.string().min(1, "required"),
  })
  .refine((data) => data.password === data.password_confirm, {
    path: ["password_confirm"],
    message: "passwords_do_not_match",
  });

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().email("invalid"),
  password: z.string().min(1, "required"),
});

export type LoginInput = z.infer<typeof loginSchema>;
