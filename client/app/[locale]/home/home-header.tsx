import { Link } from "@/i18n/navigation";

import { HomeActions } from "./home-actions";

interface HomeHeaderProps {
  brand: string;
  userFullName: string;
  userInitials: string;
  dashboardLabel: string;
  cataloguesLabel: string;
}

/**
 * Top-of-page protected shell header. Brand on the left, primary nav
 * plus user identity and sign-out action on the right. Stays a server
 * component — only the ``HomeActions`` sign-out button is interactive.
 */
export function HomeHeader({
  brand,
  userFullName,
  userInitials,
  dashboardLabel,
  cataloguesLabel,
}: HomeHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-6">
      <div className="flex items-center gap-8">
        <span className="font-mono text-xs tracking-widest uppercase text-ink-700">
          {brand}
        </span>
        <nav className="flex items-center gap-6 font-mono text-[10px] tracking-widest uppercase">
          <Link
            href="/home"
            className="border-b-2 border-ink-1000 text-ink-1000"
          >
            {dashboardLabel}
          </Link>
          <Link
            href="/catalogues"
            className="text-ink-500 hover:text-ink-1000"
          >
            {cataloguesLabel}
          </Link>
        </nav>
      </div>
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
