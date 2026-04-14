import { getTranslations, setRequestLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { getCurrentUserServer } from "@/lib/auth/server";

import { HomeActions } from "./home-actions";

/**
 * ``/home`` — protected route.
 *
 * The server-side auth check runs before any HTML is shipped. If the
 * cookie is missing, expired, or tampered with the user is redirected to
 * ``/login`` and never sees the protected shell.
 */
export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await getCurrentUserServer();
  if (!user) {
    redirect({ href: "/login", locale });
  }
  // ``redirect`` throws at runtime, but its return type is not ``never``
  // in the current next-intl typings. Narrow explicitly for TypeScript.
  const currentUser = user!;

  const tCommon = await getTranslations("common");

  return (
    <main className="min-h-dvh bg-ink-0 text-ink-1000">
      <div className="mx-auto flex min-h-dvh max-w-[1536px] flex-col px-6 py-10 md:px-12 md:py-16">
        <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-6">
          <span className="font-mono text-xs tracking-widest uppercase text-ink-500">
            {tCommon("brand")}
          </span>
          <HomeActions />
        </header>

        <section className="flex flex-1 flex-col justify-center py-20">
          <p className="font-mono text-xs tracking-widest uppercase text-ink-500">
            Signed in as
          </p>
          <h1 className="mt-3 text-5xl font-black tracking-tight uppercase md:text-7xl">
            {currentUser.full_name}
          </h1>
          <p className="mt-4 font-mono text-sm text-ink-600">{currentUser.email}</p>
        </section>
      </div>
    </main>
  );
}
