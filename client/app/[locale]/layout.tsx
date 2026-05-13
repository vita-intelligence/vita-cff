import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { NavigationProgress } from "@/components/layout/navigation-progress";
import { Providers } from "@/components/providers";
import { site } from "@/config/site";
import { routing } from "@/i18n/routing";

import "../globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-display-sans",
  display: "swap",
  weight: ["400", "500", "600", "700", "800", "900"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-display-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: site.name,
    template: `%s — ${site.name}`,
  },
  description: site.description,
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      className={`${archivo.variable} ${jetbrainsMono.variable}`}
      // Browser extensions (Grammarly, Dark Reader, LastPass, etc.)
      // mutate <html> attributes between SSR and client hydration,
      // which surfaces as a React "tree hydrated but some attributes
      // didn't match" warning that the user can do nothing about.
      // suppressHydrationWarning only silences the warning on this
      // element's own attributes — every child is still checked
      // normally, so real hydration bugs deeper in the tree still
      // bubble up loudly.
      suppressHydrationWarning
    >
      <body className="bg-ink-0 text-ink-1000 font-sans antialiased">
        <NextIntlClientProvider messages={messages}>
          <Providers>
            <NavigationProgress />
            {children}
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
