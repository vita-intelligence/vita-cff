/**
 * Query key factory root.
 *
 * Each service module is expected to export its own sub-factory and attach
 * it under a stable namespace here so cache invalidations never collide
 * across domains.
 *
 * Example (inside ``services/accounts/hooks.ts``)::
 *
 *     const accountsKeys = {
 *       all: ["accounts"] as const,
 *       me: () => [...accountsKeys.all, "me"] as const,
 *     } as const;
 */

export const rootQueryKey = ["vita"] as const;

export type QueryKeyPath = readonly (string | number | Record<string, unknown>)[];
