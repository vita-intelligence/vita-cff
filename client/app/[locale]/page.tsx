import { getTranslations, setRequestLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

/**
 * Public landing page. Intentionally minimal — a real marketing layout
 * is a later task. For now we just show the product name, a one-line
 * description, and the two primary CTAs.
 */
export default async function LandingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const tCommon = await getTranslations("common");
  const tAuth = await getTranslations("auth");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-4 py-10 sm:px-6">
      <div className="w-full max-w-xl text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tCommon("brand")}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink-1000 sm:text-4xl md:text-5xl">
          {tCommon("tagline")}
        </h1>
        <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
          <Link
            href="/login"
            className="inline-flex h-11 items-center justify-center rounded-lg bg-orange-500 px-6 text-sm font-medium text-ink-0 transition-colors hover:bg-orange-600"
          >
            {tAuth("login.submit")}
          </Link>
          <Link
            href="/register"
            className="inline-flex h-11 items-center justify-center rounded-lg bg-ink-0 px-6 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            {tAuth("register.submit")}
          </Link>
        </div>
      </div>
    </main>
  );
}
