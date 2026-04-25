"use client";

/**
 * Rendered specification sheet — one HTML document per sheet,
 * signable inline. Replaces the WeasyPrint PDF render so the page
 * and the kiosk read from exactly the same React component.
 *
 * Content is driven by :type:`RenderedSheetContext`, the backend's
 * flat view-model. Sections that the snapshot leaves empty (no
 * nutrition rows, no compliance flags, no amino-acid panel on a
 * non-protein product) collapse entirely so a lean capsule sheet
 * doesn't render empty scaffolding.
 */

import { useTranslations } from "next-intl";

import type { RenderedSheetContext } from "@/services/specifications";

import { InlineSignatureBlock } from "./inline-signature-block";


interface Props {
  readonly context: RenderedSheetContext;
  /** Inline signature capture — provided by the kiosk, omitted on
   *  the staff preview (read-only). */
  readonly onCustomerSign?: (dataUrl: string) => Promise<void> | void;
  readonly customerBusy?: boolean;
  readonly customerError?: string | null;
  readonly customerLocked?: boolean;
}


export function SpecSheetCard({
  context,
  onCustomerSign,
  customerBusy = false,
  customerError = null,
  customerLocked = false,
}: Props) {
  const tSpec = useTranslations("specifications.card");
  const tCommon = useTranslations("common");

  const { sheet, signatures, formulation, totals, actives, compliance } =
    context;

  const nutritionRows = context.nutrition.rows;
  const declaration = context.declaration;

  const title =
    formulation.name ||
    sheet.client_company ||
    tSpec("document_label");

  const kindLabel =
    sheet.document_kind === "final"
      ? tSpec("kind.final")
      : tSpec("kind.draft");

  return (
    <article className="flex flex-col gap-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 print:shadow-none print:ring-0 md:p-10">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-200 pb-6">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tSpec("document_label")}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {title}
          </h1>
          <p className="text-sm text-ink-600">
            {[
              sheet.code,
              formulation.code,
              `v${formulation.version_number}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              sheet.document_kind === "final"
                ? "inline-flex items-center rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30"
                : "inline-flex items-center rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-200"
            }
          >
            {kindLabel}
          </span>
        </div>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Product specification                                               */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
          {tSpec("section.product_spec")}
        </h2>
        <SpecGrid
          rows={[
            {
              label: tSpec("field.dosage_form"),
              value: humaniseDosageForm(formulation.dosage_form),
            },
            {
              label: tSpec("field.serving_size"),
              value: formatServing(
                formulation.serving_size,
                formulation.dosage_form,
              ),
            },
            {
              label: tSpec("field.servings_per_pack"),
              value:
                sheet.unit_quantity ||
                (formulation.servings_per_pack
                  ? String(formulation.servings_per_pack)
                  : "—"),
            },
            {
              label: tSpec("field.directions"),
              value: formulation.directions_of_use,
            },
            {
              label: tSpec("field.suggested_dosage"),
              value: formulation.suggested_dosage,
            },
            {
              label: tSpec("field.appearance"),
              value: formulation.appearance,
            },
            {
              label: tSpec("field.disintegration"),
              value: formulation.disintegration_spec,
            },
            {
              label: tSpec("field.shelf_life"),
              value: sheet.shelf_life,
            },
            {
              label: tSpec("field.storage"),
              value: sheet.storage_conditions,
            },
            {
              label: tSpec("field.food_contact"),
              value: sheet.food_contact_status,
            },
            {
              label: tSpec("field.size_label"),
              value: totals.size_label,
            },
            {
              label: tSpec("field.total_weight"),
              value: formatMg(totals.filled_total_mg ?? totals.total_weight_mg),
            },
          ].filter((r) => Boolean(r.value))}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Actives                                                             */}
      {/* ------------------------------------------------------------------ */}
      {actives.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tSpec("section.actives")}
          </h2>
          <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-ink-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-50 text-[11px] uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-3 py-2">
                    {tSpec("actives.col_ingredient")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {tSpec("actives.col_label_claim")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {tSpec("actives.col_raw_mg")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {tSpec("actives.col_nrv")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {actives.map((active, idx) => (
                  <tr key={`${active.item_internal_code}-${idx}`}>
                    <td className="px-3 py-2 text-ink-1000">
                      {active.ingredient_list_name || active.item_name}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                      {active.label_claim_mg
                        ? `${active.label_claim_mg} mg`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                      {active.mg_per_serving
                        ? `${formatMg(active.mg_per_serving)}`
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                      {active.nrv_percent ? `${active.nrv_percent}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Excipients (capsule/tablet only)                                    */}
      {/* ------------------------------------------------------------------ */}
      {totals.excipients ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tSpec("section.excipients")}
          </h2>
          <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-ink-200">
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-ink-100">
                {excipientTableRows(totals.excipients, (key) =>
                  tSpec(`excipients.${key}` as const),
                ).map((row) => {
                  const total =
                    totals.filled_total_mg ?? totals.total_weight_mg;
                  const pct = percentOfTotal(row.mg, total);
                  return (
                    <tr key={row.key}>
                      <td className="px-3 py-2 text-ink-1000">{row.label}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                        {formatMg(row.mg)}
                        {pct !== null ? (
                          <span className="ml-1 text-ink-500">
                            ({pct}%)
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Nutrition facts                                                     */}
      {/* ------------------------------------------------------------------ */}
      {nutritionRows.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tSpec("section.nutrition")}
          </h2>
          <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-ink-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-50 text-[11px] uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-3 py-2">{tSpec("nutrition.col_nutrient")}</th>
                  <th className="px-3 py-2 text-right">
                    {tSpec("nutrition.col_per_serving")}
                  </th>
                  <th className="px-3 py-2 text-right">
                    {tSpec("nutrition.col_per_100g")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {nutritionRows.map((row) => (
                  <tr key={row.key}>
                    <td className="px-3 py-2 capitalize text-ink-1000">
                      {row.key.replaceAll("_", " ")}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                      {row.per_serving}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink-700">
                      {row.per_100g}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Compliance chips                                                    */}
      {/* ------------------------------------------------------------------ */}
      {compliance.flags.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tSpec("section.compliance")}
          </h2>
          <div className="flex flex-wrap gap-2">
            {compliance.flags.map((flag) => (
              <ComplianceChip
                key={flag.key}
                label={flag.label}
                status={flag.status}
                yesLabel={tSpec("compliance.yes")}
                noLabel={tSpec("compliance.no")}
                unknownLabel={tSpec("compliance.unknown")}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Ingredient declaration                                              */}
      {/* ------------------------------------------------------------------ */}
      {declaration.text ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tSpec("section.declaration")}
          </h2>
          <p className="rounded-xl bg-ink-50 p-4 text-sm leading-relaxed text-ink-700 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
            {declaration.text}
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Cover notes                                                         */}
      {/* ------------------------------------------------------------------ */}
      {sheet.cover_notes ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tSpec("section.cover_notes")}
          </h2>
          <p className="whitespace-pre-wrap rounded-xl bg-ink-50 p-4 text-sm leading-relaxed text-ink-700 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
            {sheet.cover_notes}
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Signatures                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ReadOnlySignature
          title={tSpec("signature.prepared_by")}
          name={signatures.prepared_by?.name ?? null}
          signedAt={signatures.prepared_by?.signed_at ?? null}
          image={signatures.prepared_by?.image ?? null}
          emptyLabel={tSpec("signature.awaiting")}
        />
        <ReadOnlySignature
          title={tSpec("signature.director")}
          name={signatures.director?.name ?? null}
          signedAt={signatures.director?.signed_at ?? null}
          image={signatures.director?.image ?? null}
          emptyLabel={tSpec("signature.awaiting")}
        />
        {onCustomerSign ? (
          <InlineSignatureBlock
            title={tSpec("signature.customer")}
            hint={tSpec("signature.customer_hint")}
            signedLabel={tSpec("signature.signed_badge")}
            signedOnLabel={(iso) =>
              tSpec("signature.signed_on", { date: formatDate(iso) })
            }
            signBtnLabel={tSpec("signature.sign_cta")}
            resignBtnLabel={tSpec("signature.resign_cta")}
            clearBtnLabel={tCommon("actions.cancel")}
            busy={customerBusy}
            errorMessage={customerError}
            capturedImage={signatures.customer.image || null}
            capturedAt={signatures.customer.signed_at}
            capturedName={
              signatures.customer.name ||
              signatures.customer.company ||
              null
            }
            locked={customerLocked}
            onSign={onCustomerSign}
          />
        ) : (
          <ReadOnlySignature
            title={tSpec("signature.customer")}
            name={signatures.customer.name || signatures.customer.company}
            signedAt={signatures.customer.signed_at}
            image={signatures.customer.image || null}
            emptyLabel={tSpec("signature.awaiting")}
          />
        )}
      </section>
    </article>
  );
}


function SpecGrid({
  rows,
}: {
  rows: readonly { label: string; value: string | number | null }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 rounded-xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200 sm:grid-cols-2 print:bg-transparent print:ring-0">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex flex-col gap-0.5 border-b border-ink-100 pb-2 last:border-b-0 print:border-ink-200"
        >
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
            {row.label}
          </dt>
          <dd className="text-sm text-ink-1000">{row.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}


function ComplianceChip({
  label,
  status,
  yesLabel,
  noLabel,
  unknownLabel,
}: {
  label: string;
  status: boolean | null;
  yesLabel: string;
  noLabel: string;
  unknownLabel: string;
}) {
  const { bg, ring, color, text } =
    status === true
      ? {
          bg: "bg-success/10",
          ring: "ring-success/30",
          color: "text-success",
          text: yesLabel,
        }
      : status === false
        ? {
            bg: "bg-danger/10",
            ring: "ring-danger/30",
            color: "text-danger",
            text: noLabel,
          }
        : {
            bg: "bg-ink-100",
            ring: "ring-ink-200",
            color: "text-ink-600",
            text: unknownLabel,
          };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${bg} ${ring} ${color}`}
    >
      <span className="font-semibold">{label}:</span> {text}
    </span>
  );
}


function ReadOnlySignature({
  title,
  name,
  signedAt,
  image,
  emptyLabel,
}: {
  title: string;
  name: string | null;
  signedAt: string | null;
  image: string | null;
  emptyLabel: string;
}) {
  const present = Boolean(image && signedAt);
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-ink-0 p-4 ring-1 ring-inset ring-ink-200 print:bg-transparent">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        {title}
      </p>
      {present ? (
        <>
          <div className="flex h-24 items-center justify-center rounded-lg bg-ink-50 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
            <img
              src={image!}
              alt={title}
              className="max-h-20 max-w-full object-contain"
            />
          </div>
          {name ? (
            <p className="text-xs font-medium text-ink-1000">{name}</p>
          ) : null}
          <p className="text-[11px] text-ink-500">{formatDate(signedAt)}</p>
        </>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-lg bg-ink-50 text-xs text-ink-500 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}


type ExcipientI18nKey =
  | "mg_stearate"
  | "silica"
  | "mcc"
  | "dcp"
  | "gummy_base"
  | "water";


interface SpecExcipientRow {
  readonly key: string;
  readonly label: string;
  readonly mg: string;
}


/** Build the ordered list of rows the spec's Excipient table renders.
 *
 * Capsule / tablet sheets have a fixed set of columns (mg stearate /
 * silica / mcc / dcp). Gummy sheets lead with the blend (one row per
 * picked item, labelled by EU category) followed by water; they
 * suppress the capsule fields. Powder sheets fall through to the
 * flexible ``rows`` list. Returning a flat ``{key,label,mg}`` array
 * keeps the caller trivial — no branching in JSX land. */
function excipientTableRows(
  excipients: Exclude<
    RenderedSheetContext["totals"]["excipients"],
    null
  >,
  tExcipient: (key: ExcipientI18nKey) => string,
): readonly SpecExcipientRow[] {
  const rows: SpecExcipientRow[] = [];
  const gummyRows = excipients.gummy_base_rows ?? [];
  if (gummyRows.length > 0) {
    // Collapse picks sharing the same ``use_as`` into one grouped
    // entry per EU label convention — "Sweeteners (Xylitol, Maltitol)"
    // reads as a single row even when three items are bound.
    const groups = new Map<
      string,
      { use_as: string; labels: string[]; mg: number }
    >();
    for (const row of gummyRows) {
      const key = row.use_as || row.item_id;
      const partMg = Number(row.mg) || 0;
      const existing = groups.get(key);
      if (existing) {
        existing.labels.push(row.label);
        existing.mg += partMg;
      } else {
        groups.set(key, {
          use_as: row.use_as,
          labels: [row.label],
          mg: partMg,
        });
      }
    }
    for (const [key, group] of groups) {
      rows.push({
        key: `gummy:${key}`,
        label: group.use_as
          ? `${group.use_as} (${group.labels.join(", ")})`
          : group.labels.join(", "),
        mg: String(group.mg),
      });
    }
  } else if (excipients.gummy_base_mg) {
    rows.push({
      key: "gummy_base",
      label: tExcipient("gummy_base"),
      mg: excipients.gummy_base_mg,
    });
  }
  if (excipients.water_mg) {
    rows.push({
      key: "water",
      label: tExcipient("water"),
      mg: excipients.water_mg,
    });
  }
  // Capsule / tablet typed fields — suppressed when the sheet is a
  // gummy (gummyRows present) because those surfaces aren't relevant.
  const hasGummyContent = rows.length > 0;
  if (!hasGummyContent) {
    if (excipients.mg_stearate_mg) {
      rows.push({
        key: "mg_stearate",
        label: tExcipient("mg_stearate"),
        mg: excipients.mg_stearate_mg,
      });
    }
    if (excipients.silica_mg) {
      rows.push({
        key: "silica",
        label: tExcipient("silica"),
        mg: excipients.silica_mg,
      });
    }
    if (excipients.mcc_mg) {
      rows.push({
        key: "mcc",
        label: tExcipient("mcc"),
        mg: excipients.mcc_mg,
      });
    }
    if (excipients.dcp_mg) {
      rows.push({
        key: "dcp",
        label: tExcipient("dcp"),
        mg: excipients.dcp_mg,
      });
    }
  }
  return rows;
}


function formatMg(value: string | null | undefined): string {
  if (!value) return "";
  const num = Number(value);
  if (!Number.isFinite(num)) return `${value} mg`;
  return `${num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} mg`;
}


/** Percentage of the filled gummy / capsule total. Rounds to one
 *  decimal so small excipients (5.5% water) don't collapse to "6%"
 *  but a 65% gummy base also doesn't read as "65.0000%". Returns
 *  ``null`` when either input is missing so the caller can suppress
 *  the suffix cleanly. */
function percentOfTotal(
  value: string | null | undefined,
  total: string | null | undefined,
): string | null {
  if (!value || !total) return null;
  const partNum = Number(value);
  const totalNum = Number(total);
  if (
    !Number.isFinite(partNum) ||
    !Number.isFinite(totalNum) ||
    totalNum <= 0
  ) {
    return null;
  }
  return ((partNum / totalNum) * 100).toFixed(1);
}


function humaniseDosageForm(dosage: string): string {
  if (!dosage) return "";
  return dosage.charAt(0).toUpperCase() + dosage.slice(1).toLowerCase();
}


function formatServing(
  size: number | null | undefined,
  dosage: string,
): string {
  if (!size) return "";
  const suffix = dosage === "powder" ? "scoop(s)" : "unit(s)";
  return `${size} ${suffix}`;
}


function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
