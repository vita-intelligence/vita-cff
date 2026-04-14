/**
 * Translate a backend/Zod error code into a user-facing string.
 *
 * Every code we expect to surface to the UI has a key under
 * ``errors.codes`` in the locale files. Unknown codes fall back to the
 * generic error message so a new server-side code never renders a raw
 * ``snake_case_token`` to users.
 */

export type Translator = (
  key: string,
  values?: Record<string, string | number | Date>,
) => string;

export function translateCode(t: Translator, code: string | undefined): string {
  if (!code) {
    return t("generic");
  }
  const key = `codes.${code}`;
  const translated = t(key);
  // ``next-intl``'s default for missing keys is to echo the key back; if
  // that happens we know the code is unmapped and we fall back.
  if (translated === key) {
    return t("generic");
  }
  return translated;
}
