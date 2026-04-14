/**
 * Typography tokens — heavy, industrial, uppercase-friendly.
 *
 * The brutalist look leans on weight and tracking, not decoration. Display
 * text is almost always bold or black, often uppercase, with tight leading.
 * Body text stays dense and utilitarian.
 *
 * Font families listed here are CSS font-family stacks. The actual webfont
 * loading happens in ``app/[locale]/layout.tsx`` via ``next/font``.
 */

export const fontFamily = {
  /** Primary UI font — set here as a stack, wired to next/font in layout. */
  sans: ["Archivo", "Inter", "system-ui", "-apple-system", "sans-serif"],
  /** Display font for oversized headings; can be the same family in a heavier weight. */
  display: ["Archivo", "Inter", "system-ui", "sans-serif"],
  /** Monospace — used for ingredient codes, spec sheets, numeric data. */
  mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
} as const;

export const fontSize = {
  xs: "0.75rem",
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.25rem",
  "2xl": "1.5rem",
  "3xl": "1.875rem",
  "4xl": "2.25rem",
  "5xl": "3rem",
  "6xl": "3.75rem",
  "7xl": "4.5rem",
  "8xl": "6rem",
} as const;

export const lineHeight = {
  /** Display headings run tight. */
  tight: "1.0",
  snug: "1.1",
  normal: "1.4",
  relaxed: "1.6",
} as const;

export const letterSpacing = {
  tighter: "-0.03em",
  tight: "-0.015em",
  normal: "0",
  /** Uppercase display text should always pair with ``wide`` or ``wider``. */
  wide: "0.05em",
  wider: "0.1em",
  widest: "0.2em",
} as const;

export const typography = {
  fontFamily,
  fontWeight,
  fontSize,
  lineHeight,
  letterSpacing,
} as const;

export type FontFamilyToken = keyof typeof fontFamily;
export type FontSizeToken = keyof typeof fontSize;
export type FontWeightToken = keyof typeof fontWeight;
