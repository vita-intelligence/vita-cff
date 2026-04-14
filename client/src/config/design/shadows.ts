/**
 * Shadows — hard, offset, monochrome.
 *
 * Soft blurred drop shadows are forbidden. When the brief calls for depth,
 * we use a hard black offset (``2px 2px 0 #000``) that looks like a print
 * registration error. Most of the UI uses ``none`` — a border does the job.
 */

export const shadow = {
  none: "none",
  /** Hard 2px offset, no blur — the signature brutalist elevation. */
  hard: "2px 2px 0 0 #000000",
  /** Bigger offset for hover or pressed states on primary CTAs. */
  harder: "4px 4px 0 0 #000000",
  /** Inset hairline — used for pressed/active states. */
  inset: "inset 0 0 0 1px #000000",
} as const;

export type ShadowToken = keyof typeof shadow;
