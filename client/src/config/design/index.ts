/**
 * Design system — single source of truth.
 *
 * Every design token the app uses is re-exported from this file. Consumers
 * import from ``@/config/design`` — never from a nested path — so refactors
 * stay contained.
 */

import { animations } from "./animations";
import { breakpoints, containerMaxWidth } from "./breakpoints";
import { colors } from "./colors";
import { radius } from "./radius";
import { shadow } from "./shadows";
import { spacing } from "./spacing";
import { typography } from "./typography";

export { animations } from "./animations";
export { breakpoints, containerMaxWidth } from "./breakpoints";
export { accent, colors, ink, orange, semantic } from "./colors";
export { radius } from "./radius";
export { shadow } from "./shadows";
export { spacing } from "./spacing";
export {
  fontFamily,
  fontSize,
  fontWeight,
  letterSpacing,
  lineHeight,
  typography,
} from "./typography";

export type {
  AccentShade,
  InkShade,
  OrangeShade,
  SemanticTone,
} from "./colors";
export type {
  FontFamilyToken,
  FontSizeToken,
  FontWeightToken,
} from "./typography";
export type { SpacingToken } from "./spacing";
export type { RadiusToken } from "./radius";
export type { ShadowToken } from "./shadows";
export type { BreakpointToken } from "./breakpoints";
export type { DurationToken, EasingToken } from "./animations";

/**
 * Frozen snapshot of every token, useful when you need to pass the entire
 * design system to a theme builder (e.g. HeroUI's ``heroui()`` plugin).
 */
export const designSystem = {
  colors,
  typography,
  spacing,
  radius,
  shadow,
  breakpoints,
  containerMaxWidth,
  animations,
} as const;

export type DesignSystem = typeof designSystem;
