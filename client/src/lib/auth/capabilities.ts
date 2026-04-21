/**
 * Tiny client-safe helpers for deciding which UI an
 * :class:`OrganizationDto` payload authorises.
 *
 * The organizations endpoint already embeds the caller's
 * ``is_owner`` flag + ``permissions`` dict directly on each org row
 * (see ``OrganizationReadSerializer`` on the backend). These helpers
 * turn that payload into yes/no questions about specific
 * capabilities so nav bars, tab lists, and conditional buttons can
 * hide themselves without re-fetching anything.
 *
 * Keep this free of ``server-only`` imports — both Server Components
 * and Client Components read organization DTOs, and both should be
 * able to make the same decision with the same function.
 */

import type { OrganizationDto } from "@/services/organizations/types";


type Permissions = OrganizationDto["permissions"];


/**
 * Return ``true`` if the caller has ``capability`` on a flat module.
 *
 * Owners always return ``true``; the backend ignores their
 * permissions dict entirely and we mirror that here.
 */
export function hasFlatCapability(
  organization: OrganizationDto | null | undefined,
  moduleKey: string,
  capability: string,
): boolean {
  if (!organization) return false;
  if (organization.is_owner) return true;
  const raw = (organization.permissions as Permissions | undefined)?.[
    moduleKey
  ];
  return Array.isArray(raw) && raw.includes(capability);
}


/**
 * Return ``true`` if the caller holds ``capability`` on **any** row of
 * a row-scoped module.
 *
 * Useful for top-level nav: "can they see the Catalogues page at all?"
 * is a yes if they have view on even a single catalogue slug. The per-
 * row filter still applies once they land on the list.
 */
export function hasAnyRowScopedCapability(
  organization: OrganizationDto | null | undefined,
  moduleKey: string,
  capability: string,
): boolean {
  if (!organization) return false;
  if (organization.is_owner) return true;
  const raw = (organization.permissions as Permissions | undefined)?.[
    moduleKey
  ];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const slugCaps of Object.values(raw as Record<string, unknown>)) {
      if (Array.isArray(slugCaps) && slugCaps.includes(capability)) {
        return true;
      }
    }
  }
  return false;
}


// ---------------------------------------------------------------------------
// Legacy "level" adapter
//
// Several pages predate the capability grid and still read a
// ``permissions.<module>`` string ("admin" | "write" | "read"). The
// backend now stores a list of capability strings instead. These two
// helpers walk the new shape and return the closest legacy bucket so
// downstream code (``canRead`` / ``canWrite`` / ``canAdmin`` gates,
// button visibility) does not need a rewrite.
// ---------------------------------------------------------------------------


export type LegacyLevel = "admin" | "write" | "read" | "none";


/**
 * Translate a flat capability list into the legacy 4-state level.
 *
 * Mapping:
 *   - ``delete`` → ``"admin"``  (highest-privilege cap on every module
 *                               that declares one; equivalent to the
 *                               old "admin tier" footprint)
 *   - ``edit``   → ``"write"``
 *   - ``view``   → ``"read"``
 *   - otherwise → ``"none"``
 *
 * Owners short-circuit to ``"admin"`` exactly like the backend's
 * ``has_capability`` does — their ``permissions`` dict is ignored.
 */
export function resolveLegacyFlatLevel(
  organization: OrganizationDto | null | undefined,
  moduleKey: string,
): LegacyLevel {
  if (!organization) return "none";
  if (organization.is_owner) return "admin";
  const raw = (organization.permissions as Permissions | undefined)?.[
    moduleKey
  ];
  if (!Array.isArray(raw)) return "none";
  if (raw.includes("delete")) return "admin";
  if (raw.includes("edit")) return "write";
  if (raw.includes("view")) return "read";
  return "none";
}


/**
 * Row-scoped variant. Uses the same ``delete → admin`` / ``edit →
 * write`` / ``view → read`` ladder, but reads the nested
 * ``{scope: [caps]}`` shape row-scoped modules store under
 * ``permissions[moduleKey]``.
 */
export function resolveLegacyRowScopedLevel(
  organization: OrganizationDto | null | undefined,
  moduleKey: string,
  scope: string,
): LegacyLevel {
  if (!organization) return "none";
  if (organization.is_owner) return "admin";
  const raw = (organization.permissions as Permissions | undefined)?.[
    moduleKey
  ];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "none";
  const caps = (raw as Record<string, unknown>)[scope];
  if (!Array.isArray(caps)) return "none";
  if (caps.includes("delete") || caps.includes("manage_fields")) return "admin";
  if (caps.includes("edit") || caps.includes("import")) return "write";
  if (caps.includes("view")) return "read";
  return "none";
}
