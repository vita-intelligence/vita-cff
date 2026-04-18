import { Building2 } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import type { OrganizationDto } from "@/services/organizations/types";


/**
 * Summary of the user's current organization on the dashboard.
 *
 * For this slice we show the primary organization and a role chip. A
 * multi-org switcher will live in the header later.
 */
export function OrganizationCard({
  organization,
  label,
  roleLabel,
}: {
  organization: OrganizationDto;
  label: string;
  roleLabel: string;
}) {
  return (
    <article className="flex h-full flex-col gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Building2 className="h-4 w-4 text-ink-500" />
          <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {label}
          </span>
        </div>
        <Chip tone={organization.is_owner ? "orange" : "neutral"}>
          {roleLabel}
        </Chip>
      </header>
      <div>
        <p className="text-xl font-semibold tracking-tight text-ink-1000 sm:text-2xl">
          {organization.name}
        </p>
      </div>
    </article>
  );
}
