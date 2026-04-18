import { Layers, Sliders } from "lucide-react";

import { Link } from "@/i18n/navigation";

type CatalogueTab = "catalogue" | "fields";


/**
 * Two-tab switcher at the top of a catalogue detail page — items vs
 * attribute definitions. Mirrors the project workspace tab bar so
 * active/inactive states share the orange underline language.
 */
export function CatalogueTabs({
  slug,
  active,
  catalogueLabel,
  fieldsLabel,
}: {
  slug: string;
  active: CatalogueTab;
  catalogueLabel: string;
  fieldsLabel: string;
}) {
  const activeCls =
    "inline-flex items-center gap-2 border-b-2 border-orange-500 px-3 py-2.5 text-sm font-medium text-ink-1000";
  const inactiveCls =
    "inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-ink-500 hover:border-ink-300 hover:text-ink-700";
  return (
    <nav
      aria-label="Catalogue sections"
      className="mt-8 flex flex-wrap items-center gap-1 border-b border-ink-200"
    >
      <Link
        href={`/catalogues/${slug}`}
        aria-current={active === "catalogue" ? "page" : undefined}
        className={active === "catalogue" ? activeCls : inactiveCls}
      >
        <Layers className="h-4 w-4" />
        {catalogueLabel}
      </Link>
      <Link
        href={`/catalogues/${slug}/fields`}
        aria-current={active === "fields" ? "page" : undefined}
        className={active === "fields" ? activeCls : inactiveCls}
      >
        <Sliders className="h-4 w-4" />
        {fieldsLabel}
      </Link>
    </nav>
  );
}
