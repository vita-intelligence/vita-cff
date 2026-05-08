import "server-only";

import { headers } from "next/headers";

import { redirect } from "@/i18n/navigation";

const APP_PATHNAME_HEADER = "x-app-pathname";

/**
 * Strip a leading locale segment (e.g. ``/en``) from a pathname so the
 * captured ``next`` value is locale-free. The redirect target is then
 * routed back through ``createNavigation``'s ``redirect``, which adds
 * the right locale prefix at restore time.
 */
function stripLocalePrefix(pathname: string, locale: string): string {
  const prefix = `/${locale}`;
  if (pathname === prefix) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/**
 * Resolve the inbound pathname from the proxy-injected
 * ``x-app-pathname`` request header. Falls back to ``referer`` (which
 * the browser sets on a server-driven redirect) and finally to ``/home``
 * so the user always lands somewhere usable after login.
 */
async function resolveCurrentPathname(locale: string): Promise<string> {
  const headerStore = await headers();
  const fromProxy = headerStore.get(APP_PATHNAME_HEADER);
  if (fromProxy) {
    return stripLocalePrefix(fromProxy, locale);
  }
  const referer = headerStore.get("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      return stripLocalePrefix(url.pathname + url.search, locale);
    } catch {
      // referer is not a parseable URL — drop through to the default.
    }
  }
  return "/home";
}

/**
 * Server-side helper for the "auth required" branch in every page
 * guard. Captures the current pathname (so the user can be sent
 * back to where they were after re-authenticating) and hands off to
 * :func:`@/i18n/navigation.redirect`. Never returns — ``redirect``
 * throws to short-circuit the render.
 */
export async function redirectToLogin(locale: string): Promise<never> {
  const next = await resolveCurrentPathname(locale);
  // Public landing surfaces should not loop back to themselves.
  const skipNext =
    next === "/" ||
    next === "/login" ||
    next.startsWith("/login?") ||
    next.startsWith("/register") ||
    next.startsWith("/workspace-locked");
  const href = skipNext ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  redirect({ href, locale });
  // ``redirect`` always throws — the unreachable return keeps the type
  // signature honest for callers.
  throw new Error("unreachable");
}
