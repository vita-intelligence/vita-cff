/**
 * Static site metadata. Imported by ``app/[locale]/layout.tsx`` for the
 * default ``<Metadata>`` export and by anything that needs the app's name,
 * description, or canonical links.
 */

export const site = {
  name: "Vita NPD",
  shortName: "Vita NPD",
  description: "Formulation builder and proposal platform.",
  locale: {
    default: "en",
    supported: ["en"] as const,
  },
} as const;

export type SiteConfig = typeof site;
