import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

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
  ProjectOverviewDto,
} from "@/services/formulations/types";
import { invitationsEndpoints } from "@/services/invitations/endpoints";
import type { InvitationDto } from "@/services/invitations/types";
import { membersEndpoints } from "@/services/members/endpoints";
import type {
  MembershipDto,
  ModuleDefinitionDto,
} from "@/services/members/types";
import { organizationsEndpoints } from "@/services/organizations/endpoints";
import type { OrganizationDto } from "@/services/organizations/types";
import { specificationsEndpoints } from "@/services/specifications/endpoints";
import type {
  PaginatedSpecificationsDto,
  RenderedSheetContext,
  SpecificationSheetDto,
} from "@/services/specifications/types";
import type { ProposalKioskDto } from "@/services/proposals/types";
import { productValidationEndpoints } from "@/services/product_validation/endpoints";
import type {
  ProductValidationDto,
  ValidationStatsDto,
} from "@/services/product_validation/types";
import { trialBatchesEndpoints } from "@/services/trial_batches/endpoints";
import type {
  BOMResult,
  TrialBatchDto,
} from "@/services/trial_batches/types";

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
export const getCurrentUserServer = cache(
  async (): Promise<UserDto | null> =>
    serverFetch<UserDto>(accountsEndpoints.me),
);

/**
 * Read the current user's organizations from an incoming request.
 *
 * Intended to be called from the same Server Component that already
 * called :func:`getCurrentUserServer`. Returns ``[]`` when the caller
 * has no organizations yet (a normal state immediately after sign-up)
 * and ``null`` only when the backend round-trip fails outright.
 *
 * Wrapped in :func:`react.cache` so multiple Server Components in the
 * same request (e.g. page guard + header) share one backend hit.
 */
export const getUserOrganizationsServer = cache(
  async (): Promise<OrganizationDto[] | null> =>
    serverFetch<OrganizationDto[]>(organizationsEndpoints.list),
);

/**
 * Fetch every membership on an org for the Settings > Members tab.
 *
 * Requires ``members.view`` on the caller's own membership; a 403
 * comes through as ``null`` here so the page can render an access-
 * denied state instead of crashing.
 */
export async function getMembershipsServer(
  orgId: string,
): Promise<MembershipDto[] | null> {
  return serverFetch<MembershipDto[]>(membersEndpoints.list(orgId));
}

/**
 * Fetch pending invitations on an org. Same permission posture as
 * :func:`getMembershipsServer` — ``members.view``.
 */
export async function getInvitationsServer(
  orgId: string,
): Promise<InvitationDto[] | null> {
  return serverFetch<InvitationDto[]>(invitationsEndpoints.list(orgId));
}

/**
 * Fetch the module + capability registry. Not org-scoped — any
 * authenticated user can read the catalog.
 */
export async function getModulesServer(): Promise<
  ModuleDefinitionDto[] | null
> {
  return serverFetch<ModuleDefinitionDto[]>(membersEndpoints.modules());
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

export async function getProjectOverviewServer(
  orgId: string,
  formulationId: string,
): Promise<ProjectOverviewDto | null> {
  return serverFetch<ProjectOverviewDto>(
    formulationsEndpoints.overview(orgId, formulationId),
  );
}

export async function getProjectSpecificationSheetsServer(
  orgId: string,
  formulationId: string,
): Promise<PaginatedSpecificationsDto | null> {
  const url = `${specificationsEndpoints.list(orgId)}?formulation_id=${formulationId}`;
  return serverFetch<PaginatedSpecificationsDto>(url);
}

export async function getProjectValidationsServer(
  orgId: string,
  formulationId: string,
): Promise<ProductValidationDto[] | null> {
  const url = `${productValidationEndpoints.list(orgId)}?formulation_id=${formulationId}`;
  return serverFetch<ProductValidationDto[]>(url);
}

export async function getSpecificationServer(
  orgId: string,
  sheetId: string,
): Promise<SpecificationSheetDto | null> {
  return serverFetch<SpecificationSheetDto>(
    specificationsEndpoints.detail(orgId, sheetId),
  );
}

export async function getRenderedSpecificationServer(
  orgId: string,
  sheetId: string,
): Promise<RenderedSheetContext | null> {
  return serverFetch<RenderedSheetContext>(
    specificationsEndpoints.render(orgId, sheetId),
  );
}

export async function getTrialBatchServer(
  orgId: string,
  batchId: string,
): Promise<TrialBatchDto | null> {
  return serverFetch<TrialBatchDto>(
    trialBatchesEndpoints.detail(orgId, batchId),
  );
}

export async function getTrialBatchRenderServer(
  orgId: string,
  batchId: string,
): Promise<BOMResult | null> {
  return serverFetch<BOMResult>(
    trialBatchesEndpoints.render(orgId, batchId),
  );
}

export async function getValidationServer(
  orgId: string,
  validationId: string,
): Promise<ProductValidationDto | null> {
  return serverFetch<ProductValidationDto>(
    productValidationEndpoints.detail(orgId, validationId),
  );
}

export async function getValidationStatsServer(
  orgId: string,
  validationId: string,
): Promise<ValidationStatsDto | null> {
  return serverFetch<ValidationStatsDto>(
    productValidationEndpoints.stats(orgId, validationId),
  );
}

export async function getValidationForBatchServer(
  orgId: string,
  batchId: string,
): Promise<ProductValidationDto | null> {
  return serverFetch<ProductValidationDto>(
    productValidationEndpoints.forBatch(orgId, batchId),
  );
}

/**
 * Fetch a publicly-shared specification sheet by its token, server-
 * side and without forwarding any caller cookies.
 *
 * The public render endpoint ignores auth — a valid token is both
 * necessary and sufficient. We bypass :func:`serverFetch` so an
 * inbound user's session cookie (if any) is not attached; the public
 * preview page should never differ based on whether the viewer
 * happens to be logged in elsewhere in the app.
 */
export async function getPublicRenderedSpecificationServer(
  token: string,
): Promise<RenderedSheetContext | null> {
  try {
    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}${specificationsEndpoints.publicRender(token)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RenderedSheetContext;
  } catch {
    return null;
  }
}


/**
 * Fetch the public proposal kiosk payload for a given token.
 *
 * Mirrors :func:`getPublicRenderedSpecificationServer` — cookie-free
 * fetch so a logged-in viewer sees exactly what a cold client would.
 * Returns ``null`` on any non-2xx so the page can 404 cleanly
 * without leaking whether the token is simply wrong vs the
 * proposal's public link has been revoked.
 */
export async function getPublicProposalKioskServer(
  token: string,
): Promise<ProposalKioskDto | null> {
  try {
    const { proposalsEndpoints } = await import("@/services/proposals");
    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}${proposalsEndpoints.publicKiosk(token)}`,
      {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as ProposalKioskDto;
  } catch {
    return null;
  }
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
