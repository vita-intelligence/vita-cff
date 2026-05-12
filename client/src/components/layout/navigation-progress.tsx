"use client";

/**
 * Click-time navigation progress bar.
 *
 * Next.js' ``loading.tsx`` fallback only renders once a route's
 * server component begins streaming. There's a perceptible gap
 * between the click on a ``<Link>`` and that first stream chunk --
 * during which the page sits idle and the user thinks the click was
 * lost. This component closes that gap by:
 *
 * 1. Capturing every internal link click at the document level and
 *    flipping a ``pending`` flag the same tick the user clicks.
 * 2. Painting a 2px gradient bar across the top of the viewport
 *    that animates from 0 to ~85% during the pending window so the
 *    user sees immediate "yes, something is happening" feedback.
 * 3. Watching ``usePathname`` to detect the destination route taking
 *    over, then running the bar to 100% and fading it out.
 *
 * No external dependencies, no router-level monkey-patching -- the
 * click listener is purely additive and ignores meta/ctrl/shift
 * clicks (new-tab / new-window), download links, and anchors that
 * point at external origins or fragment-only hashes.
 */

import { usePathname } from "@/i18n/navigation";
import { useEffect, useState } from "react";

type Phase = "idle" | "starting" | "running" | "finishing";

export function NavigationProgress() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingPath, setPendingPath] = useState<string | null>(null);

  // Document-level click capture. Listening at the document level
  // means we don't have to wrap every ``<Link>`` in the codebase --
  // any anchor whose href stays inside this origin trips the bar.
  useEffect(() => {
    function handleClick(event: MouseEvent) {
      // Modifier keys = "open in new tab" / "save link as" etc. The
      // current page isn't going anywhere, so skip the bar.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      if (!href) return;
      // External links, downloads, mail/tel, and pure hash jumps
      // don't trigger an SSR navigation.
      if (
        href.startsWith("http://") ||
        href.startsWith("https://") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("#") ||
        anchor.hasAttribute("download") ||
        anchor.getAttribute("target") === "_blank"
      ) {
        return;
      }
      // Same-pathname click (e.g. tab pointing at the current page)
      // -- the route segment won't change so the loader never fires
      // and the bar would hang.
      try {
        const next = new URL(href, window.location.href);
        if (
          next.origin === window.location.origin &&
          next.pathname === window.location.pathname
        ) {
          return;
        }
        setPendingPath(next.pathname);
      } catch {
        // Bad URL; let the browser handle it natively without a bar.
        return;
      }
      setPhase("starting");
    }

    document.addEventListener("click", handleClick, { capture: true });
    return () =>
      document.removeEventListener("click", handleClick, { capture: true });
  }, []);

  // Two-step animation: ``starting`` paints the bar at width 0 so the
  // following render's transition to ``running`` (~85%) animates
  // smoothly. Without the brief intermediate frame the browser
  // collapses the start + end into a single instant repaint.
  useEffect(() => {
    if (phase !== "starting") return;
    const frame = requestAnimationFrame(() => setPhase("running"));
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  // When the pathname matches whatever the click was aiming at, slide
  // the bar to 100% and fade it out. The fade timing lines up with
  // ``loading.tsx`` so the bar disappears as the destination's first
  // paint settles in.
  useEffect(() => {
    if (phase === "idle" || pendingPath === null) return;
    if (pathname === pendingPath) {
      setPhase("finishing");
      const timer = window.setTimeout(() => {
        setPhase("idle");
        setPendingPath(null);
      }, 250);
      return () => window.clearTimeout(timer);
    }
  }, [pathname, pendingPath, phase]);

  if (phase === "idle") return null;

  const width =
    phase === "starting" ? "0%" : phase === "running" ? "85%" : "100%";
  const opacity = phase === "finishing" ? "0" : "1";

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[2px]"
    >
      <div
        className="h-full bg-gradient-to-r from-orange-400 via-orange-500 to-orange-400 shadow-[0_0_8px_rgba(249,115,22,0.55)]"
        style={{
          width,
          opacity,
          transition:
            phase === "running"
              ? "width 8s cubic-bezier(0.1, 0.7, 0.2, 1)"
              : phase === "finishing"
                ? "width 180ms ease-out, opacity 240ms ease-out 80ms"
                : "none",
        }}
      />
    </div>
  );
}
