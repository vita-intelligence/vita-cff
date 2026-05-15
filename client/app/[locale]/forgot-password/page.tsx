import { getTranslations, setRequestLocale } from "next-intl/server";

import { getCurrentUserServer } from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

import { ForgotPasswordForm } from "./forgot-password-form";

/**
 * ``/forgot-password`` — Server Component entry.
 *
 * Mirrors the ``/login`` page shell: bounce already-authenticated
 * users back to ``/home`` so they don't accidentally request a
 * reset for an account they are currently signed into. Renders the
 * client form inside the same brutalist card layout used by sign-in
 * and registration for visual continuity.
 */
export default async function ForgotPasswordPage({
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
            {tAuth("forgot_password.subtitle")}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {tAuth("forgot_password.title")}
          </h1>
        </header>
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 sm:p-8">
          <ForgotPasswordForm />
        </div>
      </div>
    </main>
  );
}
