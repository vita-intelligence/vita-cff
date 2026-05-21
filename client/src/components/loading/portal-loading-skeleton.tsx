/**
 * Portal-side loading state — modern brutalist.
 *
 * Three stacked elements that read together as one design rather
 * than a "spinner sitting on a page":
 *
 *   1. **Marquee strip** — full-bleed black band with an
 *      infinitely-scrolling uppercase "LOADING" wordmark in the
 *      portal's display sans. The text is duplicated end-to-end
 *      and the strip translates by exactly ``-50%`` of its width;
 *      the second copy slides into the first's place for a
 *      seamless loop. Linear easing → mechanical, never sappy.
 *
 *   2. **Scan bar** — hard 2px-bordered rail with a black block
 *      sliding through it at a slightly different cadence to the
 *      marquee. Cubic easing on the inner block is the only
 *      "weight" cue.
 *
 *   3. **Mono caption** — small JetBrains-mono caption with tight
 *      tracking and a thin separator. Optional contextual label
 *      sits above the rail so the operator knows what's loading
 *      without reading the brand line.
 *
 * No spinning orbs, no soft gradients, no rounded corners. The
 * page background is the same warm paper the rest of the portal
 * uses so the loader feels like *the* portal pausing, not a
 * separate generic loading screen.
 *
 * Pure SSR / no hooks — safe to drop directly into a portal
 * ``loading.tsx`` route segment.
 */

export interface PortalLoadingSkeletonProps {
  /** Optional contextual label rendered above the scan rail.
   *  Example: "Loading proposal". Falls back to "Loading" so the
   *  slot stays balanced when the caller doesn't supply one. */
  readonly label?: string;
}


// Duplicating the marquee content keeps the loop seamless — the
// strip animates from 0 to -50% so the second copy ends where the
// first started. We render 12 chunks total (6 per copy) which
// gives roughly the right ink density across breakpoints from
// phone to 4K monitor.
const MARQUEE_CHUNK_COUNT = 6;


export function PortalLoadingSkeleton({
  label = "Loading",
}: PortalLoadingSkeletonProps) {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label={label}
      className="min-h-dvh bg-paper text-black antialiased flex flex-col items-stretch justify-center overflow-hidden"
    >
      {/* ── Marquee strip — the loud anchor element ─────────── */}
      <div
        aria-hidden
        className="w-full overflow-hidden border-y-2 border-black bg-black"
      >
        <div className="inline-flex whitespace-nowrap py-5 sm:py-6 will-change-transform [animation:brutalist-marquee_18s_linear_infinite]">
          {[0, 1].map((segment) => (
            <span
              key={segment}
              className="inline-flex shrink-0 items-center"
            >
              {Array.from({ length: MARQUEE_CHUNK_COUNT }).map((_, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-8 px-8"
                >
                  <span className="font-sans font-black uppercase text-white text-5xl sm:text-7xl md:text-8xl tracking-[-0.04em] leading-none">
                    Loading
                  </span>
                  {/* Spacer block — a tiny white square between
                      each word. Brutalist comma. */}
                  <span className="h-3 w-3 shrink-0 bg-white" />
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      {/* ── Scan bar + caption ─────────────────────────────── */}
      <div className="mx-auto mt-14 flex w-full max-w-2xl flex-col items-center gap-6 px-6">
        <span className="font-mono text-[11px] uppercase tracking-[0.32em] text-black/70">
          {label}
        </span>

        {/* The scanner. ``rounded`` is intentionally absent — the
            rail is a sharp rectangle in the portal's brutalist
            shape vocabulary. */}
        <div
          aria-hidden
          className="relative h-2 w-full max-w-md overflow-hidden border-2 border-black bg-paper"
        >
          <span className="absolute inset-y-0 left-0 w-1/3 bg-black will-change-transform [animation:brutalist-scan_1.8s_cubic-bezier(0.65,0,0.35,1)_infinite]" />
        </div>

        {/* Brand caption. Mono + heavy tracking + a single thin
            separator. Reads like the deck of a magazine page —
            small, intentional, brand-coherent. */}
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.32em] text-black/50">
          <span>Vita NPD</span>
          <span aria-hidden className="h-px w-8 bg-black/30" />
          <span>Customer Portal</span>
        </div>
      </div>
    </main>
  );
}
