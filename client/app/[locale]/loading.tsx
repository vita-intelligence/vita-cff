/**
 * Route-segment loader rendered by Next.js whenever a navigation under
 * ``app/[locale]/*`` is still server-rendering. The loader sits inside
 * the locale layout, so the wordmark stays visually consistent with
 * the rest of the protected shell while the next page's data is in
 * flight.
 *
 * No state, no client-side hooks -- this is a pure SSR placeholder.
 * Picking up new state on the way in is the new page's job.
 */
import { site } from "@/config/site";

export default function LocaleLoading() {
  return (
    <main
      role="status"
      aria-live="polite"
      aria-label={`Loading ${site.name}`}
      className="fixed inset-0 z-50 flex min-h-dvh flex-col items-center justify-center gap-6 bg-ink-0/95 backdrop-blur-sm"
    >
      {/* Subtle pulsing orb -- a single CSS animation, no JS. The
          inner disc + outer ring give the spinner a soft brand-coloured
          presence without being flashy. */}
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

      {/* Wordmark + tagline. Kept understated -- the loader is shown
          dozens of times per session, so we want it to feel like a
          breath rather than a moment. */}
      <div className="flex flex-col items-center gap-1">
        <span className="font-display text-lg font-semibold tracking-tight text-ink-1000">
          {site.name}
        </span>
        <span className="text-xs uppercase tracking-[0.2em] text-ink-500">
          Loading
        </span>
      </div>
    </main>
  );
}
