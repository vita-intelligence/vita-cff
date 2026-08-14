/**
 * TanStack Query client factory.
 *
 * A new client is created per browser tab and reused for the lifetime of
 * the tab. On the server we never cache across requests — we always build a
 * fresh client — so data from one user cannot leak to another.
 */

import {
  QueryClient,
  defaultShouldDehydrateQuery,
  isServer,
} from "@tanstack/react-query";

import { ApiError } from "@/lib/api";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime-first posture: the primary freshness driver is the
        // org-scoped WebSocket feed (see :file:`services/payments`
        // — first tenant; the pattern generalises to CFF, projects,
        // proposals, samples, trial batches, label designs). These
        // defaults are the belt-and-braces fallback for any query
        // that isn't yet wired to the feed OR the window where a tab
        // is disconnected from the WS. Was ``staleTime: 60_000`` +
        // ``refetchOnWindowFocus: false`` — that combination held a
        // sample-order payment invisible on ``/finance/payments/``
        // for up to a minute after the customer clicked "Place
        // order" on the storefront (different app, no cache
        // overlap). 5 seconds is short enough that a tab that
        // missed a WS push (proxy hiccup, sleep/resume) still
        // reconciles in a way the operator perceives as "instant".
        staleTime: 5 * 1000,
        gcTime: 5 * 60 * 1000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          // Don't retry client-side validation or auth failures.
          if (error instanceof ApiError) {
            if (error.status >= 400 && error.status < 500) return false;
          }
          return failureCount < 2;
        },
      },
      mutations: {
        retry: false,
      },
      dehydrate: {
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) ||
          query.state.status === "pending",
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

export function getQueryClient(): QueryClient {
  if (isServer) {
    return makeQueryClient();
  }
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
