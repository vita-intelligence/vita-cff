import { getTranslations } from "next-intl/server";

import {
  HeaderNav,
  type HeaderNavGroup,
  type HeaderNavItem,
} from "@/components/layout/header-nav";
import { HeaderSideIcons } from "@/components/layout/header-side-icons";
import { UserMenu } from "@/components/layout/user-menu";
import { MessengerBell } from "@/components/messenger";
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
  | "pipeline"
  | "rd_pipeline"
  | "customers"
  | "cff"
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
  // Proposals split out into their own RBAC module so commercial
  // roles (sales, account management) can be granted the proposal
  // surface without inheriting the broader ``formulations.*``
  // project-edit rights. The header link follows that split — visible
  // to anyone with ``proposals.view``, hidden otherwise. Customers are
  // the address book behind proposals so they piggyback on the same
  // gate.
  const canSeeProposals = hasFlatCapability(
    primaryOrg,
    "proposals",
    "view",
  );
  // Approvals + Signed surfaces are now split per module — the
  // queue is shared between Projects (spec sheets) and Proposals,
  // so the nav item shows whenever the member can read EITHER tab.
  // The page itself hides the tab the member cannot read so the
  // surface stays consistent with the per-module grants.
  // CFF intake — its own RBAC module so commercial / triage roles
  // can be granted CFF visibility without inheriting project-edit
  // rights. The page itself re-checks server-side; the header link
  // just suppresses the entry for members without the cap.
  const canSeeCFF = hasFlatCapability(primaryOrg, "cff_submissions", "view");
  const canSeeApprovals =
    hasFlatCapability(primaryOrg, "formulations", "view_approvals") ||
    hasFlatCapability(primaryOrg, "proposals", "view_approvals");
  const canSeeSigned =
    hasFlatCapability(primaryOrg, "formulations", "view_signed") ||
    hasFlatCapability(primaryOrg, "proposals", "view_signed");

  // The primary nav is split into three visual buckets so a member
  // can find a surface without scanning a long flat row of pills:
  //
  //   1. ``navItems``  — top-level peers that don't slot into a
  //      lifecycle stage. Dashboard is always first; Catalogues is
  //      cross-stage reference data underpinning everything below,
  //      so it stays at the same level rather than getting buried
  //      inside one of the dropdowns.
  //
  //   2. ``navGroups`` — collapsible dropdowns per lifecycle stage:
  //         R&D       — CFFs (intake), Projects (work), Approvals (review)
  //         Proposal  — Customers (address book), Proposals (document)
  //
  //   3. ``sideItems`` — utility destinations that render as icons in
  //      the right cluster next to the messenger bell. Pipeline and
  //      Signed live here because they are read-mostly "where am I?"
  //      views consulted across stages, not authoring surfaces.
  //
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

  const rndItems: HeaderNavItem[] = [];
  if (canSeeCFF) {
    rndItems.push({
      key: "cff",
      href: "/cff",
      label: tNav("main.cff"),
    });
  }
  if (canSeeFormulations) {
    rndItems.push({
      key: "formulations",
      href: "/formulations",
      label: tNav("main.formulations"),
    });
  }
  if (canSeeApprovals) {
    rndItems.push({
      key: "approvals",
      href: "/approvals",
      label: tNav("main.approvals"),
    });
  }

  // Customers + Proposals share the ``proposals`` module gate —
  // sales-only roles see them even without any Projects capability.
  // Customers comes first (the address book the proposal draws
  // from); Proposals is the document surface.
  const proposalItems: HeaderNavItem[] = [];
  if (canSeeProposals) {
    proposalItems.push({
      key: "customers",
      href: "/customers",
      label: tNav("main.customers"),
    });
    proposalItems.push({
      key: "proposals",
      href: "/proposals",
      label: tNav("main.proposals"),
    });
  }

  const navGroups: HeaderNavGroup[] = [];
  if (rndItems.length > 0) {
    navGroups.push({
      key: "rnd",
      label: tNav("groups.rnd"),
      items: rndItems,
    });
  }
  if (proposalItems.length > 0) {
    navGroups.push({
      key: "proposal",
      label: tNav("groups.proposal"),
      items: proposalItems,
    });
  }

  // Pipeline rides the ``proposals.view`` gate (CRM-style funnel
  // view of where every deal sits); R&D pipeline rides
  // ``formulations.view`` (kanban of where every project sits in
  // the build → spec → proposal lifecycle); Signed is the
  // closed-loop archive of signed documents, gated by either
  // module's ``view_signed`` cap.
  const sideItems: HeaderNavItem[] = [];
  if (canSeeProposals) {
    sideItems.push({
      key: "pipeline",
      href: "/pipeline",
      label: tNav("tooltips.pipeline"),
    });
  }
  if (canSeeFormulations) {
    sideItems.push({
      key: "rd_pipeline",
      href: "/rd-pipeline",
      label: tNav("tooltips.rd_pipeline"),
    });
  }
  if (canSeeSigned) {
    sideItems.push({
      key: "signed",
      href: "/signed",
      label: tNav("tooltips.signed"),
    });
  }

  // Full-bleed top bar — escapes whatever ``max-w-*`` container the
  // host page imposes (pages use a mix of ``5xl``/``6xl``/``7xl``/
  // bespoke pixel caps, which used to make the nav visibly different
  // widths page-to-page). The ``calc(50% - 50vw)`` trick centres the
  // header on the viewport regardless of the parent's width.
  //
  // The ``-mt-6 md:-mt-12`` cancels the host page's top padding
  // (``py-6 md:py-12`` — the convention shared by every staff page)
  // so the nav sits flush at the top of the viewport. Inside the
  // bar, the inner row caps at ``max-w-[1600px]`` so the brand /
  // nav / avatar cluster stays visually anchored on wide monitors
  // rather than drifting to extreme edges.
  return (
    <header
      className="-mt-6 mb-6 w-[100vw] border-b border-ink-200 bg-white md:-mt-12 md:mb-8"
      style={{ marginLeft: "calc(50% - 50vw)" }}
    >
      <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-3 sm:px-6 md:px-10 md:py-4">
        <div className="flex items-center gap-3 md:gap-6">
          <span className="text-sm font-semibold tracking-tight text-ink-1000">
            {tCommon("brand")}
          </span>
          <HeaderNav
            items={navItems}
            groups={navGroups}
            sideItems={sideItems}
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

          Side-icon shortcuts (Pipeline, Signed) sit between the
          primary nav and the messenger bell so the utility cluster
          reads as one row of icons rather than getting mixed in with
          the lifecycle pills.
        */}
        <div className="flex items-center gap-1 md:gap-2">
          <HeaderSideIcons items={sideItems} active={active} />
          <MessengerBell />
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
        </div>
      </div>
    </header>
  );
}
