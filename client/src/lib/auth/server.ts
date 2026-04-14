import "server-only";

import { cookies } from "next/headers";

import { env } from "@/config/env";
import { accountsEndpoints } from "@/services/accounts/endpoints";
import type { UserDto } from "@/services/accounts/types";

/**
 * Read the current user from an incoming Server Component request.
 *
 * We call the backend's ``/api/auth/me/`` endpoint directly from the
 * server, forwarding the httpOnly cookies attached to the inbound
 * request. This runs before any HTML is shipped to the browser so we can
 * redirect logged-in visitors away from public pages (and unauthenticated
 * visitors away from protected pages) without a client-side flicker.
 *
 * Returns ``null`` when the cookie is missing, expired, tampered with, or
 * the backend is unreachable. Callers should treat any non-null result as
 * authoritative for the duration of the current request.
 */
export async function getCurrentUserServer(): Promise<UserDto | null> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

  if (!cookieHeader) {
    return null;
  }

  try {
    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}${accountsEndpoints.me}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Cookie: cookieHeader,
        },
        // Do not cache per-user identity responses.
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as UserDto;
  } catch {
    return null;
  }
}
