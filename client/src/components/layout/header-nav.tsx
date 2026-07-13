"use client";

import { ChevronDown, LogOut, Menu, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useLogout } from "@/services/accounts";

import type { ProtectedNavKey } from "./protected-header";


export type HeaderNavHref =
  | "/home"
  | "/catalogues"
  | "/formulations"
  | "/rtg-catalog"
  | "/proposals"
  | "/pipeline"
  | "/rd-pipeline"
  | "/customers"
  | "/cff"
  | "/approvals"
  | "/signed"
  | "/labelling"
  | "/finance/payments";


export interface HeaderNavItem {
  readonly key: ProtectedNavKey;
  readonly href: HeaderNavHref;
  readonly label: string;
}


/**
 * A grouping of nav items collapsed under a single dropdown pill.
 * Used to break the primary nav into lifecycle stages (R&D, Proposal)
 * so a member's eye doesn't have to scan a long flat row to find the
 * surface they want.
 */
export interface HeaderNavGroup {
  readonly key: string;
  readonly label: string;
  readonly items: readonly HeaderNavItem[];
}


export interface HeaderNavProps {
  readonly items: readonly HeaderNavItem[];
  readonly groups?: readonly HeaderNavGroup[];
  readonly sideItems?: readonly HeaderNavItem[];
  readonly active?: ProtectedNavKey;
  readonly menuLabel: string;
  readonly closeLabel: string;
  readonly settingsLabel: string;
  readonly signOutLabel: string;
  readonly fullName: string;
  readonly email: string;
}


/**
 * Desktop link bar + mobile hamburger drawer for the authenticated
 * header.
 *
 * Kept as its own client island because the parent :func:`ProtectedHeader`
 * is a Server Component that pulls translations up-front — we need
 * ``useState`` here for the open/close toggle without forcing the
 * whole header to hydrate on every navigation.
 *
 * Desktop layout:
 *   [ flat items… ]  [ R&D ▾ ]  [ Proposal ▾ ]
 *
 * Side-icon destinations (Pipeline, Signed) render on the right cluster
 * of the header itself — they are passed in here only so the mobile
 * drawer can surface them alongside the rest of the nav.
 */
export function HeaderNav({
  items,
  groups = [],
  sideItems = [],
  active,
  menuLabel,
  closeLabel,
  settingsLabel,
  signOutLabel,
  fullName,
  email,
}: HeaderNavProps) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const logout = useLogout();

  // Close the drawer on route change so clicking a nav item always
  // lands the user on a clean page rather than the drawer flashing
  // open over the destination.
  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  // Lock body scroll while the drawer covers the viewport — iOS
  // otherwise lets the backdrop scroll through.
  useEffect(() => {
    if (!isOpen) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = original;
    };
  }, [isOpen]);

  const handleSignOut = async () => {
    setIsOpen(false);
    try {
      await logout.mutateAsync();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <>
      <nav
        aria-label="Primary"
        className="hidden items-center gap-1 md:flex"
      >
        {items.map((item) => (
          <DesktopNavLink key={item.key} item={item} active={active} />
        ))}
        {groups.map((group) => (
          <DesktopNavGroup key={group.key} group={group} active={active} />
        ))}
      </nav>

      <button
        type="button"
        aria-label={isOpen ? closeLabel : menuLabel}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 md:hidden"
      >
        {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {isOpen ? (
        <div
          className="fixed inset-0 z-40 md:hidden"
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-ink-1000/40 backdrop-blur-sm"
          />
          <div className="absolute inset-x-3 top-3 flex max-h-[calc(100dvh-1.5rem)] flex-col rounded-2xl bg-ink-0 p-3 shadow-lg ring-1 ring-ink-200">
            <div className="flex items-center justify-end pb-1">
              <button
                type="button"
                aria-label={closeLabel}
                onClick={() => setIsOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-ink-700 hover:bg-ink-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-col gap-1 overflow-y-auto">
              <ul className="flex flex-col gap-1">
                {items.map((item) => (
                  <li key={item.key}>
                    <MobileNavLink item={item} active={active} />
                  </li>
                ))}
              </ul>
              {groups.map((group) => (
                <section key={group.key} className="mt-2">
                  <p className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                    {group.label}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {group.items.map((item) => (
                      <li key={item.key}>
                        <MobileNavLink item={item} active={active} />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {sideItems.length > 0 ? (
                <section className="mt-2 border-t border-ink-200 pt-2">
                  <ul className="flex flex-col gap-1">
                    {sideItems.map((item) => (
                      <li key={item.key}>
                        <MobileNavLink item={item} active={active} />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>

            <div className="mt-3 border-t border-ink-200 pt-3">
              <div className="px-4 pb-2">
                <p className="truncate text-sm font-medium text-ink-1000">
                  {fullName}
                </p>
                <p className="mt-0.5 truncate text-xs text-ink-500">{email}</p>
              </div>
              <ul className="flex flex-col gap-1">
                <li>
                  <Link
                    href="/settings"
                    className="flex items-center gap-2 rounded-xl px-4 py-3 text-base font-medium text-ink-700 hover:bg-ink-50"
                  >
                    <Settings className="h-4 w-4" />
                    {settingsLabel}
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    disabled={logout.isPending}
                    className="flex w-full items-center gap-2 rounded-xl px-4 py-3 text-left text-base font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
                  >
                    <LogOut className="h-4 w-4" />
                    {signOutLabel}
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}


function DesktopNavLink({
  item,
  active,
}: {
  item: HeaderNavItem;
  active: ProtectedNavKey | undefined;
}) {
  const isActive = item.key === active;
  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "rounded-lg bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-700 ring-1 ring-inset ring-orange-200"
          : "rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-1000"
      }
    >
      {item.label}
    </Link>
  );
}


function MobileNavLink({
  item,
  active,
}: {
  item: HeaderNavItem;
  active: ProtectedNavKey | undefined;
}) {
  const isActive = item.key === active;
  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={
        isActive
          ? "block rounded-xl bg-orange-50 px-4 py-3 text-base font-medium text-orange-700 ring-1 ring-inset ring-orange-200"
          : "block rounded-xl px-4 py-3 text-base font-medium text-ink-700 hover:bg-ink-50"
      }
    >
      {item.label}
    </Link>
  );
}


/**
 * Click-to-open dropdown pill for a stage group. Closes on outside
 * click, Escape, or route change — the same affordances the messenger
 * bell uses, so the muscle memory carries across the top bar.
 *
 * The pill itself shows an active treatment whenever any item inside
 * the group matches the current route, so the user can tell at a
 * glance which stage they are inside even before opening the menu.
 */
function DesktopNavGroup({
  group,
  active,
}: {
  group: HeaderNavGroup;
  active: ProtectedNavKey | undefined;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    setIsOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!isOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [isOpen]);

  const isGroupActive = group.items.some((item) => item.key === active);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((v) => !v)}
        className={
          isGroupActive
            ? "inline-flex items-center gap-1 rounded-lg bg-orange-50 px-3 py-1.5 text-sm font-medium text-orange-700 ring-1 ring-inset ring-orange-200"
            : "inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-medium text-ink-600 transition-colors hover:bg-ink-50 hover:text-ink-1000"
        }
      >
        {group.label}
        <ChevronDown
          className={
            isOpen
              ? "h-3.5 w-3.5 transition-transform rotate-180"
              : "h-3.5 w-3.5 transition-transform"
          }
        />
      </button>
      {isOpen ? (
        <div
          role="menu"
          className="absolute left-0 top-full z-40 mt-2 min-w-[180px] rounded-xl border border-ink-200 bg-white p-1 shadow-lg"
        >
          <ul className="flex flex-col">
            {group.items.map((item) => {
              const isActive = item.key === active;
              return (
                <li key={item.key} role="none">
                  <Link
                    role="menuitem"
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    className={
                      isActive
                        ? "block rounded-lg bg-orange-50 px-3 py-2 text-sm font-medium text-orange-700"
                        : "block rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
                    }
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
