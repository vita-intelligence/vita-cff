import "server-only";

import { cookies } from "next/headers";

import { env } from "@/config/env";
import { accountsEndpoints } from "@/services/accounts/endpoints";
import type { UserDto } from "@/services/accounts/types";
import { attributesEndpoints } from "@/services/attributes/endpoints";
import type { AttributeDefinitionDto } from "@/services/attributes/types";
import { cataloguesEndpoints } from "@/services/catalogues/endpoints";
import type {
  CatalogueDto,
  ItemDto,
  PaginatedItemsDto,
} from "@/services/catalogues/types";
import { formulationsEndpoints } from "@/services/formulations/endpoints";
import type {
  FormulationDto,
  PaginatedFormulationsDto,
} from "@/services/formulations/types";
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
 * or the backend is unreachable.
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

/**
 * Fetch every catalogue the current user can see inside an org.
 *
 * Non-owners only see the catalogues they carry a permission grant
 * on — the filtering happens server-side by the same rules the
 * catalogue list endpoint enforces on the API side.
 */
export async function getCataloguesServer(
  orgId: string,
): Promise<CatalogueDto[] | null> {
  return serverFetch<CatalogueDto[]>(
    cataloguesEndpoints.catalogueList(orgId),
  );
}

/**
 * Fetch the first paginated page of items for a specific catalogue
 * from a Server Component. Used to hydrate the infinite-scroll query
 * on the client so the first paint already has data.
 */
export async function getCatalogueItemsFirstPageServer(
  orgId: string,
  slug: string,
  options: {
    includeArchived?: boolean;
    ordering?: string;
    pageSize?: number;
  } = {},
): Promise<PaginatedItemsDto | null> {
  const params = new URLSearchParams();
  if (options.includeArchived) params.set("include_archived", "true");
  if (options.ordering) params.set("ordering", options.ordering);
  if (options.pageSize) params.set("page_size", String(options.pageSize));
  const query = params.toString();
  const url = `${cataloguesEndpoints.itemList(orgId, slug)}${
    query ? `?${query}` : ""
  }`;
  return serverFetch<PaginatedItemsDto>(url);
}

export async function getCatalogueItemServer(
  orgId: string,
  slug: string,
  itemId: string,
): Promise<ItemDto | null> {
  return serverFetch<ItemDto>(
    cataloguesEndpoints.itemDetail(orgId, slug, itemId),
  );
}

/**
 * Fetch the first paginated page of formulations from a Server
 * Component. Used to hydrate the infinite-scroll query on the list
 * page so the first paint already has data. Returns ``null`` only
 * when the backend round-trip fails (e.g. missing permission → 403
 * → null).
 */
export async function getFormulationsFirstPageServer(
  orgId: string,
  options: {
    ordering?: string;
    pageSize?: number;
  } = {},
): Promise<PaginatedFormulationsDto | null> {
  const params = new URLSearchParams();
  if (options.ordering) params.set("ordering", options.ordering);
  if (options.pageSize) params.set("page_size", String(options.pageSize));
  const query = params.toString();
  const url = `${formulationsEndpoints.list(orgId)}${
    query ? `?${query}` : ""
  }`;
  return serverFetch<PaginatedFormulationsDto>(url);
}

export async function getFormulationServer(
  orgId: string,
  formulationId: string,
): Promise<FormulationDto | null> {
  return serverFetch<FormulationDto>(
    formulationsEndpoints.detail(orgId, formulationId),
  );
}

/**
 * Fetch the typed attribute definitions for an organization's
 * catalogue. Active-only by default; pass ``includeArchived`` to see
 * archived definitions too (used on the fields management page).
 */
export async function getAttributeDefinitionsServer(
  orgId: string,
  slug: string,
  options: { includeArchived?: boolean } = {},
): Promise<AttributeDefinitionDto[] | null> {
  const params = new URLSearchParams();
  if (options.includeArchived) params.set("include_archived", "true");
  const query = params.toString();
  const url = `${attributesEndpoints.list(orgId, slug)}${
    query ? `?${query}` : ""
  }`;
  return serverFetch<AttributeDefinitionDto[]>(url);
}
