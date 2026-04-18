import { ArrowRight, Building2 } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { Link } from "@/i18n/navigation";
import type { OrganizationDto } from "@/services/organizations/types";


/**
 * Summary of the user's current organization on the dashboard.
 *
 * Linked to ``/settings/organization`` so clicking drops the user
 * into the real settings surface (where the name + members live).
 * A multi-org switcher will live in the header later; for now one
 * org, one card.
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
    <Link
      href="/settings/organization"
      className="group flex h-full flex-col gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 transition-shadow hover:shadow-md"
    >
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
      <div className="flex items-end justify-between gap-2">
        <p className="text-xl font-semibold tracking-tight text-ink-1000 sm:text-2xl">
          {organization.name}
        </p>
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-orange-700" />
      </div>
    </Link>
  );
}
