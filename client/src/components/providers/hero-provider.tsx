"use client";

import { Toast } from "@heroui/react";
import { I18nProvider } from "react-aria-components";
import { useLocale } from "next-intl";
import type { ReactNode } from "react";

/**
 * UI-library provider shell.
 *
 * HeroUI v3 is built on ``react-aria-components`` and does not ship its
 * own root provider — the only thing the library needs wired up is the
 * ``I18nProvider`` from react-aria so date/number/locale-aware components
 * pick up the active locale from ``next-intl``. Everything else works out
 * of the box. The ``Toast.Provider`` renders the floating toast region
 * used by ``toast.success``/``toast.danger`` calls throughout the app.
 */
export function HeroProvider({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return (
    <I18nProvider locale={locale}>
      {children}
      <Toast.Provider placement="top end" />
    </I18nProvider>
  );
}
