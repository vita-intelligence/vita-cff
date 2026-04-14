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
    <article className="flex h-full flex-col border-2 border-ink-1000 bg-ink-0 p-6">
      <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {label}
        </span>
      </header>
      <div className="mt-5 flex flex-1 flex-col">
        <p className="text-2xl font-black tracking-tight uppercase md:text-3xl">
          {user.full_name}
        </p>
        <p className="mt-2 font-mono text-xs text-ink-600">{user.email}</p>
      </div>
    </article>
  );
}
