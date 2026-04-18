import { Hourglass, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";


/**
 * Stubbed Members tab.
 *
 * The capability-based backend is in place after S1; the editor UI
 * (member list, per-module capability grid, invitation management)
 * lands in S3. This card makes the tab real so the navigation is
 * complete and the user knows the settings route is wired end-to-end.
 */
export async function MembersTab() {
  const tSettings = await getTranslations("settings");

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-ink-1000">
          {tSettings("members.section_title")}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">
          {tSettings("members.section_subtitle")}
        </p>
      </div>

      <article className="flex flex-col items-center gap-3 rounded-2xl bg-ink-0 p-10 text-center shadow-sm ring-1 ring-ink-200">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-50 text-orange-600 ring-1 ring-orange-200">
          <Users className="h-5 w-5" />
        </div>
        <h3 className="text-base font-semibold text-ink-1000">
          {tSettings("members.coming_soon")}
        </h3>
        <p className="max-w-md text-sm text-ink-500">
          {tSettings("members.coming_soon_hint")}
        </p>
        <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-3 py-1 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200">
          <Hourglass className="h-3 w-3" />
          S3
        </div>
      </article>
    </section>
  );
}
