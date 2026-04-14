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
    <main className="flex min-h-dvh items-center justify-center bg-ink-0 px-6">
      <div className="w-full max-w-xl text-center">
        <p className="font-mono text-xs tracking-widest uppercase text-ink-500">
          {tCommon("brand")}
        </p>
        <h1 className="mt-4 text-4xl font-black tracking-tight uppercase md:text-5xl">
          {tCommon("tagline")}
        </h1>
        <div className="mt-10 flex flex-wrap justify-center gap-4">
          <Link
            href="/login"
            className="inline-flex items-center justify-center border-2 border-ink-1000 bg-ink-1000 px-6 py-3 text-sm font-bold tracking-wider uppercase text-ink-0 transition-shadow hover:shadow-hard"
          >
            {tAuth("login.submit")}
          </Link>
          <Link
            href="/register"
            className="inline-flex items-center justify-center border-2 border-ink-1000 bg-ink-0 px-6 py-3 text-sm font-bold tracking-wider uppercase text-ink-1000 transition-shadow hover:shadow-hard"
          >
            {tAuth("register.submit")}
          </Link>
        </div>
      </div>
    </main>
  );
}
