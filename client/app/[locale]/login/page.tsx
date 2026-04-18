import { getTranslations, setRequestLocale } from "next-intl/server";

import { getCurrentUserServer } from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { LoginForm } from "./login-form";

/**
 * ``/login`` — async Server Component.
 *
 * Reads the httpOnly auth cookies via ``next/headers`` and calls the
 * backend's ``/me/`` endpoint. If a valid session is already in place we
 * redirect to ``/home`` before any HTML is shipped to the browser — the
 * user never sees a login form they do not need.
 */
export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (user) {
    redirect({ href: "/home", locale });
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
