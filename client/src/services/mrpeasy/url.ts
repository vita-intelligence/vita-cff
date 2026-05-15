/**
 * Builders for deep-link URLs into the MRPEasy admin UI.
 *
 * Kept in a dedicated module rather than inlined in components so
 * the URL shape lives in exactly one place — if MRPEasy ever
 * changes their routing (or we discover a more direct deep-link
 * pattern), updating the helper updates every link in the app.
 *
 * The current pattern relies on MRPEasy's items-list filter
 * (``?code=<sku>``) which renders the catalogue pre-filtered to
 * the single matching row. Even if MRPEasy ignores the query
 * param in some future release, the user still lands on the
 * items list where the in-app search bar resolves the same code
 * in two keystrokes — graceful failure mode.
 */

const MRPEASY_BASE_URL = "https://app.mrpeasy.com";

/**
 * Return the MRPEasy deep-link URL for a given product code, or
 * ``null`` when the code is empty / whitespace only (so callers
 * can branch on the falsy value rather than render a link to a
 * blank items page).
 */
export function buildMrpeasyItemUrl(code: string | null | undefined): string | null {
  const trimmed = (code ?? "").trim();
  if (!trimmed) return null;
  return `${MRPEASY_BASE_URL}/items?code=${encodeURIComponent(trimmed)}`;
}
