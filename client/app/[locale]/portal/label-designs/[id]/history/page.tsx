import { redirect } from "next/navigation";


/**
 * Legacy route — the history is now a tab on the unified workspace
 * at ``/portal/label-designs/<id>?tab=history``.
 */
export default async function PortalLabelDesignHistoryRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/portal/label-designs/${id}?tab=history`);
}
