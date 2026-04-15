import { Link } from "@/i18n/navigation";

type CatalogueTab = "catalogue" | "fields";

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
  const base = "border-b-2 pb-2 font-mono text-[10px] tracking-widest uppercase";
  const activeCls = `${base} border-ink-1000 text-ink-1000`;
  const inactiveCls = `${base} border-transparent text-ink-500 hover:text-ink-1000`;
  return (
    <nav className="mt-10 flex items-center gap-6 border-b-2 border-ink-200">
      <Link
        href={`/catalogues/${slug}`}
        className={active === "catalogue" ? activeCls : inactiveCls}
      >
        {catalogueLabel}
      </Link>
      <Link
        href={`/catalogues/${slug}/fields`}
        className={active === "fields" ? activeCls : inactiveCls}
      >
        {fieldsLabel}
      </Link>
    </nav>
  );
}
