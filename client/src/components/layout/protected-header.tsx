import { getTranslations } from "next-intl/server";

import { HeaderNav, type HeaderNavItem } from "@/components/layout/header-nav";
import { UserMenu } from "@/components/layout/user-menu";
import {
  hasAnyRowScopedCapability,
  hasFlatCapability,
} from "@/lib/auth/capabilities";
import { getUserOrganizationsServer } from "@/lib/auth/server";
import type { UserDto } from "@/services/accounts/types";

export type ProtectedNavKey =
  | "dashboard"
  | "catalogues"
  | "formulations"
  | "proposals"
  | "customers"
  | "approvals"
  | "signed";

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


  // Capability-gated nav — a locked-out user sees only Dashboard so
  // they never land on an access-denied screen one click away.
  // ``getUserOrganizationsServer`` is ``react.cache``-wrapped, so
  // this re-call is free when the outer page already fetched orgs.
  const organizations = (await getUserOrganizationsServer()) ?? [];
  const primaryOrg = organizations[0] ?? null;

  const canSeeCatalogues = hasAnyRowScopedCapability(
    primaryOrg,
    "catalogues",
    "view",
  );
  const canSeeFormulations = hasFlatCapability(
    primaryOrg,
    "formulations",
    "view",
  );
  // Approvals + Signed each have their own dedicated visibility
  // capability so admins can hand out read access independently
  // of the actual sign-off right (``approve``). A QA lead can
  // then watch the queue without being able to flip statuses; a
  // sales rep can browse signed history without project-edit
  // access. Both are off by default for non-owners.
  const canSeeApprovals = hasFlatCapability(
    primaryOrg,
    "formulations",
    "view_approvals",
  );
  const canSeeSigned = hasFlatCapability(
    primaryOrg,
    "formulations",
    "view_signed",
  );

  // Specifications intentionally omitted — every spec sheet belongs
  // to a project, so it's surfaced inside the project workspace's
  // "Spec sheets" tab rather than as a peer top-level destination.
  const navItems: HeaderNavItem[] = [
    { key: "dashboard", href: "/home", label: tNav("main.dashboard") },
  ];
  if (canSeeCatalogues) {
    navItems.push({
      key: "catalogues",
      href: "/catalogues",
      label: tNav("main.catalogues"),
    });
  }
  if (canSeeFormulations) {
    navItems.push({
      key: "formulations",
      href: "/formulations",
      label: tNav("main.formulations"),
    });
    // Proposals live alongside Formulations so a sales user can
    // stitch together a multi-project quote without needing to
    // drill into a specific project first. Same capability as
    // formulations because they piggyback on the same permissions.
    navItems.push({
      key: "proposals",
      href: "/proposals",
      label: tNav("main.proposals"),
    });
    // Customers are the address-book behind proposals — surfaced
    // next to them so sales can manage the list without digging
    // into a proposal first. Same capability gate as proposals.
    navItems.push({
      key: "customers",
      href: "/customers",
      label: tNav("main.customers"),
    });
  }
  if (canSeeApprovals) {
    navItems.push({
      key: "approvals",
      href: "/approvals",
      label: tNav("main.approvals"),
    });
  }
  if (canSeeSigned) {
    navItems.push({
      key: "signed",
      href: "/signed",
      label: tNav("main.signed"),
    });
  }

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
          avatarUrl={user.avatar_image || ""}
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
