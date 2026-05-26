import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link, redirect } from "@/i18n/navigation";
import { env } from "@/config/env";
import { getCurrentUserServer } from "@/lib/auth/server";

import { RegisterForm } from "./register-form";

export default async function RegisterPage({
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
  const registrationOpen = env.NEXT_PUBLIC_STAFF_REGISTRATION_ENABLED;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-4 py-10 sm:px-6">
      <div className="w-full max-w-md">
        <header className="mb-8 text-center">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {registrationOpen
              ? tAuth("register.subtitle")
              : tAuth("register.disabled.subtitle")}
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-ink-1000 sm:text-3xl">
            {registrationOpen
              ? tAuth("register.title")
              : tAuth("register.disabled.title")}
          </h1>
        </header>
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 sm:p-8">
          {registrationOpen ? (
            <RegisterForm />
          ) : (
            <div className="flex flex-col gap-5 text-sm text-ink-700">
              <p className="leading-relaxed">{tAuth("register.disabled.body")}</p>
              <Link
                href="/login"
                className="self-start text-sm font-medium text-orange-700 underline-offset-4 hover:text-orange-800 hover:underline"
              >
                {tAuth("register.disabled.back_to_login")}
              </Link>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
