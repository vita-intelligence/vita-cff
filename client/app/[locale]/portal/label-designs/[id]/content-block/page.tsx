import { redirect } from "next/navigation";


/**
 * Legacy route — the content block is now a tab on the unified
 * workspace at ``/portal/label-designs/<id>?tab=content-block``.
 */
export default async function PortalLabelDesignContentBlockRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/portal/label-designs/${id}?tab=content-block`);
}
