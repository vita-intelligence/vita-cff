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

/** Primary accent — reserved for CTAs and critical highlights. Olive /
 * lime; pairs well with monochrome ink surfaces without feeling
 * sugary. */
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

/** Warm-side companion to :const:`accent`. Orange range — used for
 * in-progress / pilot / "this is in motion" status signals and
 * occasional CTA variants where a warmer call-to-action is wanted
 * over the earthy lime. Not for destructive intent — that's
 * :const:`semantic.danger`. */
export const orange = {
  50: "#fff4ea",
  100: "#ffe4cd",
  200: "#ffc796",
  300: "#ffa65e",
  400: "#ff8a33",
  500: "#f36e12",
  600: "#d4570a",
  700: "#a84309",
  800: "#7c330a",
  900: "#5a240a",
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
  orange,
  semantic,
} as const;

export type InkShade = keyof typeof ink;
export type AccentShade = keyof typeof accent;
export type OrangeShade = keyof typeof orange;
export type SemanticTone = keyof typeof semantic;
