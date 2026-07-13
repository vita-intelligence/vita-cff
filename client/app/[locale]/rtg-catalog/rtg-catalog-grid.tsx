"use client";

/**
 * Client-side grid for the staff RTG Catalog page.
 *
 * Renders every ``project_type='ready_to_go'`` formulation as a card
 * regardless of publish state, with a Published / Unpublished chip and
 * a quick summary of the marketing block (price, MOQ, packaging count).
 * A three-way filter tab (All / Published / Unpublished) lets the
 * catalog manager narrow the grid without paging back into the
 * projects list.
 *
 * The card click routes to ``/formulations/<id>`` — the RTG catalog
 * editing surface (:class:`RTGCatalogPanel`) is embedded on the
 * project overview page, so we send the manager straight there.
 * Keeping the edit surface on the project page (rather than making
 * it a modal here) preserves a single source of truth for the panel
 * and keeps this grid stateless.
 */

import { useMemo, useState } from "react";
import { CheckCircle2, EyeOff, ImageIcon, Package } from "lucide-react";

import { Link } from "@/i18n/navigation";
import type {
  FormulationDto,
  PaginatedFormulationsDto,
} from "@/services/formulations/types";


type FilterKey = "all" | "published" | "unpublished";


interface Props {
  readonly orgId: string;
  readonly initialFirstPage: PaginatedFormulationsDto | null;
  readonly canWrite: boolean;
}


export function RTGCatalogGrid({ initialFirstPage, canWrite }: Props) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const items = initialFirstPage?.results ?? [];

  const { published, unpublished } = useMemo(() => {
    const p: FormulationDto[] = [];
    const u: FormulationDto[] = [];
    for (const item of items) {
      if (item.is_rtg_published) p.push(item);
      else u.push(item);
    }
    return { published: p, unpublished: u };
  }, [items]);

  const visible =
    filter === "published"
      ? published
      : filter === "unpublished"
        ? unpublished
        : items;

  if (items.length === 0) {
    return <EmptyState canWrite={canWrite} />;
  }

  return (
    <div className="flex flex-col gap-6">
      <FilterTabs
        filter={filter}
        onChange={setFilter}
        counts={{
          all: items.length,
          published: published.length,
          unpublished: unpublished.length,
        }}
      />

      {visible.length === 0 ? (
        <p className="rounded-2xl bg-ink-50 p-8 text-center text-sm text-ink-500 ring-1 ring-ink-200">
          No SKUs match the current filter.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((f) => (
            <CatalogCard key={f.id} formulation={f} />
          ))}
        </div>
      )}
    </div>
  );
}


function FilterTabs({
  filter,
  onChange,
  counts,
}: {
  filter: FilterKey;
  onChange: (next: FilterKey) => void;
  counts: Record<FilterKey, number>;
}) {
  const tabs: readonly { key: FilterKey; label: string }[] = [
    { key: "all", label: "All" },
    { key: "published", label: "Published" },
    { key: "unpublished", label: "Unpublished" },
  ];
  return (
    <div
      className="inline-flex items-center gap-1 rounded-full bg-ink-50 p-1 ring-1 ring-ink-200"
      role="tablist"
    >
      {tabs.map((t) => {
        const active = filter === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
              active
                ? "bg-white text-ink-1000 shadow-sm"
                : "text-ink-500 hover:text-ink-800"
            }`}
          >
            <span>{t.label}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                active
                  ? "bg-ink-100 text-ink-700"
                  : "bg-white text-ink-500"
              }`}
            >
              {counts[t.key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}


function CatalogCard({ formulation }: { formulation: FormulationDto }) {
  const {
    id,
    code,
    name,
    is_rtg_published,
    rtg_short_description,
    rtg_hero_image,
    rtg_base_price,
    rtg_currency_code,
    rtg_moq,
    rtg_packaging_options,
  } = formulation;

  const priceLabel = formatPrice(rtg_base_price, rtg_currency_code);

  return (
    <Link
      href={`/formulations/${id}`}
      className="group flex flex-col overflow-hidden rounded-2xl bg-white ring-1 ring-ink-200 transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-[4/3] w-full bg-ink-50">
        {rtg_hero_image ? (
          // Hero image is a plain URL served from Django's media root
          // — using ``next/image`` here would require adding the media
          // host to ``images.remotePatterns`` per env, so we render the
          // raw <img> element and eat the marginal LCP hit for now.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={rtg_hero_image}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-300">
            <ImageIcon className="h-10 w-10" aria-hidden />
          </div>
        )}
        <span
          className={`absolute right-3 top-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            is_rtg_published
              ? "bg-emerald-100 text-emerald-800"
              : "bg-ink-100 text-ink-600"
          }`}
        >
          {is_rtg_published ? (
            <>
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Published
            </>
          ) : (
            <>
              <EyeOff className="h-3 w-3" aria-hidden />
              Unpublished
            </>
          )}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            {code || "—"}
          </p>
          <h2 className="mt-0.5 line-clamp-2 text-base font-semibold tracking-tight text-ink-1000 group-hover:text-orange-700">
            {name}
          </h2>
        </div>
        {rtg_short_description ? (
          <p className="line-clamp-2 text-xs text-ink-600">
            {rtg_short_description}
          </p>
        ) : (
          <p className="text-xs italic text-ink-400">
            No short description yet.
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
          {priceLabel ? (
            <span className="rounded-full bg-ink-50 px-2 py-0.5 font-medium">
              {priceLabel}
            </span>
          ) : null}
          {rtg_moq ? (
            <span className="rounded-full bg-ink-50 px-2 py-0.5 font-medium">
              MOQ {rtg_moq}
            </span>
          ) : null}
          {rtg_packaging_options.length > 0 ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 font-medium">
              <Package className="h-3 w-3" aria-hidden />
              {rtg_packaging_options.length} pack
              {rtg_packaging_options.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}


function EmptyState({ canWrite }: { canWrite: boolean }) {
  return (
    <div className="rounded-2xl bg-ink-50 p-10 text-center ring-1 ring-ink-200">
      <p className="text-sm font-medium text-ink-800">
        No Ready-to-Go products yet.
      </p>
      <p className="mt-2 text-xs text-ink-500">
        Any formulation with{" "}
        <span className="font-mono">project_type = ready_to_go</span>{" "}
        shows up here.{" "}
        {canWrite ? (
          <>
            Create one from{" "}
            <Link
              href="/formulations"
              className="text-orange-700 underline-offset-2 hover:underline"
            >
              Formulations
            </Link>{" "}
            (pick Ready-to-Go on the new-project form), or open an
            existing project and switch its type.
          </>
        ) : (
          <>Ask a project owner to publish some RTG SKUs to your catalog.</>
        )}
      </p>
    </div>
  );
}


function formatPrice(
  amount: string | null,
  currency: string,
): string | null {
  if (!amount) return null;
  const parsed = Number(amount);
  if (!Number.isFinite(parsed)) return null;
  try {
    // ``Intl.NumberFormat`` handles the currency symbol + separators
    // for us; falling back on an unknown code (theoretical — we
    // constrain to GBP/EUR/USD in the publish panel) keeps the card
    // rendering rather than throwing.
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(parsed);
  } catch {
    return `${currency} ${parsed.toFixed(2)}`;
  }
}
