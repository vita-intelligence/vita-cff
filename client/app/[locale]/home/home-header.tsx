import { HomeActions } from "./home-actions";

interface HomeHeaderProps {
  brand: string;
  userFullName: string;
  userInitials: string;
}

/**
 * Top-of-page protected shell header. Brand on the left, user identity
 * plus sign-out action on the right. Stays a server component — no
 * interactive state lives here besides the ``HomeActions`` sign-out
 * button, which is a small client component.
 */
export function HomeHeader({ brand, userFullName, userInitials }: HomeHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-6">
      <span className="font-mono text-xs tracking-widest uppercase text-ink-700">
        {brand}
      </span>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center border-2 border-ink-1000 bg-ink-1000 font-mono text-xs font-bold tracking-widest text-ink-0">
            {userInitials}
          </div>
          <span className="hidden font-mono text-xs tracking-widest uppercase text-ink-700 md:inline">
            {userFullName}
          </span>
        </div>
        <HomeActions />
      </div>
    </header>
  );
}
