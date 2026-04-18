import { getTranslations } from "next-intl/server";

import { HeaderNav, type HeaderNavItem } from "@/components/layout/header-nav";
import { UserMenu } from "@/components/layout/user-menu";
import type { UserDto } from "@/services/accounts/types";

export type ProtectedNavKey =
  | "dashboard"
  | "catalogues"
  | "formulations";

interface ProtectedHeaderProps {
  user: UserDto;
  active?: ProtectedNavKey;
}

/**
 * Shared top-of-page header for every authenticated route.
 *
 * Renders the brand, the primary nav, and a per-user avatar menu
 * (Settings / Sign out). The ``active`` prop highlights the current
 * section so the header is the single source of truth for which nav
 * item is selected — callers don't need to repeat the ``<Link>``
 * block and keep it in sync manually.
 *
 * Server component: it pulls its own translations and has no client
 * state of its own. The mobile hamburger lives inside
 * :class:`HeaderNav` (which also hosts the mobile Settings/Sign-out
 * footer); the desktop avatar dropdown lives inside :class:`UserMenu`.
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

  // Specifications intentionally omitted — every spec sheet belongs
  // to a project, so it's surfaced inside the project workspace's
  // "Spec sheets" tab rather than as a peer top-level destination.
  const navItems: readonly HeaderNavItem[] = [
    { key: "dashboard", href: "/home", label: tNav("main.dashboard") },
    {
      key: "catalogues",
      href: "/catalogues",
      label: tNav("main.catalogues"),
    },
    {
      key: "formulations",
      href: "/formulations",
      label: tNav("main.formulations"),
    },
  ];

  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 md:gap-6">
        <span className="text-sm font-semibold tracking-tight text-ink-1000">
          {tCommon("brand")}
        </span>
        <HeaderNav
          items={navItems}
          active={active}
          menuLabel={tNav("menu.open")}
          closeLabel={tNav("menu.close")}
          settingsLabel={tNav("menu.settings")}
          signOutLabel={tNav("account.sign_out")}
          fullName={user.full_name}
          email={user.email}
        />
      </div>
      {/*
        Desktop gets the avatar dropdown; mobile folds Settings and
        Sign-out into the hamburger drawer itself, so the avatar is
        redundant there and would just steal tap targets.
      */}
      <div className="hidden md:flex">
        <UserMenu
          fullName={user.full_name}
          email={user.email}
          initials={initials}
          labels={{
            settings: tNav("menu.settings"),
            signOut: tNav("account.sign_out"),
            openMenu: tNav("menu.open_user"),
          }}
        />
      </div>
    </header>
  );
}
