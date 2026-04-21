"use client";

/**
 * Sentinel row that triggers ``onVisible`` as soon as it scrolls
 * into the viewport. Swaps out the manual "Load older comments"
 * button for chat-style infinite scroll.
 *
 * Falls back to a plain clickable button when
 * ``IntersectionObserver`` is unavailable (very old browsers,
 * SSR snapshots) so the list stays reachable either way.
 */

import { useEffect, useRef } from "react";


interface Props {
  /** Fires once every time the sentinel crosses into the viewport.
   *  The caller is responsible for in-flight de-duplication — we
   *  don't debounce here because the observer already only fires
   *  on visibility change, not continuously. */
  readonly onVisible: () => void;
  /** Text rendered in the sentinel row so the user has a visible
   *  cue that more content is loading. */
  readonly label: string;
}


export function InfiniteLoader({ onVisible, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Latest callback reference — keeps the observer clean when the
  // parent re-renders with a fresh closure.
  const cbRef = useRef(onVisible);
  cbRef.current = onVisible;

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            cbRef.current();
          }
        }
      },
      // ``rootMargin`` gives us a 200 px head-start so the next page
      // is already loading before the user hits the end of the list.
      { rootMargin: "200px 0px", threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className="flex items-center justify-center py-3 text-xs text-ink-500"
    >
      <button
        type="button"
        className="inline-flex items-center gap-2 rounded-md px-2 py-1 hover:bg-ink-50"
        onClick={() => cbRef.current()}
      >
        {label}
      </button>
    </div>
  );
}
