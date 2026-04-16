import { getTranslations } from "next-intl/server";

import { SignOutButton } from "@/components/layout/sign-out-button";
import { Link } from "@/i18n/navigation";
import type { UserDto } from "@/services/accounts/types";

export type ProtectedNavKey =
  | "dashboard"
  | "catalogues"
  | "formulations"
  | "specifications";

interface ProtectedHeaderProps {
  user: UserDto;
  active?: ProtectedNavKey;
}

/**
 * Shared top-of-page header for every authenticated route.
 *
 * Renders the brand, the primary nav, and the signed-in user block
 * with the sign-out button. The ``active`` prop highlights the
 * current section so the header is the single source of truth for
 * which nav item is selected — callers don't need to repeat the
 * `<Link>` block and keep it in sync manually.
 *
 * Server component: it pulls its own translations and has no client
 * state of its own. The only interactive child is the sign-out
 * button inside :class:`SignOutButton`.
 */
export async function ProtectedHeader({
  user,
  active,
}: ProtectedHeaderProps) {
  const tCommon = await getTranslations("common");
  const tNav = await getTranslations("navigation");

  const initials =
    ((user.first_name[0] ?? "") + (user.last_name[0] ?? "")).toUpperCase() ||
    "··";

  const navItems: readonly {
    readonly key: ProtectedNavKey;
    readonly href:
      | "/home"
      | "/catalogues"
      | "/formulations"
      | "/specifications";
    readonly label: string;
  }[] = [
    { key: "dashboard", href: "/home", label: tNav("main.dashboard") },
    { key: "catalogues", href: "/catalogues", label: tNav("main.catalogues") },
    {
      key: "formulations",
      href: "/formulations",
      label: tNav("main.formulations"),
    },
    {
      key: "specifications",
      href: "/specifications",
      label: tNav("main.specifications"),
    },
  ];

  return (
    <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-6">
      <div className="flex items-center gap-8">
        <span className="font-mono text-xs tracking-widest uppercase text-ink-700">
          {tCommon("brand")}
        </span>
        <nav className="flex items-center gap-6 font-mono text-[10px] tracking-widest uppercase">
          {navItems.map((item) => {
            const isActive = item.key === active;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={
                  isActive
                    ? "border-b-2 border-ink-1000 text-ink-1000"
                    : "text-ink-500 hover:text-ink-1000"
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center border-2 border-ink-1000 bg-ink-1000 font-mono text-xs font-bold tracking-widest text-ink-0">
            {initials}
          </div>
          <span className="hidden font-mono text-xs tracking-widest uppercase text-ink-700 md:inline">
            {user.full_name}
          </span>
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}
