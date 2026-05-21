"use client";

/**
 * Brutalist customer-portal mobile drawer.
 *
 * Architecture:
 *
 *   * **Panel + backdrop visibility** is CSS-driven (Tailwind
 *     ``transition-transform`` / ``transition-opacity`` flipped by
 *     the ``open`` boolean). Reliable, paints synchronously, no
 *     timeline-build race.
 *   * **Nav-item stagger + sign-out flourish** are GSAP-driven —
 *     fired only on open, target the elements that are already in
 *     the DOM. This is what the user explicitly asked for; the
 *     panel slide doesn't need GSAP and putting it on the same
 *     timeline made the visibility depend on a timeline that
 *     could fail to build.
 *
 * The overlay (backdrop + panel) is portalled to ``document.body``
 * via :func:`createPortal` so it escapes any ancestor that
 * establishes a containing block for ``position: fixed`` —
 * notably the PortalShell header, which uses ``backdrop-blur``.
 * Without the portal, the panel would render relative to the
 * header rather than the viewport (the bug an earlier revision
 * hit).
 *
 * Close handlers: backdrop tap, ✕ button, Esc key, tapping any
 * nav item. Body scroll locks while the drawer is open so iOS
 * doesn't yank the page out from under the overlay.
 */

import gsap from "gsap";
import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { PortalNavSection } from "@/components/portal/brutalist";
import { useRouter } from "next/navigation";
import { logout as portalLogout } from "@/services/portal/api";


export interface PortalMobileDrawerNavItem {
  readonly key: PortalNavSection;
  readonly href: string;
  readonly label: string;
}


export function PortalMobileDrawer({
  items,
  active,
}: {
  items: ReadonlyArray<PortalMobileDrawerNavItem>;
  active?: PortalNavSection;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  //: ``createPortal`` requires ``document.body`` which isn't
  //: available during SSR. Track readiness so the overlay only
  //: renders after the component mounts on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const itemsRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);

  // GSAP stagger fires every time the drawer opens — the items
  // are already visible in the DOM thanks to the CSS-driven panel
  // slide, so this is purely a polish layer (slight upward
  // translate + opacity fade with a small per-row delay). Reset
  // back to "hidden" baseline on close so the next open replays
  // the entrance cleanly.
  useEffect(() => {
    if (!mounted) return;
    const rows = itemsRef.current?.querySelectorAll<HTMLElement>(
      "[data-portal-drawer-item]",
    );
    const cta = ctaRef.current;
    if (open) {
      if (rows && rows.length > 0) {
        gsap.fromTo(
          rows,
          { y: 20, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.4,
            stagger: 0.05,
            ease: "power3.out",
            delay: 0.15,
          },
        );
      }
      if (cta) {
        gsap.fromTo(
          cta,
          { y: 12, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.35,
            ease: "power3.out",
            delay: 0.35,
          },
        );
      }
    } else {
      // Re-arm the baseline so the next open animation starts
      // from the entrance state rather than the live one.
      if (rows && rows.length > 0) gsap.set(rows, { y: 20, opacity: 0 });
      if (cta) gsap.set(cta, { y: 12, opacity: 0 });
    }
  }, [open, mounted, items.length]);

  // Esc-to-close + body scroll lock while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await portalLogout();
    } catch {
      // Best-effort: even if the server logout fails, the FE drops
      // the customer back at the login page where they can retry.
    } finally {
      setSigningOut(false);
      setOpen(false);
      router.push("/portal/login");
      router.refresh();
    }
  }

  // Overlay rendered into document.body so it sits outside the
  // PortalShell header's ``backdrop-blur`` containing block.
  const overlay = (
    <>
      <div
        aria-hidden={!open}
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px] transition-opacity duration-300 sm:hidden ${
          open
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
      />
      <aside
        aria-hidden={!open}
        aria-modal="true"
        role="dialog"
        className={`fixed inset-y-0 right-0 z-[70] flex w-[min(86vw,360px)] max-w-[360px] flex-col border-l-2 border-black bg-paper shadow-[-6px_0_0_#000] transition-transform duration-300 ease-out sm:hidden ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header strip — title + close button */}
        <header className="flex items-center justify-between border-b-2 border-black px-5 py-4">
          <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-700">
            Menu
          </span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="inline-flex h-9 w-9 items-center justify-center border-2 border-black bg-white text-black shadow-[3px_3px_0_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[2px_2px_0_#000]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Nav items — block letters, big tap targets. The GSAP
            effect above targets ``[data-portal-drawer-item]`` for
            the staggered entrance. */}
        <div
          ref={itemsRef}
          className="flex flex-1 flex-col gap-2 overflow-y-auto p-5"
        >
          {items.map((item) => {
            const isActive = active === item.key;
            return (
              <a
                key={item.key}
                href={item.href}
                data-portal-drawer-item
                onClick={() => setOpen(false)}
                className={`flex items-center justify-between border-2 border-black px-4 py-3 text-base font-black uppercase tracking-[0.06em] shadow-[4px_4px_0_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[3px_3px_0_#000] ${
                  isActive ? "bg-black text-white" : "bg-white text-black"
                }`}
              >
                <span className="truncate">{item.label}</span>
                <span aria-hidden="true" className="text-xs opacity-60">
                  →
                </span>
              </a>
            );
          })}
        </div>

        {/* Sign-out CTA — pinned to the bottom so it remains
            reachable on a long menu. */}
        <div ref={ctaRef} className="border-t-2 border-black p-5">
          <button
            type="button"
            onClick={onSignOut}
            disabled={signingOut}
            className="inline-flex w-full items-center justify-center gap-2 border-2 border-black bg-black px-4 py-3 text-sm font-black uppercase tracking-widest text-white shadow-[4px_4px_0_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[3px_3px_0_#000] disabled:opacity-60"
          >
            <LogOut className="h-4 w-4" />
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </aside>
    </>
  );

  return (
    <>
      {/* Hamburger trigger — only visible below sm because the
          desktop nav has its own inline row. Stays where it sits
          in the header (no portal). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="inline-flex h-10 w-10 items-center justify-center border-2 border-black bg-white text-black shadow-[3px_3px_0_#000] transition-transform active:translate-x-[1px] active:translate-y-[1px] active:shadow-[2px_2px_0_#000] sm:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      {mounted ? createPortal(overlay, document.body) : null}
    </>
  );
}
