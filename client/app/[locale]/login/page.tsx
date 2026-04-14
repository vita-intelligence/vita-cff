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
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-6">
      <div className="w-full max-w-md">
        <header className="mb-10 text-center">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-500">
            {tAuth("login.subtitle")}
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight uppercase">
            {tAuth("login.title")}
          </h1>
        </header>
        <LoginForm />
      </div>
    </main>
  );
}
