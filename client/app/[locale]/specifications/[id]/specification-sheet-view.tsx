"use client";

import { Button } from "@heroui/react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  Download,
  Eye,
  EyeOff,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { CommentsPanel } from "@/components/comments";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { translateCode } from "@/lib/errors/translate";
import type { OrganizationDto } from "@/services/organizations/types";
import {
  ALLOWED_TRANSITIONS,
  specificationsEndpoints,
  useDeleteSpecification,
  useRenderedSpecification,
  useSetSpecificationVisibility,
  useTransitionSpecificationStatus,
  type RenderedSheetContext,
  type RenderedTransition,
  type SpecificationSheetDto,
  type SpecificationStatus,
} from "@/services/specifications";
import { EditDetailsButton } from "./edit-details-button";
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
  rendered: initialRendered,
  canWrite,
  canAdmin,
  canManageVisibility,
  organization,
  currentUserId,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
  rendered: RenderedSheetContext;
  canWrite: boolean;
  canAdmin: boolean;
  canManageVisibility: boolean;
  organization: OrganizationDto;
  currentUserId: string;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Hydrate the client-side cache from the SSR-fetched payload so
  // the first paint is identical to what the server rendered, then
  // switch to the live cache so mutations — specifically
  // ``useSetSpecificationVisibility`` — repaint the sheet the moment
  // the server acknowledges the write, without a route refresh.
  const renderedQuery = useRenderedSpecification(orgId, sheet.id, {
    initialData: initialRendered,
  });
  const rendered = renderedQuery.data ?? initialRendered;

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
      // Specs belong to projects, so bounce back to the parent
      // project's Spec sheets tab rather than the (now removed)
      // global list.
      router.push(`/formulations/${rendered.formulation.id}/spec-sheets`);
    } catch (err) {
      setErrorMessage(extractErrorMessage(err, tErrors));
    }
  };

  const isBusy =
    transitionMutation.isPending || deleteMutation.isPending;

  return (
    <div className="mt-6 flex flex-col gap-5 md:mt-8">
      {/* ------------------------------------------------------------ */}
      {/* Back-link to the parent project — hidden when printing         */}
      {/* ------------------------------------------------------------ */}
      <Link
        href={`/formulations/${rendered.formulation.id}/spec-sheets`}
        className="inline-flex w-fit items-center gap-1 text-xs font-medium text-ink-500 transition-colors hover:text-ink-1000 print:hidden"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {rendered.formulation.name}
      </Link>

      {/* ------------------------------------------------------------ */}
      {/* Top action bar — hidden when printing                         */}
      {/* ------------------------------------------------------------ */}
      <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink-0 px-4 py-3 shadow-sm ring-1 ring-ink-200 print:hidden">
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tSpecs("detail.status_label")}
          </span>
          <SpecStatusChip status={sheet.status} tSpecs={tSpecs} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canWrite
            ? allowedNext.map((next) => (
                <Button
                  key={next}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
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
            on same-origin navigation.
          */}
          <a
            href={specificationsEndpoints.pdf(orgId, sheet.id, {
              download: true,
            })}
            download
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
          >
            <Download className="h-4 w-4" />
            {tSpecs("detail.download_pdf")}
          </a>
          {canWrite ? (
            <EditDetailsButton orgId={orgId} sheet={sheet} />
          ) : null}
          {canWrite ? (
            <EditPackagingButton orgId={orgId} sheet={sheet} />
          ) : null}
          {canManageVisibility ? (
            <VisibilityMenu
              orgId={orgId}
              sheetId={sheet.id}
              visibility={rendered.visibility ?? {}}
              order={rendered.section_order ?? []}
            />
          ) : null}
          {canWrite ? (
            <SharePublicLinkButton orgId={orgId} sheet={sheet} />
          ) : null}
          {canAdmin ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              className="rounded-lg bg-danger/10 px-3 py-2 font-medium text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger/15"
              isDisabled={isBusy}
              onClick={handleDelete}
            >
              <span className="inline-flex items-center gap-1.5">
                <Trash2 className="h-4 w-4" />
                {tSpecs("detail.delete")}
              </span>
            </Button>
          ) : null}
        </div>
      </section>

      {errorMessage ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20 print:hidden"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* The spec sheet itself                                         */}
      {/* ------------------------------------------------------------ */}
      <SpecSheetContent rendered={rendered} />

      {/* ------------------------------------------------------------ */}
      {/* Comments panel — org-only, hidden when printing               */}
      {/* ------------------------------------------------------------ */}
      <div className="print:hidden">
        <CommentsPanel
          orgId={orgId}
          entityKind="specification"
          entityId={sheet.id}
          canRead={hasFlatCapability(
            organization,
            "formulations",
            "comments_view",
          )}
          canWrite={hasFlatCapability(
            organization,
            "formulations",
            "comments_write",
          )}
          canModerate={hasFlatCapability(
            organization,
            "formulations",
            "comments_moderate",
          )}
          currentUserId={currentUserId}
        />
      </div>
    </div>
  );
}


function SpecStatusChip({
  status,
  tSpecs,
}: {
  status: SpecificationStatus;
  tSpecs: ReturnType<typeof useTranslations<"specifications">>;
}) {
  const map: Record<
    SpecificationStatus,
    { classes: string; icon: ReactNode }
  > = {
    draft: {
      classes: "bg-ink-100 text-ink-700 ring-ink-200",
      icon: <Sparkles className="h-3.5 w-3.5" />,
    },
    in_review: {
      classes: "bg-info/10 text-info ring-info/20",
      icon: <Sparkles className="h-3.5 w-3.5" />,
    },
    approved: {
      classes: "bg-success/10 text-success ring-success/20",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    },
    sent: {
      classes: "bg-orange-50 text-orange-700 ring-orange-200",
      icon: <Send className="h-3.5 w-3.5" />,
    },
    accepted: {
      classes: "bg-success/10 text-success ring-success/20",
      icon: <CheckCircle2 className="h-3.5 w-3.5" />,
    },
    rejected: {
      classes: "bg-danger/10 text-danger ring-danger/20",
      icon: <AlertTriangle className="h-3.5 w-3.5" />,
    },
  };
  const s = map[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${s.classes}`}
    >
      {s.icon}
      {tSpecs(`status.${status}` as "status.draft")}
    </span>
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

  const visibility = rendered.visibility ?? {};
  const order = rendered.section_order ?? [];

  // Each section renders through this dictionary so the top-down
  // sequence is a pure function of ``section_order`` + visibility —
  // reordering and hiding both reduce to the same walk.
  const renderers: Record<string, () => ReactNode> = {
    product_specification: () => (
      <>
        <SectionTitle>
          {tSpecs("sheet.sections.specification")}
        </SectionTitle>
        <SpecTable>
          <SpecRow
            label={tSpecs("sheet.fields.direction_of_use")}
            value={rendered.formulation.directions_of_use || "—"}
          />
          <SpecRow
            label={tSpecs("sheet.fields.suggested_dosage")}
            value={rendered.formulation.suggested_dosage || "—"}
          />
          <SpecRow
            label={tSpecs("sheet.fields.dosage_form")}
            value={
              rendered.formulation.dosage_form
                ? tSpecs(
                    `dosage_forms.${rendered.formulation.dosage_form}` as `dosage_forms.capsule`,
                  )
                : "—"
            }
          />
          <SpecRow
            label={tSpecs("sheet.fields.appearance")}
            value={rendered.formulation.appearance || "TBC"}
          />
          <SpecRow
            label={tSpecs("sheet.fields.filling_weight")}
            value={formatMg(rendered.totals.total_weight_mg)}
          />
          <SpecRow
            label={tSpecs("sheet.fields.total_weight")}
            value={resolveTotalWeight(rendered)}
          />
          <SpecRow
            label={tSpecs("sheet.fields.weight_uniformity")}
            value={rendered.weight_uniformity}
          />
          <SpecRow
            label={tSpecs("sheet.fields.disintegration")}
            value={rendered.formulation.disintegration_spec || "—"}
          />
        </SpecTable>
      </>
    ),
    packaging_specification: () => (
      <>
        <SectionTitle>
          {tSpecs("sheet.sections.packaging")}
        </SectionTitle>
        <SpecTable>
          <SpecRow
            label={tSpecs("sheet.fields.lid_description")}
            value={rendered.packaging.lid_description}
          />
          <SpecRow
            label={tSpecs("sheet.fields.bottle_pouch_tub")}
            value={rendered.packaging.bottle_pouch_tub}
          />
          <SpecRow
            label={tSpecs("sheet.fields.label_size")}
            value={rendered.packaging.label_size}
          />
          <SpecRow
            label={tSpecs("sheet.fields.antitemper")}
            value={rendered.packaging.antitemper}
          />
          {rendered.packaging.unit_quantity ? (
            <SpecRow
              label={tSpecs("sheet.fields.unit_quantity")}
              value={String(rendered.packaging.unit_quantity)}
            />
          ) : null}
          {rendered.packaging.food_contact_status ? (
            <SpecRow
              label={tSpecs("sheet.fields.food_contact_status")}
              value={rendered.packaging.food_contact_status}
            />
          ) : null}
          {rendered.packaging.shelf_life ? (
            <SpecRow
              label={tSpecs("sheet.fields.shelf_life")}
              value={rendered.packaging.shelf_life}
            />
          ) : null}
          {rendered.packaging.storage_conditions ? (
            <SpecRow
              label={tSpecs("sheet.fields.storage_conditions")}
              value={rendered.packaging.storage_conditions}
            />
          ) : null}
        </SpecTable>
      </>
    ),
    compliance: () => (
      <SpecTable className="mt-4">
        {rendered.compliance.flags.map((flag) => (
          <SpecRow
            key={flag.key}
            label={flag.label}
            value={
              flag.status === true
                ? "Yes"
                : flag.status === false
                  ? "No"
                  : "—"
            }
          />
        ))}
      </SpecTable>
    ),
    allergens: () => (
      <>
        <SectionTitle>
          {tSpecs("sheet.sections.allergens")}
        </SectionTitle>
        {rendered.allergens.sources.length > 0 ? (
          <div className="border border-ink-1000 p-3 font-serif text-[11px] leading-relaxed text-ink-1000">
            <p>
              <strong>{tSpecs("sheet.allergens.prefix")}: </strong>
              {rendered.allergens.sources.join(", ")}
            </p>
            <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-500">
              {tSpecs("sheet.allergens.count", {
                count: rendered.allergens.allergen_count,
              })}
            </p>
          </div>
        ) : (
          <div className="border border-ink-1000 p-3 text-center font-serif text-[11px] text-ink-700">
            {tSpecs("sheet.allergens.none")}
          </div>
        )}
      </>
    ),
    safety_limits: () => (
      <>
        <SectionTitle>{tSpecs("sheet.sections.limits")}</SectionTitle>
        <SpecTable>
          {rendered.limits.map((limit) => (
            <SpecRow
              key={limit.slug ?? limit.name}
              label={limit.name}
              value={limit.value}
            />
          ))}
        </SpecTable>
      </>
    ),
    signatures: () => (
      <>
        <SectionTitle>
          {tSpecs("sheet.sections.signatures")}
        </SectionTitle>
        <div className="flex flex-col gap-6">
          <SignatureLine role={tSpecs("sheet.signature.prepared_by")} />
          <SignatureLine role={tSpecs("sheet.signature.director")} />
          <SignatureLine role={tSpecs("sheet.signature.customer")} />
        </div>
        <HistoryPanel
          entries={rendered.history}
          emptyLabel={tSpecs("sheet.history.empty")}
          title={tSpecs("sheet.history.title")}
          statusLabel={(key) =>
            tSpecs(`status.${key}` as `status.draft`)
          }
        />
      </>
    ),
    actives: () =>
      rendered.actives.length > 0 ? (
        <>
          <SectionTitle>
            {tSpecs("sheet.sections.actives")}
          </SectionTitle>
          <table className="w-full border-collapse border border-ink-1000 text-[11px]">
            <thead>
              <tr>
                <DataTh>
                  {tSpecs("sheet.columns.active_ingredient")}
                </DataTh>
                <DataTh center>
                  {tSpecs("sheet.columns.claim_per_serving")}
                </DataTh>
                <DataTh center>{tSpecs("sheet.columns.nrv")}</DataTh>
              </tr>
            </thead>
            <tbody>
              {rendered.actives.map((active, idx) => (
                <tr
                  key={`${active.item_internal_code}-${active.ingredient_list_name}-${idx}`}
                >
                  <DataTd>{active.ingredient_list_name}</DataTd>
                  <DataTd center>
                    {stripTrailingZeros(active.label_claim_mg)}
                  </DataTd>
                  <DataTd center>
                    {active.nrv_percent
                      ? `${active.nrv_percent}%`
                      : "N/A"}
                  </DataTd>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null,
    nutrition: () => (
      <>
        <SectionTitle>
          {tSpecs("sheet.sections.nutrition")}
        </SectionTitle>
        <table className="w-full border-collapse border border-ink-1000 text-[11px]">
          <thead>
            <tr>
              <DataTh>{tSpecs("sheet.columns.active_ingredient")}</DataTh>
              <DataTh center>{tSpecs("sheet.columns.per_100g")}</DataTh>
              <DataTh center>
                {tSpecs("sheet.columns.per_serving")}
              </DataTh>
            </tr>
          </thead>
          <tbody>
            {NUTRITION_ROW_KEYS.map((key) => {
              const row = rendered.nutrition.rows.find(
                (r) => r.key === key,
              );
              return (
                <tr key={key}>
                  <DataTd>
                    {tSpecs(
                      `nutrition_rows.${key}` as `nutrition_rows.energy_kj`,
                    )}
                  </DataTd>
                  <DataTd center>{formatNutrientValue(row?.per_100g)}</DataTd>
                  <DataTd center>
                    {formatNutrientValue(row?.per_serving)}
                  </DataTd>
                </tr>
              );
            })}
          </tbody>
        </table>
      </>
    ),
    amino_acids: () => (
      <>
        <SectionTitle>
          {tSpecs("sheet.sections.amino_acids")}
        </SectionTitle>
        <table className="w-full border-collapse border border-ink-1000 text-[11px]">
          <thead>
            <tr>
              <DataTh>{tSpecs("sheet.columns.amino_acid")}</DataTh>
              <DataTh center>
                {tSpecs("sheet.columns.amino_per_100g")}
              </DataTh>
              <DataTh center>
                {tSpecs("sheet.columns.amino_per_serving")}
              </DataTh>
            </tr>
          </thead>
          <tbody>
            {AMINO_GROUPS.map((group) => {
              const backendGroup = rendered.amino_acids.groups.find(
                (g) => g.key === group.key,
              );
              return (
                <Fragment key={group.key}>
                  <tr>
                    <td
                      colSpan={3}
                      className="border border-ink-1000 bg-[#ffc000] px-2 py-1 text-center font-bold"
                    >
                      {tSpecs(
                        `amino_acids.${group.key}` as `amino_acids.essential`,
                      )}
                    </td>
                  </tr>
                  {group.acids.map((acid, idx) => {
                    const row = backendGroup?.acids[idx];
                    return (
                      <tr key={`${group.key}-${acid}`}>
                        <DataTd>{acid}</DataTd>
                        <DataTd center>
                          {formatNutrientValue(row?.per_100g)}
                        </DataTd>
                        <DataTd center>
                          {formatNutrientValue(row?.per_serving)}
                        </DataTd>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </>
    ),
    excipients: () => {
      const excipientEntries = rendered.declaration.entries.filter(
        (e) => e.category !== "active",
      );
      // Suppress the section entirely when the snapshot has no
      // excipient rows — prevents a naked "Excipient Information"
      // header with an empty table on old snapshots saved before
      // the powder / gummy flavour system landed.
      if (excipientEntries.length === 0) return null;
      return (
        <>
          <SectionTitle>
            {tSpecs("sheet.sections.excipients")}
          </SectionTitle>
          <table className="w-full border-collapse border border-ink-1000 text-[11px]">
            <thead>
              <tr>
                <DataTh>{tSpecs("sheet.columns.excipients")}</DataTh>
                <DataTh center>{tSpecs("sheet.columns.mg_per_unit")}</DataTh>
              </tr>
            </thead>
            <tbody>
              {excipientEntries.map((entry, idx) => (
                <tr key={`${entry.category}-${entry.label}-${idx}`}>
                  <DataTd>{entry.label}</DataTd>
                  <DataTd center>{stripTrailingZeros(entry.mg)}</DataTd>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
    },
    ingredients: () =>
      rendered.declaration.text ? (
        <>
          <SectionTitle>
            {tSpecs("sheet.sections.ingredients")}
          </SectionTitle>
          <div className="border border-ink-1000 p-4 text-center text-[11px] leading-relaxed">
            <IngredientDeclarationBody rendered={rendered} />
          </div>
        </>
      ) : null,
  };

  // Safety net: if ``section_order`` arrived empty (very old sheet or
  // network payload shape drift), fall back to the dictionary's own
  // key order so nothing ever disappears silently.
  const effectiveOrder =
    order.length > 0 ? order : (Object.keys(renderers) as string[]);

  return (
    <article
      className="relative mx-auto max-w-[820px] bg-ink-0 px-6 py-8 text-ink-1000 md:px-12 md:py-12 print:px-0 print:py-0"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      {rendered.watermark ? <DraftWatermark /> : null}

      <div className="relative z-10">
        <header className="flex items-center justify-between text-[11px]">
          <span>{rendered.sheet.code || "—"}</span>
          <span>{formatHeaderDate(rendered.sheet.updated_at)}</span>
        </header>

        <h1 className="mt-6 text-center text-lg font-bold md:text-xl">
          {rendered.watermark ? "DRAFT " : ""}
          {tSpecs("sheet.title")}
        </h1>

        <SpecTable className="mt-6">
          <SpecRow
            label={tSpecs("sheet.fields.product_code")}
            value={
              rendered.sheet.code || rendered.formulation.code || "—"
            }
          />
          <SpecRow
            label={tSpecs("sheet.fields.product_description")}
            value={rendered.formulation.name}
          />
        </SpecTable>

        {effectiveOrder.map((slug) => {
          if (visibility[slug] === false) return null;
          const render = renderers[slug];
          if (!render) return null;
          return <Fragment key={slug}>{render()}</Fragment>;
        })}
      </div>
    </article>
  );
}

/** Label / value row in a reference-look spec table. Left cell is
 *  the saturated yellow header the Valley workbook uses; right cell
 *  is plain white and center-aligned. */
function SpecRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td className="w-[44%] border border-ink-1000 bg-[#ffc000] px-2 py-1 align-middle font-bold">
        {label}
      </td>
      <td className="border border-ink-1000 px-2 py-1 text-center align-middle">
        {value || "—"}
      </td>
    </tr>
  );
}

/** Outer wrapper for a stack of :component:`SpecRow`\ s. Rendered as
 *  a single ``<table>`` so cell widths stay locked — the yellow
 *  labels would misalign across adjacent flex rows otherwise. */
function SpecTable({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <table
      className={`w-full border-collapse text-[11px] ${className ?? ""}`}
    >
      <tbody>{children}</tbody>
    </table>
  );
}

/** Section title with the underlined bold look from the reference. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-6 mb-2 text-[11px] font-bold underline">
      {children}
    </h2>
  );
}

/** Header cell for a data table (active ingredients, nutrition,
 *  amino acids). Yellow background, bold, optional center align. */
function DataTh({
  children,
  center,
}: {
  children: React.ReactNode;
  center?: boolean;
}) {
  return (
    <th
      className={`border border-ink-1000 bg-[#ffc000] px-2 py-1 font-bold ${
        center ? "text-center" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

/** Body cell matching :component:`DataTh`. */
function DataTd({
  children,
  center,
}: {
  children: React.ReactNode;
  center?: boolean;
}) {
  return (
    <td
      className={`border border-ink-1000 px-2 py-1 align-middle ${
        center ? "text-center" : "text-left"
      }`}
    >
      {children}
    </td>
  );
}

/** Print-friendly signature line: role label above a thin rule the
 *  scanned signature image will eventually sit on (Phase B). */
function SignatureLine({ role }: { role: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold">{role}</p>
      <div className="mt-5 border-b border-ink-1000" />
    </div>
  );
}

/** Diagonal DRAFT watermark overlay. Positioned absolutely so it
 *  sits behind the content; reused across any status the backend
 *  :func:`show_watermark_for` flags as non-final. */
function DraftWatermark() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center"
    >
      <span
        className="select-none text-[160px] font-black tracking-[0.4em] text-[rgba(255,0,0,0.08)]"
        style={{ transform: "rotate(-32deg)" }}
      >
        DRAFT
      </span>
    </div>
  );
}

/** Render the sheet-header date in ``DD/MM/YYYY`` to match the
 *  reference workbook. Defensive against malformed ISO strings —
 *  an unparseable value degrades to the empty string so the header
 *  stays clean. */
function formatHeaderDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = date.getUTCFullYear();
  return `${dd}/${mm}/${yyyy}`;
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


/** Render the ingredient declaration paragraph with allergen names
 * bolded in place. The backend's ``declaration.text`` is a plain
 * comma-joined string — fine for JSON clients — but EU 1169/2011
 * art. 21 requires allergenic ingredients in the list to stand out,
 * so the spec sheet rebuilds the copy from ``entries`` and wraps
 * ``is_allergen`` rows in ``<strong>``. Falls back to the plain
 * text when the entries array is empty (e.g. a freshly-created
 * version with no lines). */
function IngredientDeclarationBody({
  rendered,
}: {
  rendered: RenderedSheetContext;
}) {
  const entries = rendered.declaration.entries;
  if (entries.length === 0) {
    return (
      <p className="font-serif text-sm leading-relaxed text-ink-1000">
        {rendered.declaration.text || "—"}
      </p>
    );
  }
  return (
    <p className="font-serif text-sm leading-relaxed text-ink-1000">
      {entries.map((entry, idx) => (
        <Fragment key={`${entry.category}-${entry.label}-${idx}`}>
          {idx > 0 ? ", " : ""}
          {entry.is_allergen ? (
            <strong>{entry.label}</strong>
          ) : (
            entry.label
          )}
        </Fragment>
      ))}
    </p>
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


/** Slug → translation key for every section the customer-facing
 *  sheet renders. Keys match the backend's :data:`SECTION_SLUGS`
 *  tuple. The order a menu actually displays comes from the current
 *  ``rendered.section_order`` — this map just exists to look up the
 *  translation key for a slug. */
const SECTION_LABEL_KEYS: Readonly<Record<string, string>> = {
  product_specification: "specification",
  packaging_specification: "packaging",
  compliance: "compliance",
  allergens: "allergens",
  safety_limits: "limits",
  actives: "actives",
  nutrition: "nutrition",
  amino_acids: "amino_acids",
  excipients: "excipients",
  ingredients: "ingredients",
  signatures: "signatures",
};


/**
 * Dropdown that lets a user with ``formulations.manage_spec_visibility``
 * toggle individual customer-facing sections on or off. The menu
 * mutates one slug at a time via ``useSetSpecificationVisibility``;
 * the server returns the fresh render context and the hook swaps
 * it into the query cache so the sheet repaints immediately.
 */
function VisibilityMenu({
  orgId,
  sheetId,
  visibility,
  order,
}: {
  orgId: string;
  sheetId: string;
  visibility: Readonly<Record<string, boolean>>;
  order: readonly string[];
}) {
  const tSpecs = useTranslations("specifications");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mutation = useSetSpecificationVisibility(orgId, sheetId);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const isHidden = (slug: string) => visibility[slug] === false;

  // Walk the current effective order, dropping slugs we don't know
  // about (shouldn't happen — server backfills — but cheap defence
  // against a schema skew).
  const rows = order.filter((slug) => slug in SECTION_LABEL_KEYS);

  const totalHidden = rows.filter((slug) => isHidden(slug)).length;

  const handleToggle = (slug: string) => {
    const nextValue = isHidden(slug); // currently hidden -> show it
    mutation.mutate({ visibility: { [slug]: nextValue } });
  };

  const handleMove = (slug: string, direction: -1 | 1) => {
    const index = rows.indexOf(slug);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [removed] = next.splice(index, 1);
    if (!removed) return;
    next.splice(target, 0, removed);
    mutation.mutate({ order: next });
  };

  return (
    <div ref={containerRef} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        onClick={() => setOpen((v) => !v)}
      >
        <Eye className="h-4 w-4" />
        {tSpecs("detail.visibility.button")}
        {totalHidden > 0 ? (
          <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-orange-100 px-1 text-[10px] font-semibold text-orange-800">
            {totalHidden}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 flex w-80 flex-col gap-0.5 rounded-xl bg-ink-0 p-2 shadow-lg ring-1 ring-ink-200"
        >
          <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            {tSpecs("detail.visibility.header")}
          </p>
          <p className="px-2 pb-2 text-[11px] text-ink-500">
            {tSpecs("detail.visibility.hint")}
          </p>
          {rows.map((slug, index) => {
            const labelKey = SECTION_LABEL_KEYS[slug]!;
            const hidden = isHidden(slug);
            const isFirst = index === 0;
            const isLast = index === rows.length - 1;
            return (
              <div
                key={slug}
                className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-ink-50"
              >
                <button
                  type="button"
                  aria-label={tSpecs("detail.visibility.move_up")}
                  onClick={() => handleMove(slug, -1)}
                  disabled={mutation.isPending || isFirst}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-500 hover:bg-ink-100 hover:text-ink-1000 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={tSpecs("detail.visibility.move_down")}
                  onClick={() => handleMove(slug, 1)}
                  disabled={mutation.isPending || isLast}
                  className="inline-flex h-6 w-6 items-center justify-center rounded text-ink-500 hover:bg-ink-100 hover:text-ink-1000 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={!hidden}
                  disabled={mutation.isPending}
                  onClick={() => handleToggle(slug)}
                  className="flex flex-1 items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm transition-colors disabled:opacity-60"
                >
                  <span
                    className={
                      hidden ? "text-ink-500 line-through" : "text-ink-1000"
                    }
                  >
                    {tSpecs(
                      `sheet.sections.${labelKey}` as `sheet.sections.specification`,
                    )}
                  </span>
                  {hidden ? (
                    <EyeOff className="h-4 w-4 shrink-0 text-ink-400" />
                  ) : (
                    <Eye className="h-4 w-4 shrink-0 text-orange-500" />
                  )}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
