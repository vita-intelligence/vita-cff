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
