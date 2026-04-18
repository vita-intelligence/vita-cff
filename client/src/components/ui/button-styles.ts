/**
 * Canonical button class-strings.
 *
 * Shared across HeroUI ``<Button>`` overrides and plain
 * ``<button>``/``<a>`` elements so every call-site lands on the
 * same modern orange / ink treatment. Keep this small — only the
 * three tones and two sizes the app actually uses.
 */

export type ButtonTone = "primary" | "outline" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";


/** Base class — layout + state, no color. */
const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";


const TONE: Record<ButtonTone, string> = {
  primary: "bg-orange-500 text-ink-0 hover:bg-orange-600 active:bg-orange-700",
  outline:
    "bg-ink-0 text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50",
  danger:
    "bg-danger/10 text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger/15",
  ghost: "text-ink-700 hover:bg-ink-50",
};


const SIZE: Record<ButtonSize, string> = {
  // ``sm`` is the default action button used inside toolbars and
  // card headers; 40 px target height satisfies both fingers and
  // keyboards without feeling heavy.
  sm: "h-10 px-3 text-sm",
  md: "h-11 px-4 text-sm",
};


export function buttonClass(
  tone: ButtonTone = "primary",
  size: ButtonSize = "sm",
  extra = "",
): string {
  return `${BASE} ${SIZE[size]} ${TONE[tone]} ${extra}`.trim();
}
