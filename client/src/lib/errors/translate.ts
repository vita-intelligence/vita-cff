/**
 * Translate a backend/Zod error code into a user-facing string.
 *
 * Every code we expect to surface to the UI has a key under
 * ``errors.codes`` in the locale files. Unknown codes fall back to the
 * generic error message so a new server-side code never renders a raw
 * ``snake_case_token`` to users.
 */

import { ApiError } from "@/lib/api/errors";

export type Translator = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

/**
 * Translate a single code (top-level or per-field) against the
 * ``errors.codes.*`` namespace. Returns ``null`` when the code is
 * empty or unmapped — letting :func:`extractApiErrorMessage` keep
 * walking the payload instead of stopping on a falsy "generic"
 * answer.
 */
function translateCodeStrict(
  t: Translator,
  code: string | undefined,
): string | null {
  if (!code) return null;
  const key = `codes.${code}`;
  const translated = t(key);
  if (translated === key) return null;
  return translated;
}

export function translateCode(t: Translator, code: string | undefined): string {
  return translateCodeStrict(t, code) ?? t("generic");
}

/**
 * Drop tokens that look like ``snake_case_codes`` (no spaces, all
 * lowercase letters / digits / underscores). DRF's default messages
 * frequently come back as raw codes when no human-readable detail
 * was set, and surfacing those to users defeats the whole point of
 * codified errors.
 */
function isHumanSentence(text: string): boolean {
  if (!text) return false;
  if (text.length > 200) return false;
  if (!text.includes(" ")) return false;
  return /[A-Z]|[.!?]/.test(text);
}

/**
 * Resolve a user-facing error string from any thrown value. Walks
 * the payload in order of specificity:
 *
 * 1. ``ApiError.code`` — top-level ``codified_exception_handler``
 *    output and ``api_code``-bearing custom exceptions.
 * 2. First ``payload.detail`` entry when DRF returned a code list
 *    (``{detail: ["foo_bar"]}``).
 * 3. First per-field code under ``fieldErrors``.
 * 4. ``payload.detail`` as a free-form sentence (e.g. permissions
 *    errors raised through ``PermissionDenied("...")``).
 * 5. Status-based fallback so 401/403/404/5xx/0 each get their own
 *    locale string instead of the generic catch-all.
 * 6. ``errors.generic``.
 *
 * Replaces the ad-hoc helper that used to live next to every
 * mutation handler — a 17-way duplicate that only inspected
 * ``fieldErrors`` and silently buried every top-level ``code`` and
 * ``detail`` the backend produced.
 */
export interface ExtractApiErrorMessageOptions {
  /**
   * String returned when no specific message could be derived. Lets
   * callers swap in a context-specific fallback (e.g. ``"Couldn't
   * create the validation."``) instead of the generic copy. Defaults
   * to ``t("generic")``.
   */
  readonly fallback?: string;
}

export function extractApiErrorMessage(
  error: unknown,
  t: Translator,
  options: ExtractApiErrorMessageOptions = {},
): string {
  const fallback = options.fallback ?? t("generic");

  if (error instanceof ApiError) {
    const codeMessage = translateCodeStrict(t, error.code);
    if (codeMessage) return codeMessage;

    const detailRaw = error.payload?.detail;
    if (Array.isArray(detailRaw)) {
      for (const entry of detailRaw) {
        if (typeof entry !== "string") continue;
        const detailMessage = translateCodeStrict(t, entry);
        if (detailMessage) return detailMessage;
      }
    }

    for (const codes of Object.values(error.fieldErrors)) {
      if (!Array.isArray(codes)) continue;
      for (const code of codes) {
        const fieldMessage = translateCodeStrict(t, String(code));
        if (fieldMessage) return fieldMessage;
      }
    }

    if (typeof detailRaw === "string" && isHumanSentence(detailRaw)) {
      return detailRaw;
    }
    if (isHumanSentence(error.message)) {
      return error.message;
    }

    if (error.status === 401) return t("unauthorized");
    if (error.status === 403) return t("forbidden");
    if (error.status === 404) return t("not_found");
    if (error.status === 429) return t("too_many_requests");
    if (error.status >= 500) return t("server");
    if (error.status === 0) return t("network");

    return fallback;
  }

  if (error instanceof Error && isHumanSentence(error.message)) {
    return error.message;
  }

  return fallback;
}
