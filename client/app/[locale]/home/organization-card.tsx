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
    <article className="flex h-full flex-col border-2 border-ink-1000 bg-ink-0 p-6">
      <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {label}
        </span>
        <span className="border-2 border-ink-1000 bg-ink-1000 px-2 py-0.5 text-[10px] font-bold tracking-widest uppercase text-ink-0">
          {roleLabel}
        </span>
      </header>
      <div className="mt-5 flex flex-1 flex-col">
        <p className="text-2xl font-black tracking-tight uppercase md:text-3xl">
          {organization.name}
        </p>
      </div>
    </article>
  );
}
