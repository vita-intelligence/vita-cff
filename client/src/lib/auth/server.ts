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
import { customersEndpoints } from "@/services/customers/endpoints";
import type { CustomerOverviewDto } from "@/services/customers/types";
import { formulationsEndpoints } from "@/services/formulations/endpoints";
import type { PaginatedRTGCatalogDto } from "@/services/formulations/api";
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

const ACCESS_COOKIE = "vita_access";
const REFRESH_COOKIE = "vita_refresh";
/**
 * Opaque marker for which membership the caller has switched into.
 *
 * Optional by design: when absent (the overwhelming case — most
 * users have a single org), every server helper falls back to the
 * first organization the bootstrap returns, preserving the original
 * "single-org" behavior bit-for-bit. The cookie only takes effect
 * once a user explicitly picks an org from the header switcher.
 */
export const ACTIVE_ORG_COOKIE = "vita_active_org";


/**
 * Raised by :func:`serverFetch` when the backend is reachable but
 * responds with a 5xx, or when the request itself fails (network
 * error, timeout, DNS). Distinct from a ``null`` return so the page
 * guards can keep the user on their current page and surface an
 * error boundary instead of bouncing to /login -- the original
 * failure mode was a Postgres connection slot exhaustion that made
 * /auth/me/ return 500, which serverFetch was treating as
 * "unauthenticated" and round-tripping the user back to the
 * dashboard.
 */
export class BackendUnavailableError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

async function buildCookieHeader(): Promise<string> {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

/**
 * Issue a server-to-server refresh against the backend using the
 * cookie header forwarded from the inbound request. Returns a fresh
 * cookie string with the rotated tokens spliced in, or ``null`` if
 * the refresh itself failed (refresh cookie missing/expired/etc).
 *
 * We can't write Set-Cookie back to the browser from a Server
 * Component — that's an architectural Next.js constraint — but we
 * can use the new tokens for the duration of the current render so
 * the user isn't bounced to /login in the middle of a navigation
 * just because the proxy missed a refresh window. The browser picks
 * up the rotated tokens on its next request through the proxy.
 */
async function attemptServerRefresh(
  cookieHeader: string,
): Promise<string | null> {
  // Same hard ceiling as the proxy refresh. A hung refresh stalls
  // the server-component render and the user sees a frozen page;
  // bailing fast lets the page guard's ``redirectToLogin`` fire so
  // the user lands somewhere usable instead.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(
      `${env.NEXT_PUBLIC_API_URL}/api/auth/refresh/`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Cookie: cookieHeader,
        },
        cache: "no-store",
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;

    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookies = headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return null;

    // Splice the rotated cookies into the inbound cookie string so
    // the replay request carries the new access (and refresh) value
    // without dropping unrelated cookies the caller is forwarding.
    const cookieMap = new Map<string, string>();
    for (const pair of cookieHeader.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      cookieMap.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
    for (const cookie of setCookies) {
      const [nameValue] = cookie.split(";", 1);
      if (!nameValue) continue;
      const eq = nameValue.indexOf("=");
      if (eq === -1) continue;
      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1).trim();
      if (name === ACCESS_COOKIE || name === REFRESH_COOKIE) {
        cookieMap.set(name, value);
      }
    }
    return Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function serverFetch<T>(path: string): Promise<T | null> {
  const cookieHeader = await buildCookieHeader();
  if (!cookieHeader) {
    return null;
  }

  const url = `${env.NEXT_PUBLIC_API_URL}${path}`;
  let initial: Response;
  try {
    initial = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
      },
      cache: "no-store",
    });
  } catch (cause) {
    // Network error, DNS failure, or hung request the abort tripped.
    // Surface as backend-unavailable so the page renders an error
    // boundary instead of looking unauthenticated and bouncing.
    throw new BackendUnavailableError(
      `Backend fetch failed: ${(cause as Error)?.message ?? "unknown"}`,
      null,
    );
  }

  if (initial.ok) {
    return (await initial.json()) as T;
  }

  // Backend is reachable but degraded (DB pool exhausted, app worker
  // crashed, etc.). Don't treat this as "user is unauthenticated".
  if (initial.status >= 500) {
    throw new BackendUnavailableError(
      `Backend returned ${initial.status} for ${path}`,
      initial.status,
    );
  }

  // Only a 401 is worth a refresh-and-retry. 403/404 are real
  // outcomes the page should reflect as a missing payload.
  if (initial.status !== 401) {
    return null;
  }

  const refreshedCookieHeader = await attemptServerRefresh(cookieHeader);
  if (!refreshedCookieHeader) {
    return null;
  }

  let replay: Response;
  try {
    replay = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: refreshedCookieHeader,
      },
      cache: "no-store",
    });
  } catch (cause) {
    throw new BackendUnavailableError(
      `Backend fetch failed on replay: ${(cause as Error)?.message ?? "unknown"}`,
      null,
    );
  }
  if (replay.status >= 500) {
    throw new BackendUnavailableError(
      `Backend returned ${replay.status} for ${path} (replay)`,
      replay.status,
    );
  }
  if (!replay.ok) {
    return null;
  }
  return (await replay.json()) as T;
}

/**
 * Single round-trip seed used by every authenticated page.
 *
 * Backed by ``/api/auth/bootstrap/`` which returns ``{user,
 * organizations}`` in one response. Wrapping in :func:`react.cache`
 * means every Server Component in the same render shares one
 * backend hit — the page guard, the header chrome, and the layout
 * all read from the same memoized promise.
 *
 * Returns ``null`` on auth failure (missing/expired cookie), and
 * raises :class:`BackendUnavailableError` when the backend is
 * reachable but degraded — same contract as the lower-level
 * helpers below so callers can keep their error boundaries.
 */
interface BootstrapPayload {
  readonly user: UserDto;
  readonly organizations: readonly OrganizationDto[];
}

const getBootstrapServer = cache(
  async (): Promise<BootstrapPayload | null> =>
    serverFetch<BootstrapPayload>("/api/auth/bootstrap/"),
);

/**
 * Read the current user from an incoming Server Component request.
 *
 * Routed through ``/api/auth/bootstrap/`` so the sibling
 * :func:`getUserOrganizationsServer` call in the same render
 * shares the round-trip. Falls back to ``/api/auth/me/`` only if
 * a stale bundle (or test) bypasses the bootstrap path.
 *
 * Returns ``null`` when the cookie is missing, expired, tampered with,
 * or the backend is unreachable.
 */
export const getCurrentUserServer = cache(
  async (): Promise<UserDto | null> => {
    const bootstrap = await getBootstrapServer();
    if (bootstrap) return bootstrap.user;
    // Fallback path: bootstrap missing/failed (e.g. 401 invalid
    // cookies). Probe ``/api/auth/me/`` directly so an error like
    // BackendUnavailableError still surfaces here even if a
    // previous bootstrap call swallowed it.
    return serverFetch<UserDto>(accountsEndpoints.me);
  },
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
  async (): Promise<OrganizationDto[] | null> => {
    const bootstrap = await getBootstrapServer();
    if (bootstrap) return [...bootstrap.organizations];
    // See :func:`getCurrentUserServer` rationale for the fallback.
    return serverFetch<OrganizationDto[]>(organizationsEndpoints.list);
  },
);

/**
 * Read the caller's *currently active* organization for this render.
 *
 * Resolution order:
 *   1. ``ACTIVE_ORG_COOKIE`` — opaque org UUID written by the header
 *      switcher's server action. Honoured only if the caller still
 *      has a membership on that org (cookies can outlive memberships
 *      when an admin revokes access from another tab, so we re-verify
 *      against the bootstrap-loaded org list every render).
 *   2. ``organizations[0]`` — the historical default. Single-org
 *      users (the overwhelming majority) never set the cookie and
 *      see exactly the behavior they did before the switcher landed.
 *
 * Returns ``null`` when the caller has zero orgs (fresh signup
 * before workspace activation) or the bootstrap round-trip failed,
 * mirroring the contract of :func:`getUserOrganizationsServer`.
 */
export const getActiveOrganizationServer = cache(
  async (): Promise<OrganizationDto | null> => {
    const organizations = await getUserOrganizationsServer();
    if (!organizations || organizations.length === 0) return null;
    const cookieStore = await cookies();
    const cookieOrgId = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
    if (cookieOrgId) {
      const match = organizations.find((o) => o.id === cookieOrgId);
      if (match) return match;
      // Cookie points at an org the caller no longer belongs to.
      // Fall through to the default so the page still renders — the
      // server action will overwrite the stale cookie on the next
      // switch, and a single-org user never reaches this branch.
    }
    return organizations[0] ?? null;
  },
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


/** Fetch the staff customer detail page's aggregator payload — the
 *  customer row, portal accounts, proposal history, CFF submissions,
 *  and pre-computed totals in one round-trip. Returns ``null`` on
 *  auth-missing / not-found so the page can decide whether to redirect
 *  to login or render a 404 view. */
export async function getCustomerOverviewServer(
  orgId: string,
  customerId: string,
): Promise<CustomerOverviewDto | null> {
  return serverFetch<CustomerOverviewDto>(
    customersEndpoints.overview(orgId, customerId),
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
    projectType?: "custom" | "ready_to_go";
    /** Opt-in for the /rtg-catalog surface; server-side default hides
     *  published RTG rows (they belong on catalog, not projects). */
    includePublishedRtg?: boolean;
  } = {},
): Promise<PaginatedFormulationsDto | null> {
  const params = new URLSearchParams();
  if (options.ordering) params.set("ordering", options.ordering);
  if (options.pageSize) params.set("page_size", String(options.pageSize));
  // ``project_type`` narrows the list server-side. Used by the RTG
  // Catalog page so we never ship Custom projects (which carry
  // unpublished recipe drafts) into a marketing-listing surface.
  if (options.projectType) params.set("project_type", options.projectType);
  if (options.includePublishedRtg) params.set("include_published_rtg", "true");
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
 * SSR seed for the staff RTG Catalog grid.
 *
 * Hits the dedicated ``rtg-catalog-list/`` endpoint (lean serializer,
 * annotated packaging count, scoped catalog-photo prefetch, composite
 * index) — so the first paint doesn't wait on the general formulation
 * list's 13 M2M prefetches. Returns ``null`` on backend error so the
 * client-side hook falls back to a fresh fetch instead of 500-ing the
 * whole catalog page.
 */
export async function getRTGCatalogFirstPageServer(
  orgId: string,
  options: {
    pageSize?: number;
    isRtgPublished?: boolean;
  } = {},
): Promise<PaginatedRTGCatalogDto | null> {
  const params = new URLSearchParams();
  if (options.pageSize) params.set("page_size", String(options.pageSize));
  if (typeof options.isRtgPublished === "boolean") {
    params.set("is_rtg_published", options.isRtgPublished ? "true" : "false");
  }
  const query = params.toString();
  const url = `${formulationsEndpoints.rtgCatalogList(orgId)}${
    query ? `?${query}` : ""
  }`;
  return serverFetch<PaginatedRTGCatalogDto>(url);
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
