/**
 * Shared SSR loader for every Project workspace tab.
 *
 * Each tab page runs the same auth + org + formulation + overview
 * bootstrap. Rather than duplicating 30 lines per tab, we collapse
 * the sequence into one call — each page then handles its own
 * tab-specific data on top.
 */

import { notFound } from "next/navigation";

import { redirect } from "@/i18n/navigation";
import { resolveLegacyFlatLevel } from "@/lib/auth/capabilities";
import {
  getCurrentUserServer,
  getFormulationServer,
  getProjectOverviewServer,
  getUserOrganizationsServer,
} from "@/lib/auth/server";
import type { OrganizationDto } from "@/services/organizations/types";
import type { UserDto } from "@/services/accounts/types";
import type {
  FormulationDto,
  ProjectOverviewDto,
} from "@/services/formulations/types";


export type FormulationsPermission = "admin" | "write" | "read" | "none";


/**
 * Bridge the legacy 4-state permission contract this file's callers
 * still consume with the capability-list storage the backend now
 * uses. Centralised in :func:`resolveLegacyFlatLevel` so the mapping
 * (``delete → admin``, ``edit → write``, ``view → read``) lives in
 * exactly one place.
 */
export function resolveFormulationsPermission(
  organization: OrganizationDto,
): FormulationsPermission {
  return resolveLegacyFlatLevel(organization, "formulations");
}


export interface LoadedProject {
  readonly user: UserDto;
  readonly organization: OrganizationDto;
  readonly formulation: FormulationDto;
  readonly overview: ProjectOverviewDto;
  readonly level: "admin" | "write" | "read";
  readonly canWrite: boolean;
  readonly canAdmin: boolean;
}


/**
 * Load everything a Project workspace tab needs in a single SSR
 * waterfall. Handles redirects (anonymous → /login, no orgs →
 * /home, no permission → /formulations) and 404s (missing
 * formulation). Returning from this function means the caller can
 * safely render the shell.
 */
export async function loadProjectForTab(
  locale: string,
  formulationId: string,
): Promise<LoadedProject> {
  const user = await getCurrentUserServer();
  if (!user) {
    redirect({ href: "/login", locale });
  }

  const organizations = (await getUserOrganizationsServer()) ?? [];
  if (organizations.length === 0) {
    redirect({ href: "/home", locale });
  }
  const primaryOrg = organizations[0]!;

  const level = resolveFormulationsPermission(primaryOrg);
  if (level === "none") {
    redirect({ href: "/formulations", locale });
  }

  const [formulation, overview] = await Promise.all([
    getFormulationServer(primaryOrg.id, formulationId),
    getProjectOverviewServer(primaryOrg.id, formulationId),
  ]);
  if (!formulation || !overview) {
    notFound();
  }

  const canWrite = level === "write" || level === "admin";
  const canAdmin = level === "admin";

  return {
    user: user!,
    organization: primaryOrg,
    formulation,
    overview,
    level: level as "admin" | "write" | "read",
    canWrite,
    canAdmin,
  };
}
