"use client";

/**
 * Read-only render of a scientist's MA-PD-B-012 checklist
 * responses.
 *
 * Same shape the staff director sees on their sign-off card — every
 * item the scientist ticked, grouped by section, sorted failed-
 * first, with the scientist's per-item comment underneath. The
 * customer portal embeds this on the artwork tab (after a
 * rejection) + on every revision card in the history tab, so the
 * customer can act on the same information the director used.
 *
 * Style switches via the ``tone`` prop:
 *   - ``"staff"`` — neutral ink palette matching the labelling
 *     workspace cards (what the director sees).
 *   - ``"portal"`` — brutalist black borders + amber/emerald for
 *     fail/pass to match the customer portal cards.
 */

import { useMemo, useState } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";

import {
  CHECKLIST_ITEMS,
  CHECKLIST_SECTIONS,
} from "@/lib/label-design/checklist";


interface ChecklistResponse {
  readonly item_key: string;
  readonly pass: boolean;
  readonly comment: string;
}


export function ScientistChecklistView({
  responses,
  tone = "staff",
  defaultShowPassing = false,
  heading = "Scientist's checklist",
}: {
  readonly responses: ReadonlyArray<ChecklistResponse>;
  readonly tone?: "staff" | "portal";
  readonly defaultShowPassing?: boolean;
  readonly heading?: string;
}) {
  const [showPassing, setShowPassing] = useState(defaultShowPassing);

  const byKey = useMemo(() => {
    const m = new Map<string, { pass: boolean; comment: string }>();
    for (const r of responses) {
      m.set(r.item_key, { pass: r.pass, comment: r.comment });
    }
    return m;
  }, [responses]);

  const failedCount = useMemo(
    () => responses.filter((r) => !r.pass).length,
    [responses],
  );

  const isPortal = tone === "portal";

  const wrapperClass = isPortal
    ? "border-2 border-black bg-paper p-3"
    : "rounded-md bg-ink-0/60 p-2 ring-1 ring-inset ring-ink-200";
  const headerClass = isPortal
    ? "text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-700"
    : "text-[10px] font-semibold uppercase tracking-wide text-ink-600";
  const toggleClass = isPortal
    ? "border-2 border-black bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] hover:bg-neutral-100"
    : "rounded bg-ink-50 px-2 py-0.5 text-[10px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100";
  const sectionHeader = isPortal
    ? "text-[10px] font-bold uppercase tracking-[0.18em] text-neutral-600"
    : "text-[10px] font-semibold uppercase tracking-wide text-ink-500";

  return (
    <div className={wrapperClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className={headerClass}>
          {heading}
          {failedCount > 0 ? (
            <span
              className={`ml-2 ${
                isPortal ? "text-red-700" : "text-rose-700"
              }`}
            >
              · {failedCount} flagged
            </span>
          ) : (
            <span
              className={`ml-2 ${
                isPortal ? "text-emerald-700" : "text-emerald-700"
              }`}
            >
              · all clear
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={() => setShowPassing((v) => !v)}
          className={toggleClass}
        >
          {showPassing ? "Failed only" : "Show all 22 items"}
        </button>
      </div>

      <div className="mt-2 space-y-2">
        {CHECKLIST_SECTIONS.map((section) => {
          const items = CHECKLIST_ITEMS.filter(
            (i) => i.section === section.key,
          );
          if (items.length === 0) return null;

          // Failed items first within each section so a reader's
          // eye lands on the actionable bits before the noise.
          const sorted = [...items].sort((a, b) => {
            const ar = byKey.get(a.key);
            const br = byKey.get(b.key);
            const af = ar ? (ar.pass ? 1 : 0) : 2;
            const bf = br ? (br.pass ? 1 : 0) : 2;
            return af - bf;
          });
          const visible = sorted.filter((item) => {
            const r = byKey.get(item.key);
            return showPassing || !r || !r.pass;
          });
          if (visible.length === 0) return null;

          return (
            <div key={section.key}>
              <p className={sectionHeader}>{section.label}</p>
              <ul className="mt-1 space-y-1">
                {visible.map((item) => {
                  const r = byKey.get(item.key);
                  const pass = r?.pass ?? true;
                  const itemClass = isPortal
                    ? pass
                      ? "border-2 border-emerald-700 bg-emerald-50 p-2 text-[11px] text-emerald-950"
                      : "border-2 border-red-700 bg-red-50 p-2 text-[11px] text-red-950"
                    : pass
                      ? "rounded px-2 py-1 text-[11px] ring-1 ring-inset bg-emerald-50/60 text-ink-900 ring-emerald-200/60"
                      : "rounded px-2 py-1 text-[11px] ring-1 ring-inset bg-rose-50 text-ink-900 ring-rose-200";
                  const badgeClass = isPortal
                    ? pass
                      ? "shrink-0 border-2 border-emerald-700 bg-white px-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-emerald-900"
                      : "shrink-0 border-2 border-red-700 bg-white px-1.5 text-[9px] font-bold uppercase tracking-[0.15em] text-red-900"
                    : pass
                      ? "shrink-0 rounded px-1.5 text-[9px] font-semibold uppercase tracking-wide bg-emerald-100 text-emerald-800"
                      : "shrink-0 rounded px-1.5 text-[9px] font-semibold uppercase tracking-wide bg-rose-100 text-rose-800";
                  return (
                    <li key={item.key} className={itemClass}>
                      <div className="flex items-start gap-1.5">
                        {pass ? (
                          <CheckCircle2
                            className={`mt-0.5 h-3 w-3 shrink-0 ${
                              isPortal ? "text-emerald-700" : "text-emerald-700"
                            }`}
                          />
                        ) : (
                          <AlertCircle
                            className={`mt-0.5 h-3 w-3 shrink-0 ${
                              isPortal ? "text-red-700" : "text-rose-700"
                            }`}
                          />
                        )}
                        <span className="flex-1">{item.label}</span>
                        <span className={badgeClass}>
                          {pass ? "Pass" : "Fail"}
                        </span>
                      </div>
                      {r?.comment ? (
                        <p
                          className={`mt-1 whitespace-pre-line pl-4 ${
                            isPortal
                              ? "text-[11px] text-neutral-800"
                              : "text-[11px] text-ink-700"
                          }`}
                        >
                          {r.comment}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
