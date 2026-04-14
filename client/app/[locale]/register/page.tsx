import { getTranslations, setRequestLocale } from "next-intl/server";

import { getCurrentUserServer } from "@/lib/auth/server";
import { redirect } from "@/i18n/navigation";

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

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-6 py-12">
      <div className="w-full max-w-md">
        <header className="mb-10 text-center">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-500">
            {tAuth("register.subtitle")}
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight uppercase">
            {tAuth("register.title")}
          </h1>
        </header>
        <RegisterForm />
      </div>
    </main>
  );
}
