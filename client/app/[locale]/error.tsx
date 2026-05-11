"use client";

import { useEffect } from "react";

/**
 * Error boundary for everything under ``/[locale]``.
 *
 * Catches throws from Server Components -- in particular the
 * ``BackendUnavailableError`` raised by ``serverFetch`` when the
 * backend returns 5xx or is unreachable. Without this boundary the
 * old code path returned ``null`` from ``getCurrentUserServer`` and
 * the page guard interpreted that as "user is logged out", bouncing
 * the scientist to ``/login`` mid-task whenever the DB pool was
 * temporarily exhausted.
 *
 * The reset button calls Next's ``reset()`` to re-run the failed
 * segment without dropping the user's place in the URL, which is
 * what scientists kept losing: their formulation/spec page.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side error boundaries already feed the digest into the
    // platform logs; this `console.error` adds the message for client
    // visibility (browser devtools) without exposing a digest to the
    // page UI.
    console.error("Page error:", error);
  }, [error]);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-6 text-ink-1000">
      <div className="w-full max-w-md rounded-2xl bg-ink-0 p-8 shadow-sm ring-1 ring-ink-200">
        <h1 className="text-lg font-semibold">Service interrupted</h1>
        <p className="mt-2 text-sm text-ink-700">
          The backend didn&apos;t answer this request. Your session is
          still valid &mdash; click retry to load the page again.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-ink-0 hover:bg-orange-600"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => {
              if (typeof window !== "undefined") {
                window.location.reload();
              }
            }}
            className="rounded-lg bg-ink-0 px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            Reload page
          </button>
        </div>
        {error.digest ? (
          <p className="mt-4 text-[10px] text-ink-500">
            Ref: {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
