"use client";

import { Button } from "@heroui/react";
import { useTranslations } from "next-intl";
import { Fragment, useState } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  ALLOWED_TRANSITIONS,
  specificationsEndpoints,
  useDeleteSpecification,
  useTransitionSpecificationStatus,
  type RenderedSheetContext,
  type RenderedTransition,
  type SpecificationSheetDto,
  type SpecificationStatus,
} from "@/services/specifications";
import { EditPackagingButton } from "./edit-packaging-button";
import { SharePublicLinkButton } from "./share-public-link-button";


const NUTRITION_ROW_KEYS: readonly (
  | "energy_kj"
  | "energy_kcal"
  | "fat"
  | "fat_saturated"
  | "carbohydrate"
  | "sugar"
  | "fibre"
  | "protein"
  | "salt"
)[] = [
  "energy_kj",
  "energy_kcal",
  "fat",
  "fat_saturated",
  "carbohydrate",
  "sugar",
  "fibre",
  "protein",
  "salt",
];


const AMINO_GROUPS: readonly {
  readonly key: "essential" | "conditionally_essential" | "non_essential";
  readonly acids: readonly string[];
}[] = [
  {
    key: "essential",
    acids: [
      "Isoleucine",
      "Leucine",
      "Lysine",
      "Methionine",
      "Phenylalanine",
      "Threonine",
      "Tryptophan",
      "Valine",
    ],
  },
  {
    key: "conditionally_essential",
    acids: ["Arginine", "Cystine", "Glutamic acid", "Histidine", "Proline", "Tyrosine"],
  },
  {
    key: "non_essential",
    acids: ["Alanine", "Aspartic acid", "Glycine", "Serine"],
  },
];


export function SpecificationSheetView({
  orgId,
  sheet,
  rendered,
  canWrite,
  canAdmin,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
  rendered: RenderedSheetContext;
  canWrite: boolean;
  canAdmin: boolean;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const transitionMutation = useTransitionSpecificationStatus(orgId, sheet.id);
  const deleteMutation = useDeleteSpecification(orgId);

  const allowedNext = ALLOWED_TRANSITIONS[sheet.status] ?? [];

  const handleTransition = async (next: SpecificationStatus) => {
    setErrorMessage(null);
    try {
      await transitionMutation.mutateAsync({ status: next });
      router.refresh();
    } catch (err) {
      setErrorMessage(extractErrorMessage(err, tErrors));
    }
  };

  const handleDelete = async () => {
    if (!confirm(tSpecs("detail.delete_confirm"))) return;
    setErrorMessage(null);
    try {
      await deleteMutation.mutateAsync(sheet.id);
      router.push("/specifications");
    } catch (err) {
      setErrorMessage(extractErrorMessage(err, tErrors));
    }
  };

  const isBusy =
    transitionMutation.isPending || deleteMutation.isPending;

  return (
    <div className="mt-8 flex flex-col gap-6">
      {/* ------------------------------------------------------------ */}
      {/* Top action bar — hidden when printing                         */}
      {/* ------------------------------------------------------------ */}
      <section className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <span className="border-2 border-ink-1000 bg-ink-1000 px-3 py-1 font-mono text-[10px] tracking-widest uppercase text-ink-0">
            {tSpecs(`status.${sheet.status}` as `status.draft`)}
          </span>
          <span className="font-mono text-[11px] tracking-widest uppercase text-ink-500">
            {tSpecs("detail.status_label")}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite
            ? allowedNext.map((next) => (
                <Button
                  key={next}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-none border-2 font-bold tracking-wider uppercase"
                  isDisabled={isBusy}
                  onClick={() => handleTransition(next)}
                >
                  {tSpecs("detail.advance_to")}{" "}
                  {tSpecs(`status.${next}` as `status.draft`)}
                </Button>
              ))
            : null}
          {/*
            Renders an anchor styled as a button so the browser handles
            the binary PDF download natively — cookie auth rides along
            on same-origin navigation. Falling back to window.print()
            would give the scientist a screenshot-quality page; the
            WeasyPrint output is a consistent client deliverable.
          */}
          <a
            href={specificationsEndpoints.pdf(orgId, sheet.id, {
              download: true,
            })}
            download
            className="inline-flex items-center justify-center rounded-none border-2 border-ink-1000 bg-ink-0 px-4 py-1.5 text-sm font-bold tracking-wider uppercase text-ink-1000 transition-colors hover:bg-ink-100"
          >
            {tSpecs("detail.download_pdf")}
          </a>
          {canWrite ? (
            <EditPackagingButton orgId={orgId} sheet={sheet} />
          ) : null}
          {canWrite ? (
            <SharePublicLinkButton orgId={orgId} sheet={sheet} />
          ) : null}
          {canAdmin ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="rounded-none font-bold tracking-wider uppercase"
              isDisabled={isBusy}
              onClick={handleDelete}
            >
              {tSpecs("detail.delete")}
            </Button>
          ) : null}
        </div>
      </section>

      {errorMessage ? (
        <p
          role="alert"
          className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger print:hidden"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* The spec sheet itself                                         */}
      {/* ------------------------------------------------------------ */}
      <SpecSheetContent rendered={rendered} />
    </div>
  );
}


/**
 * Pure presentational renderer for the spec sheet body. Takes only
 * the render-context view-model — no org context, no permissions, no
 * mutations. Reused by the authenticated detail page and the public
 * client-preview page so both see pixel-identical output.
 */
export function SpecSheetContent({
  rendered,
}: {
  rendered: RenderedSheetContext;
}) {
  const tSpecs = useTranslations("specifications");

  return (
      <article className="border-2 border-ink-1000 bg-ink-0 p-6 md:p-10 print:border-0 print:p-0">
        {rendered.sheet.status === "draft" ? (
          <p className="mb-4 border-2 border-ink-500 bg-ink-100 px-3 py-2 text-center font-mono text-[10px] tracking-widest uppercase text-ink-700">
            {tSpecs("sheet.signature.draft_watermark")}
          </p>
        ) : null}

        <h1 className="text-2xl font-black tracking-tight uppercase md:text-3xl">
          {tSpecs("sheet.title")}
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-600">
          {rendered.formulation.name} · v
          {rendered.formulation.version_number}
        </p>

        <div className="mt-6 grid grid-cols-1 gap-8 lg:grid-cols-3">
          {/* ==================================================== */}
          {/* LEFT COLUMN — product metadata                        */}
          {/* ==================================================== */}
          <section className="flex flex-col gap-6">
            <SheetSection title={tSpecs("sheet.sections.product")}>
              <KeyValue
                label={tSpecs("sheet.fields.product_code")}
                value={rendered.formulation.code || "—"}
              />
              <KeyValue
                label={tSpecs("sheet.fields.product_description")}
                value={rendered.formulation.name}
              />
            </SheetSection>

            <SheetSection
              title={tSpecs("sheet.sections.specification")}
            >
              <KeyValue
                label={tSpecs("sheet.fields.direction_of_use")}
                value={rendered.formulation.directions_of_use || "—"}
              />
              <KeyValue
                label={tSpecs("sheet.fields.suggested_dosage")}
                value={rendered.formulation.suggested_dosage || "—"}
              />
              <KeyValue
                label={tSpecs("sheet.fields.dosage_form")}
                value={
                  rendered.formulation.dosage_form
                    ? tSpecs(
                        `dosage_forms.${rendered.formulation.dosage_form}` as `dosage_forms.capsule`,
                      )
                    : "—"
                }
              />
              <KeyValue
                label={tSpecs("sheet.fields.appearance")}
                value={rendered.formulation.appearance || "TBC"}
              />
              <KeyValue
                label={tSpecs("sheet.fields.filling_weight")}
                value={formatMg(rendered.totals.total_weight_mg)}
              />
              <KeyValue
                label={tSpecs("sheet.fields.total_weight")}
                value={resolveTotalWeight(rendered)}
              />
              <KeyValue
                label={tSpecs("sheet.fields.weight_uniformity")}
                value={rendered.weight_uniformity}
              />
              <KeyValue
                label={tSpecs("sheet.fields.disintegration")}
                value={rendered.formulation.disintegration_spec || "—"}
              />
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.packaging")}>
              <KeyValue
                label={tSpecs("sheet.fields.lid_description")}
                value={rendered.packaging.lid_description}
              />
              <KeyValue
                label={tSpecs("sheet.fields.bottle_pouch_tub")}
                value={rendered.packaging.bottle_pouch_tub}
              />
              <KeyValue
                label={tSpecs("sheet.fields.label_size")}
                value={rendered.packaging.label_size}
              />
              <KeyValue
                label={tSpecs("sheet.fields.antitemper")}
                value={rendered.packaging.antitemper}
              />
              <KeyValue
                label={tSpecs("sheet.fields.unit_quantity")}
                value={String(rendered.packaging.unit_quantity ?? "—")}
              />
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.compliance")}>
              <ul className="flex flex-col gap-1 font-mono text-xs text-ink-700">
                {rendered.compliance.flags.map((flag) => (
                  <li
                    key={flag.key}
                    className="flex items-center justify-between"
                  >
                    <span>{flag.label}:</span>
                    <span className="font-bold">
                      {flag.status === true
                        ? "Yes"
                        : flag.status === false
                          ? "No"
                          : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.limits")}>
              <ul className="flex flex-col gap-1 font-mono text-xs text-ink-700">
                {rendered.limits.map((limit) => (
                  <li
                    key={limit.name}
                    className="flex items-start justify-between gap-3"
                  >
                    <span className="flex-1">{limit.name}:</span>
                    <span className="text-right font-bold">
                      {limit.value}
                    </span>
                  </li>
                ))}
              </ul>
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.signatures")}>
              <SignatureBox
                label={tSpecs("sheet.signature.product_manager")}
                dateLabel={tSpecs("sheet.signature.sign_date")}
              />
              <SignatureBox
                label={tSpecs("sheet.signature.director")}
                dateLabel={tSpecs("sheet.signature.sign_date")}
              />
              <HistoryPanel
                entries={rendered.history}
                emptyLabel={tSpecs("sheet.history.empty")}
                title={tSpecs("sheet.history.title")}
                statusLabel={(key) =>
                  tSpecs(`status.${key}` as `status.draft`)
                }
              />
            </SheetSection>
          </section>

          {/* ==================================================== */}
          {/* MIDDLE COLUMN — active ingredients                    */}
          {/* ==================================================== */}
          <section className="flex flex-col gap-6">
            <SheetSection title={tSpecs("sheet.sections.actives")}>
              {rendered.actives.length === 0 ? (
                <p className="text-sm text-ink-600">—</p>
              ) : (
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="border-b-2 border-ink-1000 text-left">
                      <th className="py-2 pr-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
                        {tSpecs("sheet.columns.active_ingredient")}
                      </th>
                      <th className="py-2 px-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                        {tSpecs("sheet.columns.claim_per_serving")}
                      </th>
                      <th className="py-2 pl-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                        {tSpecs("sheet.columns.nrv")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rendered.actives.map((active) => (
                      <tr
                        key={`${active.item_internal_code}-${active.ingredient_list_name}`}
                        className="border-b border-ink-200 last:border-b-0"
                      >
                        <td className="py-2 pr-2 align-top text-sm">
                          {active.ingredient_list_name}
                        </td>
                        <td className="py-2 px-2 text-right align-top font-mono text-xs">
                          {stripTrailingZeros(active.label_claim_mg)}
                        </td>
                        <td className="py-2 pl-2 text-right align-top font-mono text-xs">
                          {active.nrv_percent
                            ? `${active.nrv_percent}%`
                            : "N/A"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.excipients")}>
              {rendered.declaration.entries.filter(
                (e) => e.category !== "active",
              ).length === 0 ? (
                <p className="text-sm text-ink-600">—</p>
              ) : (
                <ul className="flex flex-col gap-1 font-mono text-xs text-ink-700">
                  {rendered.declaration.entries
                    .filter((e) => e.category !== "active")
                    .map((entry, idx) => (
                      <li
                        key={`${entry.category}-${entry.label}-${idx}`}
                        className="flex items-center justify-between gap-3"
                      >
                        <span>{entry.label}</span>
                        <span className="text-ink-500">
                          {stripTrailingZeros(entry.mg)} mg
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.ingredients")}>
              <p className="font-serif text-sm leading-relaxed text-ink-1000">
                {rendered.declaration.text || "—"}
              </p>
            </SheetSection>
          </section>

          {/* ==================================================== */}
          {/* RIGHT COLUMN — nutrition + amino acids                */}
          {/* ==================================================== */}
          <section className="flex flex-col gap-6">
            <SheetSection title={tSpecs("sheet.sections.nutrition")}>
              {nutritionHasAnyContributor(rendered) ? (
                <p className="mb-3 font-mono text-[10px] tracking-widest uppercase text-ink-500">
                  {tSpecs("sheet.nutrition_partial_hint", {
                    count: nutritionContributorCount(rendered),
                    total: rendered.actives.length,
                  })}
                </p>
              ) : (
                <p className="mb-3 border border-ink-500 bg-ink-100 px-2 py-1 font-mono text-[10px] tracking-widest uppercase text-ink-700">
                  {tSpecs("sheet.pending_nutrition")}
                </p>
              )}
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b-2 border-ink-1000 text-left">
                    <th className="py-2 pr-2" />
                    <th className="py-2 px-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tSpecs("sheet.columns.per_100g")}
                    </th>
                    <th className="py-2 pl-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tSpecs("sheet.columns.per_serving")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {NUTRITION_ROW_KEYS.map((key) => {
                    const row = rendered.nutrition.rows.find(
                      (r) => r.key === key,
                    );
                    return (
                      <tr
                        key={key}
                        className="border-b border-ink-200 last:border-b-0"
                      >
                        <td className="py-2 pr-2 text-sm">
                          {tSpecs(
                            `nutrition_rows.${key}` as `nutrition_rows.energy_kj`,
                          )}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-xs">
                          {formatNutrientValue(row?.per_100g)}
                        </td>
                        <td className="py-2 pl-2 text-right font-mono text-xs">
                          {formatNutrientValue(row?.per_serving)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </SheetSection>

            <SheetSection title={tSpecs("sheet.sections.amino_acids")}>
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b-2 border-ink-1000 text-left">
                    <th className="py-2 pr-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tSpecs("sheet.columns.amino_acid")}
                    </th>
                    <th className="py-2 px-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tSpecs("sheet.columns.amino_per_100g")}
                    </th>
                    <th className="py-2 pl-2 text-right font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {tSpecs("sheet.columns.amino_per_serving")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {AMINO_GROUPS.map((group) => {
                    const backendGroup = rendered.amino_acids.groups.find(
                      (g) => g.key === group.key,
                    );
                    return (
                      <Fragment key={group.key}>
                        <tr className="bg-ink-100">
                          <td
                            colSpan={3}
                            className="py-1 px-2 font-mono text-[10px] tracking-widest uppercase text-ink-700"
                          >
                            {tSpecs(
                              `amino_acids.${group.key}` as `amino_acids.essential`,
                            )}
                          </td>
                        </tr>
                        {group.acids.map((acid, idx) => {
                          const row = backendGroup?.acids[idx];
                          return (
                            <tr
                              key={`${group.key}-${acid}`}
                              className="border-b border-ink-200 last:border-b-0"
                            >
                              <td className="py-2 pr-2 text-sm">{acid}</td>
                              <td className="py-2 px-2 text-right font-mono text-xs">
                                {formatNutrientValue(row?.per_100g)}
                              </td>
                              <td className="py-2 pl-2 text-right font-mono text-xs">
                                {formatNutrientValue(row?.per_serving)}
                              </td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </SheetSection>
          </section>
        </div>
      </article>
  );
}


function SheetSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-2 border-ink-1000 bg-ink-0 p-4">
      <p className="border-b-2 border-ink-1000 pb-2 font-mono text-[10px] tracking-widest uppercase text-ink-700">
        {title}
      </p>
      <div className="mt-3 flex flex-col gap-1.5">{children}</div>
    </div>
  );
}


function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-mono text-xs text-ink-700">
      <span className="text-ink-500">{label}</span>
      <span className="text-right font-bold text-ink-1000">{value}</span>
    </div>
  );
}


function HistoryPanel({
  entries,
  title,
  emptyLabel,
  statusLabel,
}: {
  entries: readonly RenderedTransition[];
  title: string;
  emptyLabel: string;
  statusLabel: (key: SpecificationStatus) => string;
}) {
  if (entries.length === 0) {
    return (
      <p className="mt-3 font-mono text-[10px] tracking-widest uppercase text-ink-500">
        {emptyLabel}
      </p>
    );
  }
  return (
    <div className="mt-4">
      <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
        {title}
      </p>
      <ul className="mt-2 flex flex-col gap-2 border-t border-ink-500 pt-2 font-mono text-[10px] text-ink-700">
        {entries.map((entry) => (
          <li key={entry.id} className="flex flex-col gap-0.5">
            <span className="tracking-widest uppercase">
              {statusLabel(entry.from_status)} → {statusLabel(entry.to_status)}
            </span>
            <span className="text-ink-500">
              {entry.actor_name} · {formatTimestamp(entry.created_at)}
            </span>
            {entry.notes ? (
              <span className="text-ink-700 italic normal-case tracking-normal">
                {entry.notes}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * Deterministic UTC timestamp formatter.
 *
 * We intentionally do *not* use ``toLocaleString`` — its output depends
 * on the runtime's default locale and timezone, which differs between
 * the Node SSR process and the user's browser, and produces hydration
 * mismatches on the public preview page. Rendering in UTC with a
 * hand-picked format keeps server and client byte-identical and also
 * matches the PDF output, so a scientist comparing the three surfaces
 * sees the same stamp in every place.
 */
const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTH_ABBREVIATIONS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hour}:${minute} UTC`;
}


function SignatureBox({
  label,
  dateLabel,
}: {
  label: string;
  dateLabel: string;
}) {
  return (
    <div className="mt-3">
      <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
        {label}
      </p>
      <div className="mt-2 h-12 border-b border-ink-1000" />
      <p className="mt-2 font-mono text-[10px] tracking-widest uppercase text-ink-500">
        {dateLabel}
      </p>
      <div className="mt-2 h-4 border-b border-ink-1000" />
    </div>
  );
}


function formatMg(value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return "—";
  return `${parsed.toFixed(2)} mg`;
}


/** Resolve the Total Weight (mg) cell.
 *
 * Priority: explicit sheet override → computed filled-capsule weight
 * (fill + shell for capsules, fill only for tablets/powder/gummy/
 * liquid) → "TBC" when neither is available. Keeping the override as
 * the highest-priority lane lets a scientist stamp a measured weight
 * once the manufacturer confirms the exact shell supplied.
 */
function resolveTotalWeight(rendered: RenderedSheetContext): string {
  const override = (rendered.sheet.total_weight_label ?? "").trim();
  if (override !== "") return override;
  const computed = formatMg(rendered.totals.filled_total_mg);
  if (computed !== "—") return computed;
  return "TBC";
}


function stripTrailingZeros(value: string): string {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return value;
  // Trim trailing zeros but keep at most two decimals for readability.
  return parsed.toFixed(2).replace(/\.?0+$/, "");
}


/**
 * Format a nutrient value for display. Zero shows as a greyed ``0`` so
 * rows with no contribution visually fade; non-zero values render
 * with two decimals and a normal ink colour. Missing values (row
 * absent from the backend payload entirely) also fall through to a
 * greyed zero — defensive for any snapshot that somehow skipped the
 * backfill migration.
 */
function formatNutrientValue(raw: string | null | undefined): React.ReactNode {
  if (raw === null || raw === undefined) {
    return <span className="text-ink-500">0</span>;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed === 0) {
    return <span className="text-ink-500">0</span>;
  }
  return parsed.toFixed(2).replace(/\.?0+$/, "");
}


/** True when *any* nutrition / amino row on the rendered context has
 * at least one contributing ingredient. Drives the "partial data"
 * vs "pending data" hint above the nutrition table. */
function nutritionHasAnyContributor(
  rendered: RenderedSheetContext,
): boolean {
  const n = rendered.nutrition.rows.some((r) => r.contributors > 0);
  const a = rendered.amino_acids.groups.some((g) =>
    g.acids.some((r) => r.contributors > 0),
  );
  return n || a;
}

/** Greatest contributor count across any nutrition row. Approximates
 * "how many of the actives had catalogue data". */
function nutritionContributorCount(rendered: RenderedSheetContext): number {
  let max = 0;
  for (const row of rendered.nutrition.rows) {
    if (row.contributors > max) max = row.contributors;
  }
  for (const group of rendered.amino_acids.groups) {
    for (const row of group.acids) {
      if (row.contributors > max) max = row.contributors;
    }
  }
  return max;
}


function extractErrorMessage(
  error: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (error instanceof ApiError) {
    for (const codes of Object.values(error.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}
