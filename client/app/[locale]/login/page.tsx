import { getTranslations, setRequestLocale } from "next-intl/server";

import { getCurrentUserServer } from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { LoginForm } from "./login-form";

/**
 * Strip and validate a ``?next=`` query value before redirecting an
 * already-authenticated user away from ``/login``. Mirrors the same
 * defensive checks the client-side login form runs (open-redirect
 * defence) so a stale cookie + a poisoned link never bounces the user
 * to an external phishing target.
 */
function resolveNextHref(raw: string | string[] | undefined): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate) return "/home";
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return "/home";
  }
  if (!decoded.startsWith("/")) return "/home";
  // ``//evil.example.com`` and ``/\evil`` are protocol-relative URLs
  // that browsers resolve to a different origin.
  if (decoded.startsWith("//") || decoded.startsWith("/\\")) return "/home";
  // Don't loop back to the auth surfaces.
  if (decoded.startsWith("/login") || decoded.startsWith("/register")) {
    return "/home";
  }
  return decoded;
}

/**
 * ``/login`` — async Server Component.
 *
 * Reads the httpOnly auth cookies via ``next/headers`` and calls the
 * backend's ``/me/`` endpoint. If a valid session is already in place
 * we redirect away before any HTML is shipped to the browser — the
 * user never sees a login form they do not need. When the inbound URL
 * carries ``?next=...`` (set by the page-guard bounce path) we honour
 * it so a JWT-race recovery resumes the user's navigation instead of
 * dumping them on ``/home``.
 */
export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (user) {
    const search = await searchParams;
    redirect({ href: resolveNextHref(search.next), locale });
  }

  const tAuth = await getTranslations("auth");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tAuth("login.subtitle")}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {tAuth("login.title")}
          </h1>
        </header>
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 sm:p-8">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
