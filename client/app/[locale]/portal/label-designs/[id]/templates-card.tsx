"use client";

/**
 * Customer-facing "Design resources" card.
 *
 * Fetches the org's curated label-design template library and
 * renders each category with its files. The customer downloads
 * straight from storage (Azure Blob in prod) — Django never
 * relays the bytes. Visible whenever the customer is on the
 * DESIGN_BY_CUSTOMER path, regardless of status, so a customer
 * about to upload a revision can grab a clean template at any
 * point in the loop.
 */

import { useQuery } from "@tanstack/react-query";
import { Download, Layers, Loader2 } from "lucide-react";

import { Card, Eyebrow } from "@/components/portal/brutalist";
import { fetchPortalLabelDesignTemplates } from "@/services/label-design";


function formatSize(bytes: number): string {
  if (!bytes) return "";
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}


export function TemplatesCard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["portal-label-design-templates"],
    queryFn: fetchPortalLabelDesignTemplates,
    // Templates change rarely (staff curated) but the customer
    // may upload a revision and re-open this surface — 5min
    // staleness keeps the cache snappy without being misleading.
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <Eyebrow>DESIGN RESOURCES</Eyebrow>
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      </Card>
    );
  }
  if (error || !data || data.length === 0) {
    // Hide the card entirely when the library is empty — no
    // point surfacing an empty section that just confuses the
    // customer.
    return null;
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <Layers className="mt-0.5 h-5 w-5 shrink-0 text-black" />
        <div className="flex-1">
          <Eyebrow>DESIGN RESOURCES</Eyebrow>
          <h3 className="mt-1 text-lg font-bold">Vita templates</h3>
          <p className="mt-1 text-sm text-neutral-600">
            Download these to use as a starting point in your design tool of
            choice.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {data.map((group) => (
          <section key={group.category.id}>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600">
              {group.category.name}
            </p>
            {group.category.description ? (
              <p className="mt-0.5 text-xs text-neutral-500">
                {group.category.description}
              </p>
            ) : null}
            <ul className="mt-2 flex flex-col gap-2">
              {group.templates.map((t) => (
                <li
                  key={t.id}
                  className="flex flex-wrap items-center gap-2 border-2 border-black bg-white p-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold">{t.name}</p>
                    {t.description ? (
                      <p className="text-xs text-neutral-600">
                        {t.description}
                      </p>
                    ) : null}
                    <p className="mt-0.5 text-[11px] text-neutral-500">
                      {t.file_original_name || "file"}
                      {t.file_size_bytes
                        ? ` · ${formatSize(t.file_size_bytes)}`
                        : ""}
                    </p>
                  </div>
                  {t.file_url ? (
                    <a
                      href={t.file_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      download={t.file_original_name || true}
                      className="inline-flex items-center gap-1.5 border-2 border-black bg-black px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.15em] text-white hover:bg-neutral-800"
                    >
                      <Download className="h-3 w-3" /> Download
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Card>
  );
}
