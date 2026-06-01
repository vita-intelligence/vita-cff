import { redirect } from "next/navigation";


/**
 * Portal root → ``/portal/products``. The two surfaces showed
 * almost the same data (welcome + action queue + product cards)
 * with the only difference being that ``/portal`` capped at 6
 * products. The merged page on ``/portal/products`` is now the
 * single landing surface; this redirect keeps any in-flight
 * bookmark or email link landing in the right place.
 */
export default async function PortalRoot({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect(`/${locale}/portal/products`);
}
