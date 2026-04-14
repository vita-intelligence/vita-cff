/**
 * next-intl request configuration.
 *
 * Wired into ``next.config.ts`` via ``createNextIntlPlugin``. On every
 * request this loader resolves the active locale, loads the modular
 * message files, and hands them back to the framework.
 */

import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";

import { loadMessages } from "./loader";
import { routing } from "./routing";

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale;

  return {
    locale,
    messages: await loadMessages(locale),
  };
});
