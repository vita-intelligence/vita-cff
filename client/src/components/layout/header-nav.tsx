"use client";

import { LogOut, Menu, Settings, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { useLogout } from "@/services/accounts";

import type { ProtectedNavKey } from "./protected-header";


export interface HeaderNavItem {
  readonly key: ProtectedNavKey;
  readonly href:
    | "/home"
    | "/catalogues"
    | "/formulations"
    | "/proposals"
    | "/customers";
  readonly label: string;
}


export interface HeaderNavProps {
  readonly items: readonly HeaderNavItem[];
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
 * The mobile drawer mirrors the desktop avatar menu: primary nav
 * links at the top, the signed-in user block + Settings + Sign out
 * at the bottom. Phones don't get the floating avatar dropdown —
 * everything lives in the one drawer.
 */
export function HeaderNav({
  items,
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
        {items.map((item) => {
          const isActive = item.key === active;
          return (
            <Link
              key={item.key}
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
        })}
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
            <ul className="flex flex-col gap-1 overflow-y-auto">
              {items.map((item) => {
                const isActive = item.key === active;
                return (
                  <li key={item.key}>
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
                  </li>
                );
              })}
            </ul>

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
