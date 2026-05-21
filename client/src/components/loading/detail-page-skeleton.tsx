/**
 * Standard "you're navigating to a detail page" loading skeleton.
 *
 * Drop into any ``loading.tsx`` that should fire while a detail
 * route is server-rendering. Sits at the same layout depth as the
 * destination page so the parent layouts (header chrome,
 * navigation) stay visible — the operator sees a coherent
 * "the page is on its way" state rather than a blank frame.
 *
 * Visual shape:
 *
 *   * A centered orange pulsing orb — matches the brand cue the
 *     global :file:`[locale]/loading.tsx` uses so the two loaders
 *     read as one design language.
 *   * Three shimmering content rows below the orb so the operator
 *     understands the skeleton represents page content, not an
 *     error screen.
 *
 * Pure SSR / no hooks — this file is fine to use directly from a
 * ``loading.tsx`` segment file.
 */

export interface DetailPageSkeletonProps {
  /** Short label rendered under the orb. Example: "Loading
   *  project". Falls back to a generic "Loading" so the
   *  component is drop-in safe without a caller-supplied
   *  string. */
  readonly label?: string;
}


export function DetailPageSkeleton({
  label = "Loading",
}: DetailPageSkeletonProps) {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label={label}
      className="min-h-dvh bg-ink-0 text-ink-1000"
    >
      <div className="mx-auto flex min-h-dvh max-w-7xl flex-col items-center justify-center gap-8 px-4 py-12 sm:px-6 md:px-10">
        {/* Orange pulsing orb — matches the global loader so a
            transition from the orb-only screen to here feels
            continuous. */}
        <div className="relative flex items-center justify-center">
          <span
            aria-hidden
            className="absolute h-20 w-20 animate-ping rounded-full bg-orange-400/30"
          />
          <span
            aria-hidden
            className="absolute h-14 w-14 animate-pulse rounded-full bg-orange-400/50"
          />
          <span
            aria-hidden
            className="relative h-10 w-10 rounded-full bg-orange-500 shadow-lg shadow-orange-500/30"
          />
        </div>

        <span className="text-xs uppercase tracking-[0.2em] text-ink-500">
          {label}
        </span>

        {/* Skeleton rows — three soft-edged blocks at typical
            content widths. Pure CSS animation, no JS, no layout
            shift on hydration. */}
        <div className="flex w-full max-w-2xl flex-col gap-3">
          <span
            aria-hidden
            className="h-6 w-1/2 animate-pulse rounded-md bg-ink-100"
          />
          <span
            aria-hidden
            className="h-4 w-3/4 animate-pulse rounded-md bg-ink-100"
          />
          <span
            aria-hidden
            className="h-4 w-2/3 animate-pulse rounded-md bg-ink-100"
          />
        </div>
      </div>
    </main>
  );
}
