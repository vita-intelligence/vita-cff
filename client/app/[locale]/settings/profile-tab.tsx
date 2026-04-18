import { Mail, User2 } from "lucide-react";
import { getTranslations } from "next-intl/server";

import type { UserDto } from "@/services/accounts/types";


/**
 * Read-only profile card. Server component — the user payload comes
 * in from the page via :func:`getCurrentUserServer`. Edits (name
 * changes, avatar, etc.) will ship as their own mutation flow later.
 */
export async function ProfileTab({ user }: { user: UserDto }) {
  const tSettings = await getTranslations("settings");

  const initials =
    ((user.first_name[0] ?? "") + (user.last_name[0] ?? "")).toUpperCase() ||
    "··";

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-ink-1000">
          {tSettings("profile.section_title")}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">
          {tSettings("profile.section_subtitle")}
        </p>
      </div>

      <article className="flex flex-col gap-5 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="flex items-center gap-4">
          <div
            aria-hidden
            className="flex h-14 w-14 items-center justify-center rounded-full bg-orange-500 text-base font-semibold text-ink-0"
          >
            {initials}
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-ink-1000">
              {user.full_name}
            </p>
            <p className="mt-0.5 truncate text-sm text-ink-500">{user.email}</p>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-4 border-t border-ink-100 pt-4 sm:grid-cols-2">
          <Field
            icon={<User2 className="h-3.5 w-3.5" />}
            label={tSettings("profile.first_name")}
            value={user.first_name || "—"}
          />
          <Field
            icon={<User2 className="h-3.5 w-3.5" />}
            label={tSettings("profile.last_name")}
            value={user.last_name || "—"}
          />
          <div className="sm:col-span-2">
            <Field
              icon={<Mail className="h-3.5 w-3.5" />}
              label={tSettings("profile.email")}
              value={user.email}
            />
          </div>
        </dl>
      </article>
    </section>
  );
}


function Field({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
        {icon}
        {label}
      </dt>
      <dd className="text-sm text-ink-1000">{value}</dd>
    </div>
  );
}
