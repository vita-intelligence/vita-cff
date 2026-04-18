import { User2 } from "lucide-react";

import type { UserDto } from "@/services/accounts/types";


/**
 * Static profile summary shown on the dashboard. Server component — no
 * interactivity needed.
 */
export function ProfileCard({
  user,
  label,
}: {
  user: UserDto;
  label: string;
}) {
  return (
    <article className="flex h-full flex-col gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex items-center gap-2">
        <User2 className="h-4 w-4 text-ink-500" />
        <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {label}
        </span>
      </header>
      <div>
        <p className="text-xl font-semibold tracking-tight text-ink-1000 sm:text-2xl">
          {user.full_name}
        </p>
        <p className="mt-1 text-sm text-ink-500">{user.email}</p>
      </div>
    </article>
  );
}
