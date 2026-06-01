import { redirect } from "next/navigation";


/**
 * Legacy route — the upload form now lives inline on the
 * unified workspace at ``/portal/label-designs/<id>?tab=artwork``.
 * Old emails / bookmarks bounce there so the customer never sees
 * a "page not found".
 */
export default async function PortalLabelDesignUploadRedirect({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  redirect(`/${locale}/portal/label-designs/${id}?tab=artwork`);
}
