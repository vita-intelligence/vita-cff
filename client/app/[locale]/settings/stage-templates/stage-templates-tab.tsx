"use client";

import { ArrowUpRight, Loader2, Route } from "lucide-react";

import { useStageTemplates } from "@/services/formulations";

/** Stage templates are now hosted on PSP as "routing templates". NPD
 *  mirrors them read-only; scientists pick one on the formulation
 *  builder's Stages tab and NPD snapshots the picked template onto
 *  the item at sync time. Admins go to PSP's
 *  ``/production/routings`` surface to add / edit / archive. */
export function StageTemplatesTab({
  orgId,
  pspBaseUrl,
}: {
  readonly orgId: string;
  readonly pspBaseUrl: string | null;
}) {
  const { data, isLoading, isError, error, refetch } = useStageTemplates(orgId);
  const pspTemplatesHref = pspBaseUrl
    ? `${pspBaseUrl.replace(/\/+$/, "")}/production/routings`
    : null;

  return (
    <section className="space-y-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight text-ink-1000">
              Stage templates
            </h1>
            <p className="max-w-2xl text-sm text-ink-600">
              Reusable operation sequences the formulation builder
              picks from. Hosted on PSP under{" "}
              <span className="font-medium text-ink-800">
                Production → Routing templates
              </span>
              . Add, rename, or archive templates there — this list
              mirrors the live PSP catalog read-only.
            </p>
          </div>
          {pspTemplatesHref ? (
            <a
              href={pspTemplatesHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 bg-ink-0 px-3 py-1.5 text-sm font-medium text-ink-800 shadow-sm transition hover:bg-ink-50"
            >
              Manage in PSP
              <ArrowUpRight className="size-4" />
            </a>
          ) : null}
        </div>
      </header>

      {isLoading ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-ink-200 bg-ink-0 px-4 py-6 text-sm text-ink-600">
          <Loader2 className="size-4 animate-spin" />
          Fetching templates from PSP…
        </div>
      ) : isError ? (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <p className="font-medium">Couldn&apos;t reach PSP.</p>
          <p className="text-xs">
            {error instanceof Error ? error.message : "Unknown error."}
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 transition hover:bg-amber-100"
          >
            Try again
          </button>
        </div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="space-y-2 rounded-md border border-dashed border-ink-200 bg-ink-0 px-4 py-8 text-center">
          <Route className="mx-auto size-6 text-ink-400" />
          <p className="text-sm font-medium text-ink-800">
            No routing templates on PSP yet
          </p>
          <p className="mx-auto max-w-md text-xs text-ink-600">
            Head to PSP → Production → Routing templates and define
            one. Each template becomes a pick-and-apply option on
            the formulation builder&apos;s Stages tab.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-ink-100 overflow-hidden rounded-md border border-ink-200 bg-ink-0">
          {data!.items.map((tpl) => (
            <li key={tpl.id} className="flex items-start gap-3 px-4 py-3">
              <Route className="mt-0.5 size-4 text-ink-500" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium text-ink-900">
                  {tpl.name}
                </p>
                {tpl.description ? (
                  <p className="truncate text-xs text-ink-600">
                    {tpl.description}
                  </p>
                ) : null}
                <p className="text-[11px] text-ink-500">
                  {tpl.stages.length}{" "}
                  {tpl.stages.length === 1 ? "step" : "steps"}
                  {tpl.stages.length > 0 ? ": " : ""}
                  {tpl.stages
                    .map(
                      (s) =>
                        s.workstation_group_name ||
                        s.name ||
                        "Unnamed step",
                    )
                    .join(" → ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
