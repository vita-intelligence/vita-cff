/**
 * Runtime environment validation.
 *
 * Every env var the browser or server reads has to pass through this schema
 * so a typo in ``.env.local`` fails loudly at startup instead of silently
 * breaking a request deep inside a component tree.
 */

import { z } from "zod";

const clientSchema = z.object({
  NEXT_PUBLIC_API_URL: z
    .string()
    .url({ message: "NEXT_PUBLIC_API_URL must be a valid URL." })
    .describe("Base URL of the backend API, e.g. http://127.0.0.1:8000"),
});

const clientRaw = {
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
} as const;

const parsed = clientSchema.safeParse(clientRaw);

if (!parsed.success) {
  // Concatenate every issue into a single readable error. This only runs on
  // module import so the failure surfaces during ``next dev`` or ``next build``.
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");
  throw new Error(`Invalid environment variables:\n${issues}`);
}

export const env = parsed.data;
export type Env = typeof env;
