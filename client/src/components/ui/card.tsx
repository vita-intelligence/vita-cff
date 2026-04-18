import type { ReactNode } from "react";


export type CardTone = "default" | "emphasis" | "accent" | "surface";


/**
 * Neutral-shell container used across the app for grouped content.
 *
 * The ``default`` tone paints a white card with a soft ink-200 ring
 * and a ``shadow-sm`` lift — the same treatment the project
 * workspace uses. ``emphasis`` inverts to a dark ink block for
 * terminal totals. ``accent`` is for orange-washed surfaces (warm
 * hints, pilot-stage callouts). ``surface`` is for inline groupings
 * that sit on top of another card without stacking shadows.
 */
export function Card({
  tone = "default",
  as: Tag = "div",
  className = "",
  children,
}: {
  tone?: CardTone;
  as?: keyof React.JSX.IntrinsicElements;
  className?: string;
  children: ReactNode;
}) {
  const tones: Record<CardTone, string> = {
    default: "bg-ink-0 shadow-sm ring-1 ring-ink-200",
    emphasis: "bg-ink-1000 text-ink-0",
    accent: "bg-orange-50 ring-1 ring-inset ring-orange-200",
    surface: "bg-ink-50 ring-1 ring-inset ring-ink-200",
  };
  return (
    <Tag className={`rounded-2xl ${tones[tone]} ${className}`}>{children}</Tag>
  );
}
