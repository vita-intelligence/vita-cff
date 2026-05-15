"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { buildMrpeasyItemUrl } from "@/services/mrpeasy";
import { useOrganization } from "@/services/organizations";

/**
 * Small "Open in MRPEasy" affordance.
 *
 * Renders nothing when the org doesn't have MRPEasy live or the
 * passed ``code`` is blank — so a host surface can drop this in
 * unconditionally and the component takes care of the visibility
 * gate. Mirrors the contract of :component:`MrpeasyPriceHint`.
 *
 * The link opens a new tab (``target="_blank"`` +
 * ``rel="noopener noreferrer"``) so the operator never loses the
 * Vita context they were in when they clicked.
 *
 * ``variant`` lets the host pick between a compact icon-only chip
 * (good for tight headers next to a project code) and a fuller
 * labelled pill (good for forms with breathing room).
 */
export function MrpeasyItemLink({
  orgId,
  code,
  variant = "labelled",
  className = "",
}: {
  readonly orgId: string;
  readonly code: string | null | undefined;
  readonly variant?: "labelled" | "compact";
  readonly className?: string;
}) {
  const t = useTranslations("mrpeasy");
  const organization = useOrganization(orgId);
  const live = Boolean(organization?.mrpeasy_live);

  const href = buildMrpeasyItemUrl(code);
  if (!live || !href) return null;

  const label = t("open_in_mrpeasy");
  const baseClasses =
    "inline-flex items-center gap-1.5 rounded-full bg-blue-50 text-blue-800 ring-1 ring-inset ring-blue-200 transition-colors hover:bg-blue-100";
  const sizeClasses =
    variant === "compact"
      ? "px-2 py-0.5 text-[10px] font-medium"
      : "px-2.5 py-1 text-xs font-medium";

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className={`${baseClasses} ${sizeClasses} ${className}`.trim()}
    >
      <ExternalLink className="h-3 w-3" />
      {variant === "compact" ? null : <span>{label}</span>}
    </a>
  );
}
