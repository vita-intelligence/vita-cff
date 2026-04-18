import type { ReactNode } from "react";


export type ChipTone =
  | "neutral"
  | "orange"
  | "success"
  | "danger"
  | "info"
  | "warning";

export type ChipSize = "sm" | "md";


/**
 * Small rounded status/label pill.
 *
 * The semantic tones — success / danger / warning / info — draw from
 * the design tokens in :mod:`@/config/design/colors` so every
 * in-app chip renders against a 10 %-opacity fill with a matching
 * 20 %-opacity ring. Neutral and orange pick up the ink and brand
 * accents respectively.
 *
 * Used across status cells, stage pills, pass/fail tags and the
 * header nav active-link indicator.
 */
export function Chip({
  tone = "neutral",
  size = "sm",
  icon,
  children,
  className = "",
}: {
  tone?: ChipTone;
  size?: ChipSize;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const tones: Record<ChipTone, string> = {
    neutral: "bg-ink-100 text-ink-700 ring-ink-200",
    orange: "bg-orange-50 text-orange-700 ring-orange-200",
    success: "bg-success/10 text-success ring-success/20",
    danger: "bg-danger/10 text-danger ring-danger/20",
    info: "bg-info/10 text-info ring-info/20",
    warning: "bg-warning/10 text-warning ring-warning/20",
  };
  const sizes: Record<ChipSize, string> = {
    sm: "gap-1 px-2 py-0.5 text-xs",
    md: "gap-1.5 px-3 py-1 text-xs",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ring-1 ring-inset ${sizes[size]} ${tones[tone]} ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}
