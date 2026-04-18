import "server-only";

import { hasFlatCapability } from "@/lib/auth/capabilities";
import type { OrganizationDto } from "@/services/organizations/types";

import type { SettingsTabKey } from "../settings-shell";


/**
 * Compute which ``/settings`` tabs the caller can see.
 *
 * Profile and Organization are always available — they're self-
 * context, not admin surfaces. Members is gated on
 * ``members.view`` so locked-out accounts stop seeing a tab that
 * just lands them on access-denied.
 *
 * Callers pass the primary organization payload (or ``null`` if
 * the user has no org yet). Since we don't rely on the full
 * permissions shape for any other tab, the helper stays deliberately
 * narrow — add new logic when a new tab demands it.
 */
export function computeAllowedSettingsTabs(
  primaryOrg: OrganizationDto | null,
): readonly SettingsTabKey[] {
  const tabs: SettingsTabKey[] = ["profile", "organization"];
  if (hasFlatCapability(primaryOrg, "members", "view")) {
    tabs.push("members");
  }
  if (hasFlatCapability(primaryOrg, "audit", "view")) {
    tabs.push("audit-log");
  }
  return tabs;
}
