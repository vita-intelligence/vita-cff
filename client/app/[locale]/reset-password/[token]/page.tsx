import { getTranslations, setRequestLocale } from "next-intl/server";

import { ResetPasswordForm } from "./reset-password-form";

/**
 * ``/reset-password/[token]`` — Server Component entry.
 *
 * We deliberately do NOT bounce already-authenticated users away
 * here: a logged-in user who clicked a fresh reset link from
 * their inbox should still be allowed to change their password.
 * Logout-on-rotate is enforced by the backend (the JWT issued
 * before the password change carries the old user state and
 * keeps working until refresh; the user re-authenticating is the
 * cleanest invalidation path).
 */
export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  setRequestLocale(locale);

  const tAuth = await getTranslations("auth");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tAuth("reset_password.subtitle")}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {tAuth("reset_password.title")}
          </h1>
        </header>
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 sm:p-8">
          <ResetPasswordForm token={token} />
        </div>
      </div>
    </main>
  );
}
