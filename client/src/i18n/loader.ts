/**
 * Locale message loader.
 *
 * Each locale ships as several small JSON files — one per feature area —
 * so translators can work on individual chunks without merge conflicts on
 * a single monolithic dictionary. This loader merges them into the flat
 * namespaced object next-intl expects.
 *
 * Adding a new namespace:
 *   1. Create ``locales/<locale>/<name>.json``
 *   2. Add ``<name>`` to the ``namespaces`` tuple below
 *   3. Use ``t('<name>.key')`` in components
 *
 * Adding a new locale:
 *   1. Create ``locales/<new-locale>/`` with a copy of every JSON file
 *   2. Register it in ``src/config/site.ts`` and ``src/i18n/routing.ts``
 */

export const namespaces = [
  "common",
  "auth",
  "errors",
  "navigation",
  "validation",
  "organizations",
  "invitations",
  "items",
  "attributes",
  "formulations",
  "project_overview",
  "project_tabs",
  "specifications",
  "trial_batches",
  "product_validation",
  "settings",
  "ai",
  "audit_log",
  "workspace_locked",
  "comments",
] as const;

export type Namespace = (typeof namespaces)[number];

export type LocaleMessages = Record<Namespace, Record<string, unknown>>;

export async function loadMessages(locale: string): Promise<LocaleMessages> {
  const entries = await Promise.all(
    namespaces.map(async (ns) => {
      const mod = (await import(`./locales/${locale}/${ns}.json`)) as {
        default: Record<string, unknown>;
      };
      return [ns, mod.default] as const;
    }),
  );
  return Object.fromEntries(entries) as LocaleMessages;
}
