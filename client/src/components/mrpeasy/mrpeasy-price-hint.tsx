"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { useMrpeasyPrice } from "@/services/mrpeasy";
import { useOrganization } from "@/services/organizations";

/**
 * MRPEasy suggested-price hint.
 *
 * Renders next to a unit-price input field on:
 *   * the director's spec-approval modal,
 *   * the org-wide proposal create modal,
 *   * the /signed page's spec-to-proposal modal,
 *   * the proposal-detail per-line price column.
 *
 * Three terminal states:
 *
 * * **Match** — shows ``MRPEasy: <currency> <selling_price>`` with
 *   a small "Use" button that copies the value into the host
 *   surface's price input via the ``onAutofill`` callback.
 * * **No match** — shows ``No MRPEasy match for <code>`` so the
 *   operator can tell the integration tried but the project code
 *   isn't on the MRPEasy side. Honest signal beats a silent hide.
 * * **Off** — render nothing. The org doesn't have MRPEasy live,
 *   surfacing the chip would just generate cargo-cult support
 *   questions.
 *
 * Loading is intentionally chip-shaped (not a spinner) so the
 * field doesn't bounce when the lookup resolves — matches the
 * "no MRPEasy match" footprint.
 */
export function MrpeasyPriceHint({
  orgId,
  code,
  currency = "GBP",
  onAutofill,
  className = "",
}: {
  readonly orgId: string;
  /** Project / product code to look up. Empty string disables
   *  the query so we don't lookup an empty key during early
   *  modal state. */
  readonly code: string;
  /** ISO 4217 currency code shown in the chip. The MRPEasy item
   *  doesn't carry its own currency in the lookup response —
   *  the proposal / spec surface decides. */
  readonly currency?: string;
  /** Called with the price string (decimal, e.g. ``"14.99"``)
   *  when the operator clicks "Use". The host surface decides
   *  which field gets the value (unit_price on a proposal line,
   *  the price input on a spec approval modal, etc.). */
  readonly onAutofill?: (price: string) => void;
  readonly className?: string;
}) {
  const tProposals = useTranslations("proposals");
  const organization = useOrganization(orgId);
  const live = Boolean(organization?.mrpeasy_live);

  const cleanedCode = code.trim();
  const query = useMrpeasyPrice(orgId, cleanedCode, {
    enabled: live && Boolean(cleanedCode),
  });

  // Render gate: nothing to show when the integration isn't
  // live, or no code yet to look up. Caller owns the layout
  // around us so an empty render leaves no orphan whitespace.
  if (!live || !cleanedCode) return null;

  if (query.isLoading) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700 ring-1 ring-inset ring-blue-200 ${className}`}
        role="status"
      >
        <Sparkles className="h-3 w-3 animate-pulse" />
        <span>{tProposals("mrpeasy_hint.loading")}</span>
      </div>
    );
  }

  if (query.isError || !query.data) {
    // Network or other transport failure — the backend already
    // silent-degrades to ``matched: false`` for predictable error
    // paths, so we only get here on a genuine HTTP layer issue
    // (e.g. server unreachable). Stay quiet rather than alarm.
    return null;
  }

  if (!query.data.matched) {
    return (
      <div
        className={`inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200 ${className}`}
      >
        <Sparkles className="h-3 w-3" />
        <span>
          {tProposals("mrpeasy_hint.no_match", { code: cleanedCode })}
        </span>
      </div>
    );
  }

  const price = query.data.selling_price;
  const upper = (currency || "GBP").toUpperCase();
  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-900 ring-1 ring-inset ring-blue-200 ${className}`}
    >
      <Sparkles className="h-3 w-3 text-blue-700" />
      <span className="tabular-nums">
        {tProposals("mrpeasy_hint.suggested", {
          currency: upper,
          price,
        })}
      </span>
      {onAutofill ? (
        <button
          type="button"
          onClick={() => onAutofill(price)}
          className="rounded bg-blue-700 px-1.5 py-0.5 text-[10px] font-semibold text-blue-50 hover:bg-blue-800"
        >
          {tProposals("mrpeasy_hint.use")}
        </button>
      ) : null}
    </div>
  );
}
