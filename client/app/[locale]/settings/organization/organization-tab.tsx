import { Building2 } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Chip } from "@/components/ui/chip";
import type { OrganizationDto } from "@/services/organizations/types";

import { CreateOrganizationCard } from "../../home/create-organization-card";


/**
 * Organization settings tab. For now it's read-only — the org name,
 * the caller's role, and (if no org exists yet) the existing create
 * form lifted from the dashboard.
 *
 * Editing the name and transferring ownership will land in their own
 * mutation flows later; they need their own permission checks and the
 * capability-editor UI in :class:`MembersTab` is the more pressing
 * gap right now.
 */
export async function OrganizationTab({
  organization,
}: {
  organization: OrganizationDto | null;
}) {
  const tSettings = await getTranslations("settings");

  if (organization === null) {
    return (
      <section className="flex flex-col gap-4">
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold text-ink-1000">
            {tSettings("organization.no_org_title")}
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {tSettings("organization.no_org_hint")}
          </p>
        </div>
        <CreateOrganizationCard />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-ink-1000">
          {tSettings("organization.section_title")}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">
          {tSettings("organization.section_subtitle")}
        </p>
      </div>

      <article className="flex flex-col gap-5 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="flex items-center gap-4">
          <div
            aria-hidden
            className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-1000 text-ink-0"
          >
            <Building2 className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-ink-1000">
              {organization.name}
            </p>
            <p className="mt-0.5 text-sm text-ink-500">
              {tSettings("organization.name")}
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-4 border-t border-ink-100 pt-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {tSettings("organization.role")}
            </dt>
            <dd>
              <Chip tone={organization.is_owner ? "orange" : "neutral"}>
                {organization.is_owner
                  ? tSettings("organization.role_owner")
                  : tSettings("organization.role_member")}
              </Chip>
            </dd>
          </div>
        </dl>
      </article>
    </section>
  );
}
