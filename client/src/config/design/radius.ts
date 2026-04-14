/**
 * Border-radius scale — deliberately tiny.
 *
 * Brutalist UI is built on sharp corners. The default everywhere is ``none``.
 * Only use a non-zero value when the component is unambiguously decorative
 * (pills, avatars, icon badges). If you find yourself reaching for ``lg``
 * on a card or button, stop — that is not the brief.
 */

export const radius = {
  none: "0",
  xs: "0.0625rem",
  sm: "0.125rem",
  pill: "9999px",
  full: "9999px",
} as const;

export type RadiusToken = keyof typeof radius;
