import { Lock } from "lucide-react";
import { getTranslations } from "next-intl/server";


/**
 * Shown when the caller lacks ``members.view`` — the Settings route
 * remains reachable (we don't want to redirect away from a user-
 * discoverable link), but the tab content is gated.
 */
export async function MembersTabAccessDenied() {
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
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-ink-100 text-ink-700 ring-1 ring-ink-200">
          <Lock className="h-5 w-5" />
        </div>
        <h3 className="text-base font-semibold text-ink-1000">
          {tSettings("members.access_denied_title")}
        </h3>
        <p className="max-w-md text-sm text-ink-500">
          {tSettings("members.access_denied_body")}
        </p>
      </article>
    </section>
  );
}
