/**
 * Brand palette — brutalist monochrome with a single accent.
 *
 * The aesthetic is deliberate: ink-black surfaces, paper-white type, a
 * narrow grey ramp for dividers and disabled states, and exactly one loud
 * accent reserved for primary calls to action. Every additional colour is a
 * decision that has to justify itself; do not add new tones casually.
 */

export const ink = {
  0: "#ffffff",
  50: "#fafafa",
  100: "#f4f4f4",
  200: "#e6e6e6",
  300: "#cccccc",
  400: "#999999",
  500: "#666666",
  600: "#404040",
  700: "#262626",
  800: "#161616",
  900: "#0a0a0a",
  1000: "#000000",
} as const;

/** Single accent — reserved for primary CTAs and critical highlights only. */
export const accent = {
  50: "#f5fbe6",
  100: "#e9f7c7",
  200: "#d4ef8e",
  300: "#bce653",
  400: "#a8d65a",
  500: "#8fbf3f",
  600: "#6e9a2d",
  700: "#557524",
  800: "#3f571b",
  900: "#2a3a12",
} as const;

/**
 * Semantic tones stay muted and industrial — no candy colours. Used sparingly
 * for form validation, status banners, and inline alerts.
 */
export const semantic = {
  success: "#4a7a2f",
  warning: "#b8860b",
  danger: "#b91c1c",
  info: "#1e3a5f",
} as const;

export const colors = {
  ink,
  accent,
  semantic,
} as const;

export type InkShade = keyof typeof ink;
export type AccentShade = keyof typeof accent;
export type SemanticTone = keyof typeof semantic;
