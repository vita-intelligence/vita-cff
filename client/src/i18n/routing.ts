/**
 * next-intl routing configuration.
 *
 * ``defineRouting`` produces a strongly typed list of locales, the default
 * locale, and the routing strategy. It is consumed by the middleware, the
 * typed ``Link`` helpers, and the ``request.ts`` loader.
 */

import { defineRouting } from "next-intl/routing";

import { site } from "@/config/site";

export const routing = defineRouting({
  locales: [...site.locale.supported],
  defaultLocale: site.locale.default,
  localePrefix: "as-needed",
});

export type AppLocale = (typeof routing.locales)[number];
