/**
 * Builders for deep-link URLs into the MRPEasy admin UI.
 *
 * Kept in a dedicated module rather than inlined in components so
 * the URL shape lives in exactly one place — if MRPEasy ever
 * changes their routing, updating the helper updates every link
 * in the app.
 *
 * Preferred pattern is the direct-view URL keyed on MRPEasy's
 * internal numeric ``product_id`` (``/articles/view/<id>``) —
 * confirmed against the real tenant. We resolve the ``product_id``
 * by piggy-backing on the price-lookup endpoint the price-hint
 * surface already uses, so the deep-link doesn't fire a new
 * round-trip when both components mount together.
 *
 * Fallback pattern (when ``product_id`` is missing — typically
 * MRPEasy didn't return the row, or the page rendered before the
 * lookup query resolved) is the articles-list URL with a code
 * filter (``/articles?code=<sku>``). MRPEasy renders the list
 * pre-filtered to the single matching row.
 */

const MRPEASY_BASE_URL = "https://app.mrpeasy.com";

export function buildMrpeasyItemUrl(args: {
  readonly code: string | null | undefined;
  readonly productId: number | null | undefined;
}): string | null {
  const trimmed = (args.code ?? "").trim();
  // ``product_id`` alone is enough — the URL doesn't carry the
  // code. But without either of them we can't link anywhere
  // useful, so bail.
  if (!trimmed && !args.productId) return null;
  if (args.productId) {
    return `${MRPEASY_BASE_URL}/articles/view/${args.productId}`;
  }
  return `${MRPEASY_BASE_URL}/articles?code=${encodeURIComponent(trimmed)}`;
}
