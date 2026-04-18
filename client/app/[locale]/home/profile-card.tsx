import { ArrowRight, User2 } from "lucide-react";

import { Link } from "@/i18n/navigation";
import type { UserDto } from "@/services/accounts/types";


/**
 * Static profile summary shown on the dashboard, linked to
 * ``/settings`` so clicking opens the real profile surface.
 */
export function ProfileCard({
  user,
  label,
}: {
  user: UserDto;
  label: string;
}) {
  return (
    <Link
      href="/settings"
      className="group flex h-full flex-col gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 transition-shadow hover:shadow-md"
    >
      <header className="flex items-center gap-2">
        <User2 className="h-4 w-4 text-ink-500" />
        <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {label}
        </span>
      </header>
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xl font-semibold tracking-tight text-ink-1000 sm:text-2xl">
            {user.full_name}
          </p>
          <p className="mt-1 truncate text-sm text-ink-500">{user.email}</p>
        </div>
        <ArrowRight className="h-4 w-4 shrink-0 text-ink-400 transition-transform group-hover:translate-x-0.5 group-hover:text-orange-700" />
      </div>
    </Link>
  );
}
