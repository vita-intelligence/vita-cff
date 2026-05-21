"use client";

/**
 * Pending-state spinner primitives that read :func:`useLinkStatus`
 * from ``next/link``.
 *
 * Drop these inside a ``<Link>`` (or the next-intl wrapper) to get
 * an inline cue that the click registered while the destination
 * server segment is still rendering. Useful for list rows whose
 * detail page does its own data-fetching and therefore takes a
 * few hundred ms to paint — without this the operator clicks,
 * stares at nothing, and clicks again.
 *
 * Two flavours:
 *
 *   * :component:`LinkPendingSpinner` — bare spinner with
 *     opacity-toggle. Always rendered to keep layout stable.
 *   * :component:`LinkIconSlot` — same opacity-toggle pattern but
 *     swaps a caller-supplied idle icon for the spinner. Use
 *     this when the link's chrome already contains an icon (an
 *     external-link glyph, a chevron, etc.) so the slot just
 *     transitions in place rather than growing the button.
 *
 * Notes:
 *
 *   * Next.js skips the pending phase entirely when the link has
 *     been prefetched and the cache is warm — that's why the cue
 *     stays invisible on quick repeat clicks. For most list rows
 *     the destination is a dynamic segment that isn't fully
 *     prefetched, so the spinner shows up reliably.
 *   * Multiple in-flight clicks: only the most recently-clicked
 *     link's pending state lights up (matches the docs' "last
 *     link wins" rule).
 */

import { Loader2 } from "lucide-react";
import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";


export interface LinkPendingSpinnerProps {
  /** Optional Tailwind class additions — useful for tinting the
   *  spinner to match the row's text colour. The base classes
   *  already cover sizing and animation. */
  readonly className?: string;
  /** Spinner icon size in Tailwind classes. Default ``h-3.5 w-3.5``
   *  matches the small "Open" chip on most list rows. */
  readonly sizeClassName?: string;
}


export function LinkPendingSpinner({
  className = "",
  sizeClassName = "h-3.5 w-3.5",
}: LinkPendingSpinnerProps) {
  const { pending } = useLinkStatus();
  return (
    <Loader2
      aria-hidden
      className={`shrink-0 animate-spin transition-opacity duration-150 ${sizeClassName} ${
        pending ? "opacity-100" : "opacity-0"
      } ${className}`}
    />
  );
}


export interface LinkIconSlotProps {
  /** What to render when the link is idle (the usual external-
   *  link / chevron / similar glyph the row already showed). The
   *  caller controls its size + colour. */
  readonly idleIcon: ReactNode;
  /** Override the spinner's size — defaults to ``h-3.5 w-3.5`` so
   *  the slot stays the same size most "Open" chips were already
   *  designed against. */
  readonly spinnerSizeClassName?: string;
}


/**
 * Renders the ``idleIcon`` until the parent ``<Link>`` enters its
 * pending state, then crossfades to a spinner in the same slot.
 * Both children are absolutely positioned inside a relatively-
 * positioned wrapper so the slot's outer width is fixed —
 * surrounding text doesn't reflow when the swap happens.
 */
export function LinkIconSlot({
  idleIcon,
  spinnerSizeClassName = "h-3.5 w-3.5",
}: LinkIconSlotProps) {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden
      className={`relative inline-flex items-center justify-center ${spinnerSizeClassName}`}
    >
      <span
        className={`absolute inset-0 inline-flex items-center justify-center transition-opacity duration-150 ${
          pending ? "opacity-0" : "opacity-100"
        }`}
      >
        {idleIcon}
      </span>
      <Loader2
        className={`absolute inset-0 m-auto animate-spin transition-opacity duration-150 ${spinnerSizeClassName} ${
          pending ? "opacity-100" : "opacity-0"
        }`}
      />
    </span>
  );
}
