"use client";

import { ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";

import { buildMrpeasyItemUrl, useMrpeasyPrice } from "@/services/mrpeasy";
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
 * Internally the component fires the same MRPEasy lookup the
 * price hint uses (``useMrpeasyPrice``). TanStack Query dedupes
 * by ``(orgId, code)`` so when both components mount together
 * (e.g. inside the director's signature dialog) there's a single
 * shared round-trip. The lookup resolves the row's
 * ``product_id`` which lets us deep-link straight into MRPEasy's
 * ``/articles/view/<id>`` page; until it resolves (or if MRPEasy
 * returns no match) we fall back to the code-filter URL so the
 * operator always lands on the right tenant view.
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

  // Gate the lookup on the same conditions as the chip: org
  // integration live AND a non-empty code. Otherwise the query
  // never fires and we either bail (no link) or render the
  // search-fallback URL with the code we already have.
  const trimmedCode = (code ?? "").trim();
  const priceQuery = useMrpeasyPrice(orgId, trimmedCode, {
    enabled: live && trimmedCode.length > 0,
  });
  const productId =
    priceQuery.data?.matched === true ? priceQuery.data.product_id : null;

  const href = buildMrpeasyItemUrl({ code: trimmedCode, productId });
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
