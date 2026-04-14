/**
 * Motion tokens — snappy, mechanical, no bounce.
 *
 * Brutalist motion is deliberate and short. No easing curves that feel
 * "rubbery", no spring physics, no long fade durations. Most transitions
 * run under 200ms; ``instant`` exists for cases where any delay would
 * feel sluggish.
 */

export const duration = {
  instant: 0,
  fast: 120,
  base: 180,
  slow: 240,
  slower: 320,
} as const;

/**
 * Easing curves. Keep the ramp sharp — no overshoot, no anticipation.
 * These are cubic-bezier strings ready for CSS ``transition-timing-function``
 * or GSAP / motion config.
 */
export const easing = {
  linear: "linear",
  out: "cubic-bezier(0.2, 0, 0, 1)",
  in: "cubic-bezier(0.4, 0, 1, 1)",
  inOut: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export const animations = {
  duration,
  easing,
} as const;

export type DurationToken = keyof typeof duration;
export type EasingToken = keyof typeof easing;
