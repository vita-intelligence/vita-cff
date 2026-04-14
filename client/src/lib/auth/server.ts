import "server-only";

import { cookies } from "next/headers";

import { env } from "@/config/env";
import { accountsEndpoints } from "@/services/accounts/endpoints";
import type { UserDto } from "@/services/accounts/types";
import { organizationsEndpoints } from "@/services/organizations/endpoints";
import type { OrganizationDto } from "@/services/organizations/types";

async function buildCookieHeader(): Promise<string> {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

async function serverFetch<T>(path: string): Promise<T | null> {
  const cookieHeader = await buildCookieHeader();
  if (!cookieHeader) {
    return null;
  }

  try {
    const response = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Read the current user from an incoming Server Component request.
 *
 * We call the backend's ``/api/auth/me/`` endpoint directly from the
 * server, forwarding the httpOnly cookies attached to the inbound
 * request. This runs before any HTML is shipped to the browser so we
 * can redirect logged-in visitors away from public pages (and
 * unauthenticated visitors away from protected pages) without a
 * client-side flicker.
 *
 * Returns ``null`` when the cookie is missing, expired, tampered with,
 * or the backend is unreachable. Callers should treat any non-null
 * result as authoritative for the duration of the current request.
 */
export async function getCurrentUserServer(): Promise<UserDto | null> {
  return serverFetch<UserDto>(accountsEndpoints.me);
}

/**
 * Read the current user's organizations from an incoming request.
 *
 * Intended to be called from the same Server Component that already
 * called :func:`getCurrentUserServer`. Returns ``[]`` when the caller
 * has no organizations yet (a normal state immediately after sign-up)
 * and ``null`` only when the backend round-trip fails outright.
 */
export async function getUserOrganizationsServer(): Promise<
  OrganizationDto[] | null
> {
  return serverFetch<OrganizationDto[]>(organizationsEndpoints.list);
}
