"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Link, usePathname } from "@/i18n/navigation";

import type { ProtectedNavKey } from "./protected-header";


export interface HeaderNavItem {
  readonly key: ProtectedNavKey;
  readonly href: "/home" | "/catalogues" | "/formulations" | "/specifications";
  readonly label: string;
}


/**
 * Desktop link bar + mobile hamburger drawer for the authenticated
 * header.
 *
 * Kept as its own client island because the parent :func:`ProtectedHeader`
 * is a Server Component that pulls translations up-front — we need
 * ``useState`` here for the open/close toggle without forcing the
 * whole header to hydrate on every navigation.
 */
export function HeaderNav({
  items,
  active,
  menuLabel,
  closeLabel,
}: {
  items: readonly HeaderNavItem[];
  active?: ProtectedNavKey;
  menuLabel: string;
  closeLabel: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const pathname = usePathname();

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
          <div className="absolute inset-x-3 top-3 rounded-2xl bg-ink-0 p-3 shadow-lg ring-1 ring-ink-200">
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
            <ul className="flex flex-col gap-1">
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
          </div>
        </div>
      ) : null}
    </>
  );
}
