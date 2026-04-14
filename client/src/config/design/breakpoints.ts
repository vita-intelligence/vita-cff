/**
 * Responsive breakpoints. Mobile-first; each value is the lower bound of
 * the range. Match Tailwind's default screen names so utility classes line
 * up with the tokens.
 */

export const breakpoints = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
  "2xl": "1536px",
} as const;

/** Maximum content width for main layouts — capped at ``2xl`` for readability. */
export const containerMaxWidth = "1536px";

export type BreakpointToken = keyof typeof breakpoints;
