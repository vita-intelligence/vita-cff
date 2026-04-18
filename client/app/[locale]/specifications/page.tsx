import { setRequestLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";


/**
 * ``/specifications`` is no longer a first-class destination —
 * every spec sheet belongs to a project, so users read and manage
 * them from the project workspace's "Spec sheets" tab.
 *
 * The route stays so old bookmarks and direct links don't 404; we
 * just bounce to the project list. Deep-linked sheet URLs at
 * ``/specifications/<id>`` still resolve as before.
 */
export default async function SpecificationsListPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirect({ href: "/formulations", locale });
}
