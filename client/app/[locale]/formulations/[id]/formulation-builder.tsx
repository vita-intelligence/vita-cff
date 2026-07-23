"use client";

import { Button } from "@heroui/react";
import { Check, Copy, CopyPlus, ExternalLink, Loader2, Printer, Save, ShieldCheck, Sliders, Trash2 } from "lucide-react";

import { DuplicateFormulationModal } from "./duplicate-formulation-modal";
import { StageBomsPreview } from "./stage-boms-preview";
import { StageStrip } from "./stage-strip";
import { useLocale, useTranslations } from "next-intl";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useSearchParams } from "next/navigation";

import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { clientUuid } from "@/lib/utils";
import { useInfiniteItems } from "@/services/catalogues";
import type { ItemDto } from "@/services/catalogues/types";
import { useOrganization } from "@/services/organizations";
import {
  useMirrorPspItem,
  usePspAllergens,
  usePspItems,
  usePspStorageTags,
  usePspUnitsOfMeasurement,
} from "@/services/psp";
import type { PspItemDto } from "@/services/psp";

import {
  CAPSULE_SHELL_WEIGHTS,
  CAPSULE_SIZES,
  DOSAGE_FORMS,
  FULLY_SUPPORTED_DOSAGE_FORMS,
  POWDER_TYPES,
  TABLET_SIZES,
  buildIngredientDeclaration,
  canComputeMaterial,
  computeAllergens,
  computeCompliance,
  computeNrvPercent,
  computeTotals,
  explainLine,
  getNrvTargetMg,
  useAttachFormulationCertificate,
  useDeleteFormulationPhoto,
  useDetachFormulationCertificate,
  useFormulationCertificateCatalog,
  useFormulationCertificates,
  useFormulationPhotos,
  useUpdateFormulationCertificate,
  useUpdateFormulationPhoto,
  useUploadFormulationPhoto,
  useFormulationVersions,
  useReplaceLines,
  useRollbackFormulation,
  useSaveVersion,
  useSaveWizardRouting,
  useSyncFormulationToPsp,
  useSetApprovedVersion,
  useUpdateFormulation,
  type AllergensResult,
  type ComplianceFlagResult,
  type ComplianceResult,
  type ComputeLineInput,
  type DosageForm,
  type FormulationCertificateDto,
  type FormulationDto,
  type GummyBaseItemDto,
  type FormulationTotals,
  type IngredientDeclaration,
  type ItemAttributesForMath,
  type LineFailureReason,
  type LineItemAttributes,
  type PowderType,
} from "@/services/formulations";

const RAW_MATERIALS_SLUG = "raw_materials";

/**
 * Auto-picks the smallest PSP shell whose ``max_weight_mg`` fits
 * ``totalActiveMg`` with ~21% headroom. Mirrors the compute-layer
 * ``autoPickFromPspCatalog`` (kept in sync manually — the helper
 * isn't exported from the math module). Returns ``null`` when the
 * catalog is empty or nothing fits.
 */
const CAPSULE_SHELL_AUTOPICK_HEADROOM = 0.79;
function resolveAutoPickedShell(
  catalog: readonly {
    readonly uuid: string;
    readonly name: string;
    readonly code: string;
    readonly capsuleSize: string | null;
    readonly maxWeightMg: number;
  }[],
  totalActiveMg: number,
) {
  if (!catalog || catalog.length === 0) return null;
  const sorted = [...catalog]
    .filter((s) => Number.isFinite(s.maxWeightMg) && s.maxWeightMg > 0)
    .sort((a, b) => a.maxWeightMg - b.maxWeightMg);
  for (const shell of sorted) {
    if (totalActiveMg < shell.maxWeightMg * CAPSULE_SHELL_AUTOPICK_HEADROOM) {
      return shell;
    }
  }
  return null;
}

/** The four workspace tabs on the formulation builder. Each tab is
 *  a permanently-mounted section that toggles via the ``hidden``
 *  Tailwind class so intermediate state (line edits, stage drafts,
 *  scroll positions) survives tab switches. */
// Tabs after the ingredient-drill-down refactor: Ingredients is no
// longer its own tab. Scientists click a stage inside the Stages tab
// to drill into the ingredient builder scoped to that stage — same
// panels (picker, lines, totals, fine-tune, compliance, declaration)
// swap in place of the stage list with a back arrow to return.
type BuilderTab =
  | "setup"
  | "formulation"
  | "stages"
  | "routing"
  | "preview";


interface BuilderLine {
  /** Stable local id for rows we just added in the UI. */
  readonly key: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  /** PSP UUID this line's item mirrors — drives the "Open on PSP"
   *  deep-link on every downstream display. ``null`` for local-only
   *  lines never mirrored to PSP. */
  readonly item_psp_source_uuid: string | null;
  readonly item_attributes: ItemAttributesForMath;
  label_claim_mg: string;
  /** Per-line override of the catalogue's purity. Empty string means
   *  "use the catalogue value"; any non-empty numeric string wins on
   *  the math cascade and is persisted on save. */
  purity_override: string;
  overage_override: string;
  extract_ratio_override: string;
  display_order: number;
  /** Production stage this line belongs to on the multi-stage BOM
   *  cascade. ``null`` on legacy lines that predate stages OR on new
   *  picks made before the operator set a stage — they get folded
   *  into the terminal stage's BOM at push time. */
  stage_id: string | null;
  /** Wizard routing provenance — mirrors the server field so
   *  Step 3 (Routing tab) can group / label rows correctly. */
  source_kind: "active" | "band_pick" | "manual";
  band_key: string | null;
}

interface MetadataDraft {
  name: string;
  code: string;
  description: string;
  dosage_form: DosageForm;
  capsule_size: string;
  tablet_size: string;
  serving_size: number;
  servings_per_pack: number;
  target_fill_weight_mg: string;
  powder_type: PowderType;
  water_volume_ml: string;
  //: Picked gummy-base raw-material ids (multi-select). Empty list
  //: = no picks yet — the declaration falls back to a synthetic
  //: "Gummy Base" row and the totals pane shows a generic entry.
  //: Total base weight is split equally across picks.
  gummy_base_item_ids: readonly string[];
  //: Picked flavouring raw-material ids (multi-select). Empty list
  //: = the 0.4%-of-target flavour block renders as a generic
  //: "Flavouring" row; any picks → the block is split equally across
  //: picked items and the spec sheet lists them under
  //: "Flavouring (Natural Strawberry, Lemon Extract)".
  flavouring_item_ids: readonly string[];
  //: Picked colour raw-material ids. Empty list = the colour block
  //: renders as a generic "Colour" row; any picks → split equally
  //: and listed under "Colour (Beetroot Extract, Turmeric)" on the
  //: spec sheet. Used by both gummies (2% of target weight) and
  //: powders (0.04 mg/ml × water volume).
  colour_item_ids: readonly string[];
  //: Picked sweetener raw-material ids for powders (Sucralose,
  //: Stevia, Steviol, etc.). The 0.06 mg/ml × water volume sweetener
  //: total splits equally across picks; empty list renders a generic
  //: "Sweetener" row. Powder-only — gummies use ``gummy_base_item_ids``
  //: + ``premix_sweetener_item_ids`` for their sweetener picks.
  sweetener_item_ids: readonly string[];
  //: Picked glazing-agent ids (carnauba wax, coconut oil, beeswax,
  //: etc.). The 0.1%-of-target glaze total is split equally across
  //: picks; empty list renders a generic "Glazing Agent" row.
  glazing_item_ids: readonly string[];
  //: Picked gelling-agent ids (pectin, gelatin, agar). Empty list →
  //: a non-gelling gummy: no gelling band, no premix-sweetener band.
  //: Any picks → 3% of target split equally and the spec sheet reads
  //: "Gelling Agent (Pectin)".
  gelling_item_ids: readonly string[];
  //: Picked premix-sweetener ids combined with the gelling agent
  //: into the in-house "Pectin Premix" BOM line. Pulls from the same
  //: catalogue pool as the gummy base. Only emitted alongside
  //: gelling picks.
  premix_sweetener_item_ids: readonly string[];
  //: Picked acidity-regulator ids (Citric Acid, Trisodium Citrate,
  //: etc.). 2% of target gummy weight split equally across picks.
  //: Empty list = a generic "Acidity Regulator" placeholder row.
  acidity_item_ids: readonly string[];
  //: Picked capsule shell ids. Typically one pick per formulation.
  //: The picked shell's ``attributes.capsule_size`` drives the
  //: compute's fill capacity (overriding the ``capsule_size``
  //: dropdown when set) and ``attributes.shell_weight_mg`` drives
  //: the shell mass on the declaration. Empty list → hardcoded
  //: per-size table. Capsule dosage form only.
  capsule_shell_item_ids: readonly string[];
  //: Picked MCC carrier ids for capsules + tablets. Total MCC mg
  //: (capsule remainder / tablet 20%) splits equally across picks.
  //: Empty list → generic "Microcrystalline Cellulose (Carrier)"
  //: placeholder + ``mcc_carrier_unpicked`` viability warning.
  mcc_carrier_item_ids: readonly string[];
  //: Picked DCP carrier ids for tablets. Total DCP mg (10% of total
  //: active) splits equally across picks. Empty list → generic
  //: "Dicalcium Phosphate" placeholder + ``dcp_carrier_unpicked``
  //: warning.
  dcp_carrier_item_ids: readonly string[];
  //: Picked anti-caking ids for capsules + tablets + powders. When
  //: at least one item is picked the combined 1.4% (Stearate 1% +
  //: Silica 0.4%) auto-fill fires; empty list means the formulation
  //: ships with no anti-caking band at all and the spec sheet drops
  //: the row. Contribution is name-classified per pick: silica-only
  //: -> 0.4%, stearate-only -> 1.0%, both -> 1.4% of total active.
  anti_caking_item_ids: readonly string[];
  //: Picked powder carrier ids (Maltodextrin etc.). Fills the
  //: remainder of the sachet after actives + other excipient bands;
  //: empty list means no carrier band on the formulation. Server
  //: rejects picks whose use_as is not in ('Carrier', 'Bulking
  //: Agent'). Powder-only.
  powder_carrier_item_ids: readonly string[];
  //: Per-band % overrides for the gummy excipient system (water,
  //: acidity, flavouring, colour, glazing, gelling, premix_sweetener).
  //: Values are decimal fractions (0.02 = 2%). Missing keys → defaults.
  excipient_overrides: Readonly<Record<string, number>>;
  directions_of_use: string;
  suggested_dosage: string;
  appearance: string;
  disintegration_spec: string;
  // Finished-product spec on Setup — mirrored to the finished stage's
  // PSP spec sub-table by the push cascade.
  regulatory_category:
    | ""
    | "food_supplement"
    | "functional_food"
    | "cosmetic"
    | "medical_device";
  warnings_text: string;
  shelf_life_months: string;
  storage_conditions: string;
  target_markets: readonly string[];
  net_quantity: string;
  net_quantity_uom_uuid: string | null;
  serving_size_uom_uuid: string | null;
  // Phase 4a — warehouse + allergens.
  storage_tags: readonly string[];
  min_stock_qty: string;
  target_stock_qty: string;
  allergen_uuids: readonly string[];
  may_contain_allergen_keys: readonly string[];
  may_contain_justification: string;
}

// Excel's unspoken convention: every powder sachet in the reference
// workbooks (Soza / Moonlytes / Rave Lytes / FreeProtein) is a 10g
// sachet. Scientists never type the number — the template assumes
// it. We mirror that here so a fresh powder formulation shows the
// flavour system + carrier math immediately instead of sitting empty
// until the user happens to notice the fill-weight input.
const POWDER_DEFAULT_FILL_MG = "10000";
// Default water volume for a fresh powder — aligns with the mg
// values baked into ``POWDER_FLAVOUR_SYSTEM``. Scientists tune
// this per product; changing it rescales every flavour row live.
const POWDER_DEFAULT_WATER_ML = "500";

function defaultFillWeightFor(dosageForm: string): string {
  return dosageForm === "powder" ? POWDER_DEFAULT_FILL_MG : "";
}

function defaultWaterVolumeFor(dosageForm: string): string {
  return dosageForm === "powder" ? POWDER_DEFAULT_WATER_ML : "";
}

// Grams ↔ milligrams conversion for the powder fill-weight input.
// Storage stays in mg across the API + math; only the one powder
// field displays / accepts grams because scientists think about
// scoop mass in grams (10g), not mg (10000). Gummy mass stays in mg
// — per-gummy weights live in the 500mg–2500mg range where mg is
// actually the natural unit.
function mgStringToG(mg: string | null | undefined): string {
  if (!mg) return "";
  const parsed = Number.parseFloat(mg);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  // Strip trailing zeros — ``10000 mg`` → ``"10"`` rather than
  // ``"10.0"`` so the input doesn't read as if the scientist typed
  // a fractional value.
  const asG = parsed / 1000;
  return Number.isInteger(asG) ? String(asG) : String(asG);
}

function gStringToMgString(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return "";
  // Quantise via ``toFixed`` to dodge float artefacts like
  // ``10.5 * 1000 = 10499.999…``. Trim trailing zeros for compactness
  // so the stored string stays short and the backend's tolerant
  // Decimal parser never sees noise digits.
  return (parsed * 1000).toFixed(4).replace(/\.?0+$/, "");
}

function metadataFrom(formulation: FormulationDto): MetadataDraft {
  const storedFill = formulation.target_fill_weight_mg ?? "";
  return {
    name: formulation.name,
    code: formulation.code,
    description: formulation.description,
    dosage_form: formulation.dosage_form,
    capsule_size: formulation.capsule_size,
    tablet_size: formulation.tablet_size,
    serving_size: formulation.serving_size,
    servings_per_pack: formulation.servings_per_pack,
    target_fill_weight_mg:
      storedFill || defaultFillWeightFor(formulation.dosage_form),
    powder_type: formulation.powder_type ?? "standard",
    water_volume_ml:
      (formulation.water_volume_ml ?? "") ||
      defaultWaterVolumeFor(formulation.dosage_form),
    gummy_base_item_ids: formulation.gummy_base_item_ids ?? [],
    flavouring_item_ids: formulation.flavouring_item_ids ?? [],
    colour_item_ids: formulation.colour_item_ids ?? [],
    sweetener_item_ids: formulation.sweetener_item_ids ?? [],
    glazing_item_ids: formulation.glazing_item_ids ?? [],
    gelling_item_ids: formulation.gelling_item_ids ?? [],
    premix_sweetener_item_ids:
      formulation.premix_sweetener_item_ids ?? [],
    acidity_item_ids: formulation.acidity_item_ids ?? [],
    capsule_shell_item_ids: formulation.capsule_shell_item_ids ?? [],
    mcc_carrier_item_ids: formulation.mcc_carrier_item_ids ?? [],
    dcp_carrier_item_ids: formulation.dcp_carrier_item_ids ?? [],
    anti_caking_item_ids: formulation.anti_caking_item_ids ?? [],
    powder_carrier_item_ids:
      formulation.powder_carrier_item_ids ?? [],
    excipient_overrides: formulation.excipient_overrides ?? {},
    directions_of_use: formulation.directions_of_use,
    suggested_dosage: formulation.suggested_dosage,
    appearance: formulation.appearance,
    disintegration_spec: formulation.disintegration_spec,
    regulatory_category: formulation.regulatory_category ?? "",
    warnings_text: formulation.warnings_text ?? "",
    shelf_life_months:
      formulation.shelf_life_months !== null &&
      formulation.shelf_life_months !== undefined
        ? String(formulation.shelf_life_months)
        : "",
    storage_conditions: formulation.storage_conditions ?? "",
    target_markets: formulation.target_markets ?? [],
    net_quantity: formulation.net_quantity ?? "",
    net_quantity_uom_uuid: formulation.net_quantity_uom_uuid ?? null,
    serving_size_uom_uuid: formulation.serving_size_uom_uuid ?? null,
    storage_tags: formulation.storage_tags ?? [],
    min_stock_qty: formulation.min_stock_qty ?? "",
    target_stock_qty: formulation.target_stock_qty ?? "",
    allergen_uuids: formulation.allergen_uuids ?? [],
    may_contain_allergen_keys: formulation.may_contain_allergen_keys ?? [],
    may_contain_justification: formulation.may_contain_justification ?? "",
  };
}

function attributesFromLine(
  line_attributes: LineItemAttributes,
): ItemAttributesForMath {
  const extra = line_attributes as unknown as Record<string, unknown>;
  return {
    type: line_attributes.type ?? null,
    purity: line_attributes.purity ?? null,
    extract_ratio: line_attributes.extract_ratio ?? null,
    overage: line_attributes.overage ?? null,
    // ``use_as`` flows through verbatim — the server serializes it
    // from ``Item.attributes.use_as`` (see
    // ``FormulationLineReadSerializer.get_item_attributes``) and the
    // math classifier reads ``line.attributes.use_as`` to decide
    // whether each line counts as Active / Acidity Regulator /
    // Sweeteners / etc. Without this key the live "item missing
    // use_as" warning fires for every saved line, regardless of
    // whether the underlying raw material actually carries a
    // classification.
    use_as: (extra.use_as as string | null | undefined) ?? null,
    ingredient_list_name:
      (extra.ingredient_list_name as string | null | undefined) ?? null,
    nutrition_information_name:
      (extra.nutrition_information_name as string | null | undefined) ?? null,
    vegan: (extra.vegan as string | null | undefined) ?? null,
    organic: (extra.organic as string | null | undefined) ?? null,
    halal: (extra.halal as string | null | undefined) ?? null,
    kosher: (extra.kosher as string | null | undefined) ?? null,
    // Allergen fields MUST flow through — the builder's live
    // Compliance panel and ingredient-declaration bolding both
    // run ``isAllergenLine`` against these keys, and a missing
    // flag silently degrades to "no allergens" regardless of
    // catalogue data.
    allergen: (extra.allergen as string | null | undefined) ?? null,
    allergen_source:
      (extra.allergen_source as string | null | undefined) ?? null,
    nrv_mg:
      (extra.nrv_mg as string | number | null | undefined) ?? null,
  };
}

function attributesFromItem(item: ItemDto): ItemAttributesForMath {
  const attrs = item.attributes || {};
  const pickStr = (key: string) =>
    (attrs[key] as string | null | undefined) ?? null;
  const pickNum = (key: string) =>
    (attrs[key] as string | number | null | undefined) ?? null;
  return {
    type: pickStr("type"),
    purity: pickNum("purity"),
    extract_ratio: pickNum("extract_ratio"),
    overage: pickNum("overage"),
    // ``use_as`` is the classifier that drives the math's
    // Active/Sweetener/Carrier dispatch and the "item missing
    // use_as" warning the viability panel surfaces live. The
    // converter was previously dropping it on the floor, which
    // meant *every* freshly-picked ingredient fired the warning
    // regardless of whether the raw material's ``attributes.use_as``
    // was set in the catalogue.
    use_as: pickStr("use_as"),
    ingredient_list_name: pickStr("ingredient_list_name"),
    nutrition_information_name: pickStr("nutrition_information_name"),
    vegan: pickStr("vegan"),
    organic: pickStr("organic"),
    halal: pickStr("halal"),
    kosher: pickStr("kosher"),
    allergen: pickStr("allergen"),
    allergen_source: pickStr("allergen_source"),
    nrv_mg: pickNum("nrv_mg"),
  };
}

function linesFrom(formulation: FormulationDto): BuilderLine[] {
  return formulation.lines.map((line, index) => ({
    key: line.id,
    item_id: line.item,
    item_name: line.item_name,
    item_internal_code: line.item_internal_code,
    item_psp_source_uuid: line.item_psp_source_uuid ?? null,
    item_attributes: attributesFromLine(line.item_attributes),
    label_claim_mg: line.label_claim_mg,
    purity_override: line.purity_override ?? "",
    overage_override: line.overage_override ?? "",
    extract_ratio_override: line.extract_ratio_override ?? "",
    display_order: line.display_order ?? index,
    stage_id: line.stage_id ?? null,
    source_kind: line.source_kind ?? "active",
    band_key: line.band_key ?? null,
  }));
}

/**
 * Finished-product spec section on the Setup tab. Source of truth
 * for every field PSP's ``item_finished_product_spec`` sub-table
 * carries; the push cascade mirrors these onto the finished stage's
 * PSP item on Save Version / Sync now. When there's no finished
 * stage yet (or PSP isn't configured), the fields just persist on
 * NPD and wait for the cascade to pick them up.
 */
const REGULATORY_CATEGORY_OPTIONS = [
  "food_supplement",
  "functional_food",
  "cosmetic",
  "medical_device",
] as const;

function FinishedProductSpecSetupSection({
  orgId,
  metadata,
  onChange,
  canWrite,
}: {
  orgId: string;
  metadata: MetadataDraft;
  onChange: (patch: Partial<MetadataDraft>) => void;
  canWrite: boolean;
}) {
  const uomQuery = usePspUnitsOfMeasurement(orgId);
  const uomOptions = uomQuery.data?.items ?? [];
  const targetMarketsCsv = metadata.target_markets.join(", ");

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
        Finished-product spec
      </p>
      <p className="mt-1 text-sm text-ink-600">
        Ships to PSP as the finished-product item&apos;s
        <span className="font-medium"> spec sub-table</span> on the
        next Save version or Sync now. If there&apos;s no finished
        stage yet, values persist on NPD until one exists.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="text-xs font-medium text-ink-600">
            Regulatory category
          </label>
          <select
            value={metadata.regulatory_category}
            onChange={(e) =>
              onChange({
                regulatory_category:
                  e.target.value as MetadataDraft["regulatory_category"],
              })
            }
            disabled={!canWrite}
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          >
            <option value="">— none —</option>
            {REGULATORY_CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-500">
            EU classification that determines which labelling rules
            apply — read by QA on PSP&apos;s spec sheet review.
          </p>
        </div>

        <div>
          <label className="text-xs font-medium text-ink-600">
            Net quantity
          </label>
          <input
            value={metadata.net_quantity}
            onChange={(e) => onChange({ net_quantity: e.target.value })}
            disabled={!canWrite}
            inputMode="decimal"
            placeholder="e.g. 60"
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-ink-600">
            Net qty unit
          </label>
          <select
            value={metadata.net_quantity_uom_uuid ?? ""}
            onChange={(e) =>
              onChange({
                net_quantity_uom_uuid: e.target.value || null,
              })
            }
            disabled={!canWrite}
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          >
            <option value="">— none —</option>
            {uomOptions.map((u) => (
              <option key={u.uuid} value={u.uuid}>
                {u.name}
                {u.symbol ? ` (${u.symbol})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="text-xs font-medium text-ink-600">
            Serving-size unit
          </label>
          <select
            value={metadata.serving_size_uom_uuid ?? ""}
            onChange={(e) =>
              onChange({
                serving_size_uom_uuid: e.target.value || null,
              })
            }
            disabled={!canWrite}
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          >
            <option value="">— none —</option>
            {uomOptions.map((u) => (
              <option key={u.uuid} value={u.uuid}>
                {u.name}
                {u.symbol ? ` (${u.symbol})` : ""}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-500">
            Pairs with{" "}
            <span className="font-medium">serving size</span> above —
            &quot;1 capsule&quot;, &quot;5 g&quot;, etc.
          </p>
        </div>
        <div>
          <label className="text-xs font-medium text-ink-600">
            Shelf life (months)
          </label>
          <input
            value={metadata.shelf_life_months}
            onChange={(e) =>
              onChange({ shelf_life_months: e.target.value })
            }
            disabled={!canWrite}
            inputMode="numeric"
            placeholder="e.g. 24"
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>

        <div className="md:col-span-2">
          <label className="text-xs font-medium text-ink-600">
            Warnings text
          </label>
          <textarea
            value={metadata.warnings_text}
            onChange={(e) => onChange({ warnings_text: e.target.value })}
            disabled={!canWrite}
            rows={2}
            placeholder="Mandatory under EU 1169/2011 Art. 9(1)(j)."
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs font-medium text-ink-600">
            Storage conditions
          </label>
          <textarea
            value={metadata.storage_conditions}
            onChange={(e) =>
              onChange({ storage_conditions: e.target.value })
            }
            disabled={!canWrite}
            rows={2}
            placeholder="e.g. Store below 25°C, away from direct light."
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div className="md:col-span-2">
          <label className="text-xs font-medium text-ink-600">
            Target markets (ISO 3166-1 alpha-2, comma-separated)
          </label>
          <input
            value={targetMarketsCsv}
            onChange={(e) => {
              const parts = e.target.value
                .split(",")
                .map((s) => s.trim().toUpperCase())
                .filter((s) => s.length === 2);
              onChange({ target_markets: parts });
            }}
            disabled={!canWrite}
            placeholder="e.g. GB, IE, DE"
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
      </div>
    </section>
  );
}


/**
 * Warehouse identity + allergens on the Setup tab. Storage tags and
 * reorder points ride the same push as identity; allergens use PSP's
 * M:N (uuid list resolves to allergen ids server-side); may-contain
 * lands on the finished-product spec sub-table. Every stage on the
 * formulation carries the same values — a formulation ships to
 * warehouse under one identity, not one per stage.
 */
function WarehouseAndAllergensSetupSection({
  orgId,
  metadata,
  onChange,
  canWrite,
  derivedAllergenKeys,
}: {
  orgId: string;
  metadata: MetadataDraft;
  onChange: (patch: Partial<MetadataDraft>) => void;
  canWrite: boolean;
  /** PSP allergen keys carried on any of the picked ingredients.
   *  Setup pre-checks these on the matrix so the scientist doesn't
   *  retype what raw materials already declare. Empty array = no
   *  ingredient-derived allergens. */
  derivedAllergenKeys: readonly string[];
}) {
  const storageTagsQuery = usePspStorageTags(orgId);
  const storageTagOptions = storageTagsQuery.data?.items ?? [];
  const allergensQuery = usePspAllergens(orgId);
  const allergenOptions = allergensQuery.data?.items ?? [];

  const derivedKeySet = new Set(derivedAllergenKeys);
  const allergenState = (
    a: { uuid: string; key: string },
  ): "none" | "declared" | "may_contain" => {
    if (metadata.allergen_uuids.includes(a.uuid)) return "declared";
    if (metadata.may_contain_allergen_keys.includes(a.key)) return "may_contain";
    return "none";
  };
  // Cycle: none → declared → may_contain → none. Derived allergens
  // start "declared" implicitly until the user overrides — the manual
  // state list still holds the authoritative record so save-time
  // wiring is unchanged.
  const cycleAllergen = (a: { uuid: string; key: string }) => {
    const state = allergenState(a);
    const declaredSet = new Set(metadata.allergen_uuids);
    const mayContainSet = new Set(metadata.may_contain_allergen_keys);
    declaredSet.delete(a.uuid);
    mayContainSet.delete(a.key);
    if (state === "none") {
      declaredSet.add(a.uuid);
    } else if (state === "declared") {
      mayContainSet.add(a.key);
    }
    onChange({
      allergen_uuids: Array.from(declaredSet),
      may_contain_allergen_keys: Array.from(mayContainSet),
    });
  };
  const acceptDerived = () => {
    // Merge derived → declared without touching may-contain. Lets a
    // scientist accept the auto-suggestion in one click after the
    // ingredient roster stabilises.
    const declaredSet = new Set(metadata.allergen_uuids);
    for (const a of allergenOptions) {
      if (derivedKeySet.has(a.key)) declaredSet.add(a.uuid);
    }
    onChange({ allergen_uuids: Array.from(declaredSet) });
  };
  const toggleStorageTag = (name: string) => {
    const set = new Set(metadata.storage_tags);
    if (set.has(name)) {
      set.delete(name);
    } else {
      set.add(name);
    }
    onChange({ storage_tags: Array.from(set) });
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
        Warehouse identity + allergens
      </p>
      <p className="mt-1 text-sm text-ink-600">
        Storage tags + reorder points ship to the finished-product
        PSP item. Allergen decls land on the item&apos;s M:N;
        may-contain lands on the spec sub-table.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-ink-600">
            Min stock qty
          </label>
          <input
            value={metadata.min_stock_qty}
            onChange={(e) => onChange({ min_stock_qty: e.target.value })}
            disabled={!canWrite}
            inputMode="decimal"
            placeholder="Reorder trigger"
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-ink-600">
            Target stock qty
          </label>
          <input
            value={metadata.target_stock_qty}
            onChange={(e) =>
              onChange({ target_stock_qty: e.target.value })
            }
            disabled={!canWrite}
            inputMode="decimal"
            placeholder="Order-up-to level"
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>

        <div className="md:col-span-2">
          <label className="text-xs font-medium text-ink-600">
            Storage tags
          </label>
          {storageTagOptions.length === 0 ? (
            <p className="mt-1 rounded-lg bg-ink-50 px-3 py-2 text-[11px] leading-snug text-ink-500">
              No storage tags in PSP&apos;s catalog yet — add them on
              PSP → Warehouses → Storage tags.
            </p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {storageTagOptions.map((tag) => {
                const active = metadata.storage_tags.includes(tag.name);
                return (
                  <button
                    key={tag.uuid}
                    type="button"
                    onClick={() => toggleStorageTag(tag.name)}
                    disabled={!canWrite}
                    className={
                      active
                        ? "rounded-full bg-orange-500 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                        : "rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50"
                    }
                  >
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Allergen matrix — one row per EU-14 allergen with a 3-state
            chip (— / declared / may-contain). Replaces the earlier
            two blocks of 14 checkboxes each. Derived allergens
            (inherited from picked ingredient metadata) show an
            "in ingredients" tag so the scientist can accept the
            auto-suggestion in one click. */}
        <div className="md:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <div>
              <label className="text-xs font-medium text-ink-600">
                Allergens (EU FIC Annex II)
              </label>
              <p className="mt-0.5 text-[11px] leading-snug text-ink-500">
                Click a chip to cycle:{" "}
                <span className="font-medium">—</span> →{" "}
                <span className="font-medium text-orange-700">
                  declared
                </span>{" "}
                →{" "}
                <span className="font-medium text-amber-700">
                  may contain
                </span>
                . Declared allergens land on the PSP item&apos;s
                allergen M:N; may-contain lands on the spec sub-table.
              </p>
            </div>
            {derivedKeySet.size > 0 &&
            canWrite &&
            allergenOptions.some(
              (a) =>
                derivedKeySet.has(a.key) &&
                !metadata.allergen_uuids.includes(a.uuid),
            ) ? (
              <button
                type="button"
                onClick={acceptDerived}
                className="shrink-0 rounded-lg bg-orange-50 px-2.5 py-1.5 text-xs font-medium text-orange-700 ring-1 ring-inset ring-orange-200 hover:bg-orange-100"
              >
                Accept ingredient-derived
              </button>
            ) : null}
          </div>
          {allergenOptions.length === 0 ? (
            <p className="mt-2 rounded-lg bg-ink-50 px-3 py-2 text-[11px] leading-snug text-ink-500">
              PSP&apos;s allergen catalog is empty — seed it via
              migration.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {allergenOptions.map((a) => {
                const state = allergenState(a);
                const isDerived = derivedKeySet.has(a.key);
                const chipClass =
                  state === "declared"
                    ? "bg-orange-500 text-white ring-orange-500 hover:bg-orange-600"
                    : state === "may_contain"
                      ? "bg-amber-100 text-amber-800 ring-amber-300 hover:bg-amber-200"
                      : "bg-ink-50 text-ink-600 ring-ink-200 hover:bg-ink-100";
                const stateLabel =
                  state === "declared"
                    ? "declared"
                    : state === "may_contain"
                      ? "may contain"
                      : "—";
                return (
                  <button
                    key={a.uuid}
                    type="button"
                    onClick={() => cycleAllergen(a)}
                    disabled={!canWrite}
                    className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-inset transition disabled:cursor-not-allowed disabled:opacity-60 ${chipClass}`}
                    aria-pressed={state !== "none"}
                    title={
                      isDerived
                        ? `${a.label} — declared on picked ingredient(s)`
                        : a.label
                    }
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-medium">
                        {a.label}
                      </span>
                      {isDerived ? (
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                            state === "declared"
                              ? "bg-white/25 text-white"
                              : "bg-orange-100 text-orange-700"
                          }`}
                        >
                          in&nbsp;ingredients
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide opacity-80">
                      {stateLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="md:col-span-2">
          <label className="text-xs font-medium text-ink-600">
            May-contain justification
          </label>
          <textarea
            value={metadata.may_contain_justification}
            onChange={(e) =>
              onChange({ may_contain_justification: e.target.value })
            }
            disabled={!canWrite}
            rows={2}
            placeholder="Reason for the may-contain declaration (e.g. shared line with a milk-containing product)."
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
      </div>
    </section>
  );
}


function FormulationPhotosSetupSection({
  orgId,
  formulationId,
  canWrite,
}: {
  orgId: string;
  formulationId: string;
  canWrite: boolean;
}) {
  const photosQuery = useFormulationPhotos(orgId, formulationId);
  const uploadPhoto = useUploadFormulationPhoto(orgId, formulationId);
  const updatePhoto = useUpdateFormulationPhoto(orgId, formulationId);
  const deletePhoto = useDeleteFormulationPhoto(orgId, formulationId);
  const photos = photosQuery.data?.items ?? [];
  const inputRef = useRef<HTMLInputElement>(null);

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      uploadPhoto.mutate({ file });
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Product photos
          </p>
          <p className="mt-1 text-sm text-ink-600">
            Ship to PSP&apos;s finished-product item on the next Save
            version or Sync now. First upload becomes the primary
            (catalog + label hero). PNG / JPEG / WebP / GIF, max 5 MB.
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            onChange={onPick}
            disabled={!canWrite || uploadPhoto.isPending}
            className="hidden"
          />
          <Button
            size="sm"
            variant="outline"
            onPress={() => inputRef.current?.click()}
            isDisabled={!canWrite || uploadPhoto.isPending}
          >
            {uploadPhoto.isPending ? "Uploading…" : "Upload photo"}
          </Button>
        </div>
      </div>

      {photosQuery.isLoading ? (
        <p className="mt-4 text-xs text-ink-500">Loading…</p>
      ) : photos.length === 0 ? (
        <p className="mt-4 text-xs text-ink-500">
          No photos yet. Upload one to seed the catalog card.
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          {photos.map((p) => (
            <div
              key={p.id}
              className="relative overflow-hidden rounded-xl bg-ink-100 ring-1 ring-ink-200"
            >
              {p.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.url}
                  alt={p.caption || p.original_filename}
                  className="h-32 w-full object-cover"
                />
              ) : (
                <div className="flex h-32 items-center justify-center text-[11px] text-ink-500">
                  no preview
                </div>
              )}
              {p.is_primary && (
                <span className="absolute left-2 top-2 rounded-full bg-orange-500 px-2 py-0.5 text-[10px] font-medium uppercase text-white shadow">
                  primary
                </span>
              )}
              <div className="flex items-center justify-between gap-1 border-t border-ink-200 bg-ink-0 px-2 py-1.5">
                <span className="truncate text-[11px] text-ink-600">
                  {p.original_filename || "photo"}
                </span>
                <div className="flex gap-1">
                  {!p.is_primary && (
                    <button
                      type="button"
                      onClick={() =>
                        updatePhoto.mutate({
                          photoId: p.id,
                          patch: { is_primary: true },
                        })
                      }
                      disabled={!canWrite || updatePhoto.isPending}
                      className="rounded px-1 text-[10px] text-orange-600 hover:bg-orange-50 disabled:opacity-40"
                    >
                      make primary
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete "${p.original_filename || "photo"}"?`)) {
                        deletePhoto.mutate(p.id);
                      }
                    }}
                    disabled={!canWrite || deletePhoto.isPending}
                    className="rounded p-1 text-ink-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                    aria-label="Delete photo"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}


/**
 * Certificates section — mirrors the PSP item-detail Certificates card.
 * Picker sources from the PSP cert registry via a proxy endpoint;
 * attach persists locally + pushes to PSP; the row survives if PSP
 * is briefly unreachable (idempotency via ``psp_attachment_uuid``).
 */
function FormulationCertificatesSetupSection({
  orgId,
  formulationId,
  canWrite,
}: {
  orgId: string;
  formulationId: string;
  canWrite: boolean;
}) {
  const attachedQuery = useFormulationCertificates(orgId, formulationId);
  const catalogQuery = useFormulationCertificateCatalog(
    orgId,
    formulationId,
  );
  const attach = useAttachFormulationCertificate(orgId, formulationId);
  const patch = useUpdateFormulationCertificate(orgId, formulationId);
  const detach = useDetachFormulationCertificate(orgId, formulationId);

  const attached = attachedQuery.data?.items ?? [];
  const catalog = catalogQuery.data?.items ?? [];

  const [pickerCertUuid, setPickerCertUuid] = useState<string>("");
  const [pickerNumber, setPickerNumber] = useState<string>("");
  const [pickerValidFrom, setPickerValidFrom] = useState<string>("");
  const [pickerValidUntil, setPickerValidUntil] = useState<string>("");

  const attachedUuidSet = useMemo(
    () => new Set(attached.map((a) => a.psp_certificate_uuid)),
    [attached],
  );
  // Only show catalog entries the operator hasn't attached yet.
  const availableCatalog = useMemo(
    () => catalog.filter((c) => !attachedUuidSet.has(c.uuid)),
    [catalog, attachedUuidSet],
  );

  const selectedCert = useMemo(
    () => catalog.find((c) => c.uuid === pickerCertUuid) ?? null,
    [catalog, pickerCertUuid],
  );

  // Auto-fill valid_until from valid_from + default_validity_months on
  // the picked cert. Empty valid_from clears the derived expiry so
  // typing dates from scratch stays predictable.
  const derivedValidUntil = useMemo(() => {
    if (!pickerValidFrom || !selectedCert?.default_validity_months) return "";
    const from = new Date(pickerValidFrom);
    if (Number.isNaN(from.valueOf())) return "";
    from.setMonth(from.getMonth() + selectedCert.default_validity_months);
    return from.toISOString().slice(0, 10);
  }, [pickerValidFrom, selectedCert]);

  useEffect(() => {
    // Only auto-fill when the operator hasn't manually set a value.
    if (!pickerValidUntil && derivedValidUntil) {
      setPickerValidUntil(derivedValidUntil);
    }
    // Deliberately leave a manually-typed valid_until alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedValidUntil]);

  const resetPicker = () => {
    setPickerCertUuid("");
    setPickerNumber("");
    setPickerValidFrom("");
    setPickerValidUntil("");
  };

  const canAttach =
    canWrite && !!pickerCertUuid && !!selectedCert && !attach.isPending;

  const onAttach = () => {
    if (!canAttach || !selectedCert) return;
    attach.mutate(
      {
        psp_certificate_uuid: selectedCert.uuid,
        psp_certificate_name: selectedCert.name,
        psp_certificate_type: selectedCert.certificate_type ?? "",
        psp_issuing_body: selectedCert.issuing_body ?? "",
        certificate_number: pickerNumber.trim(),
        valid_from: pickerValidFrom || null,
        valid_until: pickerValidUntil || null,
      },
      { onSuccess: resetPicker },
    );
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Certificates
          </p>
          <p className="mt-1 text-sm text-ink-600">
            Pick from PSP&apos;s certificate registry and attach to
            this formulation. Rows push to the finished-product item
            on next save + appear on the PSP item page as if an
            operator added them.
          </p>
        </div>
      </div>

      {/* Picker row */}
      <div className="mt-4 grid grid-cols-1 gap-3 rounded-xl bg-ink-50/50 p-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            Certificate
          </label>
          <select
            value={pickerCertUuid}
            onChange={(e) => setPickerCertUuid(e.target.value)}
            disabled={
              !canWrite ||
              catalogQuery.isLoading ||
              availableCatalog.length === 0
            }
            className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          >
            <option value="">
              {catalogQuery.isLoading
                ? "Loading catalog…"
                : availableCatalog.length === 0
                  ? "No certificates available"
                  : "Pick a certificate…"}
            </option>
            {availableCatalog.map((c) => (
              <option key={c.uuid} value={c.uuid}>
                {c.name}
                {c.issuing_body ? ` · ${c.issuing_body}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            Cert number
          </label>
          <input
            type="text"
            value={pickerNumber}
            onChange={(e) => setPickerNumber(e.target.value)}
            disabled={!canWrite || !pickerCertUuid}
            placeholder="Optional"
            className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            Valid from
          </label>
          <input
            type="date"
            value={pickerValidFrom}
            onChange={(e) => setPickerValidFrom(e.target.value)}
            disabled={!canWrite || !pickerCertUuid}
            className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            Valid until
          </label>
          <input
            type="date"
            value={pickerValidUntil}
            onChange={(e) => setPickerValidUntil(e.target.value)}
            disabled={!canWrite || !pickerCertUuid}
            className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </div>
        <div className="flex items-end">
          <Button
            size="sm"
            onPress={onAttach}
            isDisabled={!canAttach}
          >
            {attach.isPending ? "Attaching…" : "Attach"}
          </Button>
        </div>
      </div>

      {/* Attached list */}
      {attachedQuery.isLoading ? (
        <p className="mt-4 text-xs text-ink-500">Loading…</p>
      ) : attached.length === 0 ? (
        <p className="mt-4 text-xs text-ink-500">
          No certificates attached yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-200 rounded-xl ring-1 ring-ink-200">
          {attached.map((row) => (
            <FormulationCertificateRow
              key={row.id}
              row={row}
              canWrite={canWrite}
              onPatch={(certId, body) => patch.mutate({ certId, patch: body })}
              onDetach={(certId) => {
                if (
                  window.confirm(
                    `Detach "${row.psp_certificate_name}" from this formulation?`,
                  )
                ) {
                  detach.mutate(certId);
                }
              }}
              patchPending={patch.isPending}
              detachPending={detach.isPending}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One row in the attached-certs list. In-line edit for
 * ``certificate_number`` + validity dates so a scientist can renew
 * without detaching + reattaching. The PATCH endpoint handles the
 * PSP-side replay (detach + reattach) so both sides stay in sync.
 */
function FormulationCertificateRow({
  row,
  canWrite,
  onPatch,
  onDetach,
  patchPending,
  detachPending,
}: {
  row: FormulationCertificateDto;
  canWrite: boolean;
  onPatch: (
    certId: string,
    patch: {
      certificate_number?: string;
      valid_from?: string | null;
      valid_until?: string | null;
    },
  ) => void;
  onDetach: (certId: string) => void;
  patchPending: boolean;
  detachPending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [numberDraft, setNumberDraft] = useState(row.certificate_number);
  const [fromDraft, setFromDraft] = useState(row.valid_from ?? "");
  const [untilDraft, setUntilDraft] = useState(row.valid_until ?? "");

  useEffect(() => {
    if (editing) return;
    setNumberDraft(row.certificate_number);
    setFromDraft(row.valid_from ?? "");
    setUntilDraft(row.valid_until ?? "");
  }, [
    editing,
    row.certificate_number,
    row.valid_from,
    row.valid_until,
  ]);

  const save = () => {
    onPatch(row.id, {
      certificate_number: numberDraft.trim(),
      valid_from: fromDraft || null,
      valid_until: untilDraft || null,
    });
    setEditing(false);
  };

  const validityBadge = row.psp_attachment_uuid
    ? "pushed to PSP"
    : "not yet on PSP";

  return (
    <li className="px-3 py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-1000">
              {row.psp_certificate_name}
            </span>
            {row.psp_issuing_body ? (
              <span className="text-[11px] text-ink-500">
                · {row.psp_issuing_body}
              </span>
            ) : null}
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-600">
              {validityBadge}
            </span>
          </div>
          {!editing && (
            <p className="mt-1 text-[11px] text-ink-500">
              {row.certificate_number ? (
                <>
                  <span className="font-mono">{row.certificate_number}</span>
                  {" · "}
                </>
              ) : null}
              {row.valid_from ? `From ${row.valid_from}` : "No start"}
              {row.valid_until ? ` · Until ${row.valid_until}` : ""}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onPress={() => setEditing(false)}
                isDisabled={patchPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onPress={save}
                isDisabled={!canWrite || patchPending}
              >
                {patchPending ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                onPress={() => setEditing(true)}
                isDisabled={!canWrite}
              >
                Edit
              </Button>
              <button
                type="button"
                onClick={() => onDetach(row.id)}
                disabled={!canWrite || detachPending}
                className="rounded p-1.5 text-ink-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                aria-label="Detach certificate"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              Cert number
            </label>
            <input
              type="text"
              value={numberDraft}
              onChange={(e) => setNumberDraft(e.target.value)}
              className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              Valid from
            </label>
            <input
              type="date"
              value={fromDraft}
              onChange={(e) => setFromDraft(e.target.value)}
              className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              Valid until
            </label>
            <input
              type="date"
              value={untilDraft}
              onChange={(e) => setUntilDraft(e.target.value)}
              className="rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </div>
        </div>
      )}
    </li>
  );
}


export function FormulationBuilder({
  orgId,
  initialFormulation,
  canWrite,
  hasTrialBatches = false,
}: {
  orgId: string;
  initialFormulation: FormulationDto;
  canWrite: boolean;
  /** True when the project already has at least one trial batch.
   *  The Excipient Ratios editor is gated on this so scientists
   *  don't touch override percentages before a trial run has
   *  established the baseline -- the override values only become
   *  meaningful once there's a physical batch to compare against. */
  hasTrialBatches?: boolean;
}) {
  const tFormulations = useTranslations("formulations");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();

  // Tabbed builder shell — the four sections below (Setup / Stages /
  // Ingredients / Preview) mount permanently and toggle via the
  // ``hidden`` Tailwind class so state (line edits, stage drafts,
  // scroll position) is preserved across tab switches. State only
  // ever loses on a real unmount, which happens on navigate-away.
  //
  // Active tab is URL-driven (?tab=setup|stages|preview) so a scientist
  // can share a link that lands on a specific tab OR reload without
  // losing their place. Historical ``?tab=ingredients`` links are
  // absorbed by the fallthrough — the Ingredients tab is gone, and
  // any bookmark pointing at it lands on Setup as the safe default.
  const searchParams = useSearchParams();
  const rawTab = searchParams?.get("tab") ?? "setup";
  const activeTab: BuilderTab = (
    ["setup", "formulation", "stages", "routing", "preview"] as const
  ).includes(rawTab as BuilderTab)
    ? (rawTab as BuilderTab)
    : "setup";
  const setActiveTab = useCallback(
    (tab: BuilderTab) => {
      // ``history.replaceState`` keeps the browser's back button
      // tied to the project entry, not to per-tab micro-navigations.
      // The ``router.replace`` path from ``@/i18n/navigation`` would
      // also work but forces a full router event; a raw
      // ``replaceState`` is cheaper for a same-page UI switch.
      if (typeof window === "undefined") return;
      const url = new URL(window.location.href);
      if (tab === "setup") {
        url.searchParams.delete("tab");
      } else {
        url.searchParams.set("tab", tab);
      }
      window.history.replaceState(null, "", url.toString());
      // Force a re-render — useSearchParams doesn't observe
      // history.replaceState by itself.
      router.replace(
        (url.pathname + url.search + url.hash) as string,
        // ``scroll: false`` keeps the current scroll position so the
        // operator's spot in a long tab doesn't jump to the top.
        // The ``@/i18n/navigation`` wrapper accepts this via its
        // second-arg options object.
        { scroll: false } as never,
      );
    },
    [router],
  );

  const [formulation, setFormulation] = useState(initialFormulation);
  const [metadata, setMetadata] = useState<MetadataDraft>(
    metadataFrom(initialFormulation),
  );
  const [lines, setLines] = useState<BuilderLine[]>(
    linesFrom(initialFormulation),
  );
  // Grams-side draft for the powder fill-weight input. The source
  // of truth stays on ``metadata.target_fill_weight_mg`` (mg, matches
  // the API); this local state just preserves what the scientist
  // literally typed (e.g. the trailing ``.`` in ``10.``) so the
  // controlled input doesn't clobber it on each re-render.
  const [powderFillG, setPowderFillG] = useState<string>(() =>
    mgStringToG(metadataFrom(initialFormulation).target_fill_weight_mg),
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Live caches of picked-item names per excipient picker, keyed by
  // item id. Hydrated from the server-saved formulation on mount and
  // refreshed by the picker's ``onPickedItemsChange`` callback so the
  // totals panel can render brackets like "Carrier (Maltodextrin)"
  // and "Anti-caking Agents (Silicon Dioxide)" the moment the
  // scientist toggles a checkbox -- without waiting for a save +
  // server round-trip to refresh the formulation prop.
  // Live caches for capsule shell picks. Same pattern as MCC /
  // anti-caking. Reads ``ingredient_list_name`` when non-empty so
  // the label shows the marketed name (e.g. "Vegetable Capsule
  // Shell") rather than the internal name if the two differ.
  const [capsuleShellNames, setCapsuleShellNames] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      (initialFormulation.capsule_shell_items ?? []).map((i) => [
        i.id,
        i.name,
      ]),
    ),
  );
  const [capsuleShellCodes, setCapsuleShellCodes] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      (initialFormulation.capsule_shell_items ?? []).map((i) => [
        i.id,
        i.internal_code,
      ]),
    ),
  );
  // Compute-critical attributes (``capsule_size``,
  // ``shell_weight_mg``) live on the picked shell's ``attributes``
  // map. Server echo only refreshes after a save round-trip, so a
  // freshly-toggled shell would miss its attributes on the FIRST
  // compute — this cache holds the picker's ``onPickedItemsChange``
  // snapshot so live compute reads the right values instantly.
  const [capsuleShellAttrs, setCapsuleShellAttrs] = useState<
    Record<string, Readonly<Record<string, unknown>>>
  >(() =>
    Object.fromEntries(
      (initialFormulation.capsule_shell_items ?? []).map((i) => [
        i.id,
        i.attributes ?? {},
      ]),
    ),
  );
  const [mccCarrierNames, setMccCarrierNames] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      initialFormulation.mcc_carrier_items.map((i) => [i.id, i.name]),
    ),
  );
  const [antiCakingNames, setAntiCakingNames] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      initialFormulation.anti_caking_items.map((i) => [i.id, i.name]),
    ),
  );
  // Parallel code caches so the BOM's excipient-band rows can show
  // the picked SKU the moment the checkbox toggles — the server
  // echo only lands after a save round-trip, and users expect
  // instant feedback. Same merge pattern as the name caches.
  const [mccCarrierCodes, setMccCarrierCodes] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      initialFormulation.mcc_carrier_items.map((i) => [i.id, i.internal_code]),
    ),
  );
  const [antiCakingCodes, setAntiCakingCodes] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      initialFormulation.anti_caking_items.map((i) => [i.id, i.internal_code]),
    ),
  );
  // Same live-cache pattern as MCC + anti-caking: powder carrier
  // brackets ("Carrier (Maltodextrin)") need the picked item names
  // the moment the scientist toggles a checkbox, not after a save
  // round-trip refreshes the formulation echo.
  const [powderCarrierNames, setPowderCarrierNames] = useState<
    Record<string, string>
  >(() =>
    Object.fromEntries(
      // Use the item's bare name (e.g. "Maltodextrin"), NOT
      // ``ingredient_list_name`` -- the row label gets wrapped as
      // "Carrier (...)" by the totals panel's grouping helper, so a
      // ``ingredient_list_name`` of "Carrier (Maltodextrin)" would
      // double-bracket into "Carrier (Carrier (Maltodextrin))". The
      // EU 1169 declaration uses ``ingredient_list_name`` separately.
      initialFormulation.powder_carrier_items.map((i) => [i.id, i.name]),
    ),
  );
  // Live cache for acidity picks. Unlike the other live caches this
  // one carries more than a name -- powder formulations read each
  // pick's ``powder_water_dose_mg_per_ml`` rate plus ``use_as`` for
  // the per-item mg math. Hydrated from the server echo on mount;
  // refreshed by the acidity picker's ``onPickedItemsChange`` so a
  // freshly-checked item flows into the math the moment the
  // scientist toggles it, without waiting for a save round-trip.
  const [acidityLive, setAcidityLive] = useState<
    Record<
      string,
      {
        readonly label: string;
        /** Raw PSP catalog name. ``label`` above is the EU-1169
         *  declaration string (``ingredient_list_name || name``) —
         *  which the ingredient declaration wants but the BOM /
         *  Routing / Fine-tune displays should show the actual SKU
         *  name the operator picked. */
        readonly name: string;
        readonly useAs: string;
        readonly waterDoseMgPerMl: number | null;
      }
    >
  >(() =>
    Object.fromEntries(
      initialFormulation.acidity_items.map((i) => [
        i.id,
        {
          label: i.ingredient_list_name || i.name,
          name: i.name,
          useAs: i.use_as || "",
          waterDoseMgPerMl: i.water_dose_mg_per_ml,
        },
      ]),
    ),
  );
  // Same live-cache pattern for the per-item powder bands. Without
  // these the math reads from ``formulation.<band>_items`` (the
  // server-saved echo), which lags every fresh pick by a save +
  // refetch -- the symptom is "I picked a flavouring item but the
  // Excipients panel still shows 0 mg". The cache is hydrated from
  // the server echo on mount and refreshed by each picker's
  // ``onPickedItemsChange`` so a checkbox toggle flows into the
  // math the same render.
  type PowderBandLiveEntry = {
    readonly label: string;
    /** Raw PSP catalog name — what the operator sees in the picker
     *  list. ``label`` above prefers ``ingredient_list_name`` (EU-
     *  1169 declaration string, often generic) for compute; the BOM
     *  / Fine-tune / Routing UI wants ``name`` (the specific SKU
     *  they clicked). */
    readonly name: string;
    readonly useAs: string;
    readonly powderRateMgPerG: number | null;
  };
  const hydrateBand = (
    picks: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly ingredient_list_name: string;
      readonly use_as: string;
      readonly powder_rate_mg_per_g: number | null;
    }>,
  ): Record<string, PowderBandLiveEntry> =>
    Object.fromEntries(
      picks.map((i) => [
        i.id,
        {
          label: i.ingredient_list_name || i.name,
          name: i.name,
          useAs: i.use_as || "",
          powderRateMgPerG: i.powder_rate_mg_per_g,
        },
      ]),
    );
  const [flavouringLive, setFlavouringLive] = useState<
    Record<string, PowderBandLiveEntry>
  >(() => hydrateBand(initialFormulation.flavouring_items));
  const [sweetenerLive, setSweetenerLive] = useState<
    Record<string, PowderBandLiveEntry>
  >(() => hydrateBand(initialFormulation.sweetener_items));
  const [colourLive, setColourLive] = useState<
    Record<string, PowderBandLiveEntry>
  >(() => hydrateBand(initialFormulation.colour_items));

  //: Shared "recent picks" cache updated by every picker's
  //: ``onPickedItemsChange``. Keyed by ``Item.id``, carries the
  //: minimum a downstream row needs to render — a human name, the
  //: catalogue SKU, and the PSP source UUID for the "Open on PSP"
  //: deep-link. Bands that lack a dedicated live cache (gelling /
  //: glazing / premix_sweetener / gummy_base / dcp) read from here
  //: so a freshly-clicked pick shows its real name in the same
  //: render instead of leaking its UUID into the fine-tune panel.
  type PendingPickEntry = {
    readonly name: string;
    readonly code: string;
    readonly pspSourceUuid: string | null;
  };
  const [pendingPicksCache, setPendingPicksCache] = useState<
    Record<string, PendingPickEntry>
  >(() => {
    const seed: Record<string, PendingPickEntry> = {};
    const collect = (
      rows: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly internal_code: string;
        readonly psp_source_uuid: string | null;
      }>,
    ) => {
      for (const r of rows) {
        seed[r.id] = {
          name: r.name,
          code: r.internal_code,
          pspSourceUuid: r.psp_source_uuid ?? null,
        };
      }
    };
    collect(initialFormulation.gummy_base_items ?? []);
    collect(initialFormulation.glazing_items ?? []);
    collect(initialFormulation.gelling_items ?? []);
    collect(initialFormulation.premix_sweetener_items ?? []);
    collect(initialFormulation.dcp_carrier_items ?? []);
    return seed;
  });
  const mergePendingPicks = useCallback(
    (
      items: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly internal_code: string;
        readonly psp_source_uuid: string | null;
        readonly attributes?: Readonly<Record<string, unknown>>;
      }>,
    ) => {
      setPendingPicksCache((prev) => {
        const next = { ...prev };
        for (const it of items) {
          next[it.id] = {
            name: it.name,
            code: it.internal_code,
            // Prefer the picker's explicit ``psp_source_uuid`` (drawn
            // from the pspToLocal reverse map, so freshly-mirrored PSP
            // picks light up their "Open on PSP" link on first click);
            // fall through to any prior cache entry so a stale echo
            // load doesn't clobber a known uuid.
            pspSourceUuid:
              it.psp_source_uuid ?? prev[it.id]?.pspSourceUuid ?? null,
          };
        }
        return next;
      });
    },
    [],
  );
  //: Raw text from the picker input — updates on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  //: Debounced query that drives the picker cache key. Lags by 200ms.
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const updateMutation = useUpdateFormulation(orgId, formulation.id);
  const replaceLinesMutation = useReplaceLines(orgId, formulation.id);
  const saveVersionMutation = useSaveVersion(orgId, formulation.id);
  const syncPspMutation = useSyncFormulationToPsp(orgId, formulation.id);
  const wizardRoutingMutation = useSaveWizardRouting(orgId, formulation.id);

  // Wizard step 3 — draft routing state keyed by row-key.
  // ``routing_key`` shape:
  //   * ``active:${line.id}`` — an operator-picked ingredient line
  //   * ``band:${band_key}:${item_id}`` — a compute-derived pick
  // Value is the target stage_id (string) or null (unassigned).
  const [routingByKey, setRoutingByKey] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  // Baseline from server so we can compute dirty + skip un-changed
  // rows on save. Recomputed when ``lines`` reload.
  const routingBaseline = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const line of lines) {
      const key =
        (line as unknown as { source_kind?: string }).source_kind === "band_pick"
          ? `band:${(line as unknown as { band_key?: string }).band_key ?? ""}:${line.item_id}`
          : `active:${line.key}`;
      map.set(key, line.stage_id);
    }
    return map;
  }, [lines]);
  // Re-seed the draft from the fresh baseline whenever the server
  // returns new line data (initial mount, after a save round-trip,
  // after a version rollback). Keeps the draft in sync without
  // clobbering an unsaved edit — if the user hasn't touched
  // anything, draft === baseline anyway.
  useEffect(() => {
    setRoutingByKey(new Map(routingBaseline));
  }, [routingBaseline]);

  const routingDirty = useMemo(() => {
    if (routingByKey.size !== routingBaseline.size) return true;
    for (const [key, val] of routingByKey.entries()) {
      if (routingBaseline.get(key) !== val) return true;
    }
    return false;
  }, [routingByKey, routingBaseline]);

  // Late-bound ref so handleSaveRouting can read the latest
  // ``bomLinesByStage`` at click-time without pulling its declaration
  // above where the useMemo lives (would force a big reshuffle of
  // the component body). Populated in an effect further down.
  const bomLinesByStageRef = useRef<
    ReadonlyMap<string, readonly BomLine[]>
  >(new Map());

  const handleSaveRouting = useCallback(async () => {
    // Actives are saved by ``handleSaveLines`` — this endpoint only
    // ships band picks (flavouring / sweetener / colour / etc.),
    // which don't exist as ``FormulationLine`` rows until the wizard
    // routing service materializes them. Empty payload = nothing to
    // sync, skip the round-trip.
    const band_assignments: {
      item_id: string;
      band_key: string;
      mg: number;
      stage_id: string | null;
    }[] = [];
    // Compute-derived mg + band + item_id per band pick, resolved
    // from the live full-BOM map.
    const bomIndex = new Map<
      string,
      { itemId: string; bandKey: string; mg: number }
    >();
    bomLinesByStageRef.current.forEach((rows) => {
      for (const row of rows) {
        if (!row.itemId) continue;
        const [prefix] = row.key.split(":");
        if (!prefix || prefix === "active") continue;
        const bandKey =
          prefix === "anticaking"
            ? "anti_caking"
            : prefix === "mcc"
              ? "mcc"
              : prefix === "dcp"
                ? "dcp"
                : prefix === "capsule-shell"
                  ? "capsule_shell"
                  : prefix;
        bomIndex.set(`band:${bandKey}:${row.itemId}`, {
          itemId: row.itemId,
          bandKey,
          mg: row.mg,
        });
      }
    });
    for (const [key, stageId] of routingByKey.entries()) {
      if (!key.startsWith("band:")) continue;
      const entry = bomIndex.get(key);
      if (!entry) continue;
      band_assignments.push({
        item_id: entry.itemId,
        band_key: entry.bandKey,
        mg: entry.mg,
        stage_id: stageId,
      });
    }
    if (band_assignments.length === 0) return;
    try {
      const updated = await wizardRoutingMutation.mutateAsync({
        line_assignments: {},
        band_assignments,
      });
      // Refresh local state so ``routingBaseline`` recomputes and
      // the "unsaved" dot on the Routing tab actually clears.
      setFormulation(updated);
      setLines(linesFrom(updated));
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }, [routingByKey, wizardRoutingMutation, tErrors]);
  const rollbackMutation = useRollbackFormulation(orgId, formulation.id);
  const approveMutation = useSetApprovedVersion(orgId, formulation.id);
  const versionsQuery = useFormulationVersions(orgId, formulation.id);

  // Bubble-up dirty state + inline-save handle from the stage strip
  // so the top-of-page Save version / Save draft buttons react to
  // stage edits (rename, add / remove stage, workstation swap, PSP
  // identity change) the same way they react to line + metadata
  // edits. Without this the operator can rearrange stages, see the
  // "unsaved changes" chip on the strip, but the header CTAs stay
  // greyed out.
  const [stagesDirty, setStagesDirty] = useState(false);
  const stagesSaveHandleRef = useRef<
    (() => Promise<FormulationDto>) | null
  >(null);

  const numberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 4,
      }),
    [locale],
  );

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  // ---------------------------------------------------------------------
  // PSP integration handles — need to sit above the live compute
  // useMemo because the capsule-shell catalog it fetches is a compute
  // input (auto-pick considers PSP's actual shells first).
  // ---------------------------------------------------------------------
  const organizationForCompute = useOrganization(orgId);
  const pspLiveForCompute = Boolean(organizationForCompute?.psp_live);

  // Full PSP capsule-shell catalog for auto-pick. Fires ONCE per
  // mount (unfiltered by search) — separate from the picker's
  // typeahead query so the catalog stays warm for compute
  // regardless of what the operator is typing. Only enabled on
  // capsule formulations with PSP live; other dosage forms don't
  // need it.
  const pspCapsuleShellQueryForCompute = usePspItems(orgId, {
    enabled: pspLiveForCompute && metadata.dosage_form === "capsule",
    useAs: "Capsule Shell",
    itemTypes: ["raw_material"],
  });
  const pspCapsuleShellCatalog = useMemo(() => {
    const rows = pspCapsuleShellQueryForCompute.data?.items ?? [];
    // Project to compute's CapsuleShellCandidate shape. Skip
    // shells with no ``max_weight_mg`` — auto-pick can only
    // reason about shells whose fill capacity is known.
    return rows
      .map((r) => {
        const rawMax = r.attributes?.["max_weight_mg"];
        const num =
          typeof rawMax === "number"
            ? rawMax
            : typeof rawMax === "string"
              ? Number.parseFloat(rawMax)
              : NaN;
        if (!Number.isFinite(num) || num <= 0) return null;
        const rawSize = r.attributes?.["capsule_size"];
        return {
          uuid: r.uuid,
          name: r.name,
          code: r.code || r.external_sku || "",
          capsuleSize:
            typeof rawSize === "string" && rawSize.trim()
              ? rawSize.trim()
              : null,
          maxWeightMg: num,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [pspCapsuleShellQueryForCompute.data]);

  // ---------------------------------------------------------------------
  // Live client-side math — runs on every render, re-computes whenever
  // the metadata or lines state changes. No network calls, no
  // debounce; the totals block updates synchronously as the scientist
  // types a label claim or swaps a capsule size.
  // ---------------------------------------------------------------------
  const liveTotals: FormulationTotals = useMemo(() => {
    const computeInputs: ComputeLineInput[] = lines.map((line) => {
      const parseOverride = (raw: string): number | null => {
        if (!raw) return null;
        const v = Number.parseFloat(raw);
        return Number.isFinite(v) ? v : null;
      };
      return {
        externalId: line.key,
        attributes: line.item_attributes,
        labelClaimMg: Number.parseFloat(line.label_claim_mg || "0"),
        servingSizeOverride: null,
        purityOverride: parseOverride(line.purity_override),
        overageOverride: parseOverride(line.overage_override),
        extractRatioOverride: parseOverride(line.extract_ratio_override),
        fallbackName: line.item_name,
      };
    });
    const parsedFill = Number.parseFloat(metadata.target_fill_weight_mg);
    const parsedWater = Number.parseFloat(metadata.water_volume_ml);
    // Gummy-base picks flow through to the breakdown so the totals
    // panel can render one row per pick ("Sweeteners (Xylitol) …
    // 975 mg", "Sweeteners (Maltitol) … 975 mg"). Skips non-gummy
    // forms; empty picks render a generic "Gummy Base" row.
    // Iterate the LIVE picked ids from ``metadata`` and resolve each
    // through the server echo → ``pendingPicksCache`` (fed by every
    // gummy picker's ``onPickedItemsChange``). Prior implementation
    // read only from the server echo, which meant a fresh pick
    // wouldn't reach compute until after a save — the fine-tune panel
    // then rendered a band-aggregate placeholder row (no ``itemId``,
    // read-only) instead of one editable row per SKU.
    const gummyBaseEchoById = new Map(
      formulation.gummy_base_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
        },
      ]),
    );
    const resolveGummyPick = (
      id: string,
      echo: { label: string; useAs: string } | undefined,
    ): { id: string; label: string; useAs: string } | null => {
      const cached = pendingPicksCache[id];
      if (!echo && !cached) return null;
      return {
        id,
        label: echo?.label || cached?.name || "",
        useAs: echo?.useAs || "",
      };
    };
    const gummyBaseForMath =
      metadata.dosage_form === "gummy"
        ? metadata.gummy_base_item_ids
            .map((id) => resolveGummyPick(id, gummyBaseEchoById.get(id)))
            .filter(
              (
                entry,
              ): entry is { id: string; label: string; useAs: string } =>
                entry !== null,
            )
        : [];
    // Flavouring + Colour picks — split bands at separate percentages
    // (0.4% / 2% of target gummy weight). The math splits each block
    // equally across its picks; empty picks fall back to a generic
    // placeholder row at the full block total.
    // Powder Flavouring / Colour both carry a per-item mg/g rate
    // (``powder_rate_mg_per_g`` on the echo, sourced from the
    // catalogue item's ``powder_<band>_mg_per_g`` attribute). The
    // math reads the rate off each pick to dose it individually; if
    // the rate is null the row is dropped + a soft warning fires so
    // the scientist knows which raw material needs the value set.
    // Gummy formulations ignore the per-item rate -- the gummy
    // branch still uses band-level percentages of the target weight.
    // Mirror the acidity pattern: iterate the LIVE id list from
    // ``metadata`` and resolve each id through the live cache first
    // (populated by the picker's ``onPickedItemsChange``), then fall
    // back to the saved server echo. This is what makes a freshly-
    // toggled pick show up in the Excipients panel without a save
    // round-trip.
    const flavouringEchoById = new Map(
      formulation.flavouring_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
          powderRateMgPerG: pick.powder_rate_mg_per_g,
        },
      ]),
    );
    const flavouringForMath =
      metadata.dosage_form === "gummy" ||
      metadata.dosage_form === "powder"
        ? metadata.flavouring_item_ids
            .map((id) => {
              const live = flavouringLive[id];
              const echo = flavouringEchoById.get(id);
              // Gummy flavouring picks don't populate the powder
              // ``flavouringLive`` cache; fall through to the shared
              // ``pendingPicksCache`` so a freshly-clicked gummy
              // flavouring row lands in compute without waiting on
              // a save round-trip.
              const cached = pendingPicksCache[id];
              if (!live && !echo && !cached) return null;
              return {
                id,
                label: live?.label || echo?.label || cached?.name || "",
                useAs: live?.useAs || echo?.useAs || "",
                powderRateMgPerG:
                  live?.powderRateMgPerG ??
                  echo?.powderRateMgPerG ??
                  null,
              };
            })
            .filter(
              (entry): entry is {
                id: string;
                label: string;
                useAs: string;
                powderRateMgPerG: number | null;
              } => entry !== null,
            )
        : [];
    const colourEchoById = new Map(
      formulation.colour_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
          powderRateMgPerG: pick.powder_rate_mg_per_g,
        },
      ]),
    );
    const colourForMath =
      metadata.dosage_form === "gummy" ||
      metadata.dosage_form === "powder"
        ? metadata.colour_item_ids
            .map((id) => {
              const live = colourLive[id];
              const echo = colourEchoById.get(id);
              // Gummy colour picks fall through to the shared
              // ``pendingPicksCache`` (see ``flavouring`` comment).
              const cached = pendingPicksCache[id];
              if (!live && !echo && !cached) return null;
              return {
                id,
                label: live?.label || echo?.label || cached?.name || "",
                useAs: live?.useAs || echo?.useAs || "",
                powderRateMgPerG:
                  live?.powderRateMgPerG ??
                  echo?.powderRateMgPerG ??
                  null,
              };
            })
            .filter(
              (entry): entry is {
                id: string;
                label: string;
                useAs: string;
                powderRateMgPerG: number | null;
              } => entry !== null,
            )
        : [];
    const glazingEchoById = new Map(
      formulation.glazing_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
        },
      ]),
    );
    const glazingForMath =
      metadata.dosage_form === "gummy"
        ? metadata.glazing_item_ids
            .map((id) => resolveGummyPick(id, glazingEchoById.get(id)))
            .filter(
              (
                entry,
              ): entry is { id: string; label: string; useAs: string } =>
                entry !== null,
            )
        : [];
    // Gelling + premix sweetener — coupled bands. Both feed
    // ``computeFillTarget``; gellingForMath being empty means the
    // gummy is non-gelling and the math suppresses both bands.
    const gellingEchoById = new Map(
      formulation.gelling_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
        },
      ]),
    );
    const gellingForMath =
      metadata.dosage_form === "gummy"
        ? metadata.gelling_item_ids
            .map((id) => resolveGummyPick(id, gellingEchoById.get(id)))
            .filter(
              (
                entry,
              ): entry is { id: string; label: string; useAs: string } =>
                entry !== null,
            )
        : [];
    const premixSweetenerEchoById = new Map(
      formulation.premix_sweetener_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
        },
      ]),
    );
    const premixSweetenerForMath =
      metadata.dosage_form === "gummy"
        ? metadata.premix_sweetener_item_ids
            .map((id) => resolveGummyPick(id, premixSweetenerEchoById.get(id)))
            .filter(
              (
                entry,
              ): entry is { id: string; label: string; useAs: string } =>
                entry !== null,
            )
        : [];
    // Drive acidity math off the LIVE ids (``metadata.acidity_item_ids``)
    // rather than the saved server echo so the totals panel updates
    // the moment the scientist toggles a pick. Each id is resolved
    // against the live cache (populated by the picker's
    // ``onPickedItemsChange``) first, then the server echo as a
    // fallback so already-saved picks still render before the picker
    // has had a chance to fire its callback.
    const echoById = new Map(
      formulation.acidity_items.map((pick) => [
        pick.id,
        {
          label: pick.ingredient_list_name || pick.name,
          useAs: pick.use_as || "",
          waterDoseMgPerMl: pick.water_dose_mg_per_ml,
        },
      ]),
    );
    const acidityForMath =
      metadata.dosage_form === "gummy" ||
      metadata.dosage_form === "powder"
        ? metadata.acidity_item_ids
            .map((id) => {
              const live = acidityLive[id];
              const echo = echoById.get(id);
              if (!live && !echo) return null;
              return {
                id,
                label: live?.label || echo?.label || "",
                useAs: live?.useAs || echo?.useAs || "",
                // Powder-only: per-item mg of acid per ml of
                // reconstitution water. Sourced from the raw
                // material's ``powder_water_dose_mg_per_ml``
                // attribute. ``null`` -> the math drops this row
                // and surfaces a ``powder_acidity_dose_missing``
                // warning so the scientist knows to set the rate
                // in the catalogue.
                waterDoseMgPerMl:
                  live?.waterDoseMgPerMl ??
                  echo?.waterDoseMgPerMl ??
                  null,
              };
            })
            .filter(
              (
                entry,
              ): entry is {
                id: string;
                label: string;
                useAs: string;
                waterDoseMgPerMl: number | null;
              } => entry !== null,
            )
        : [];
    // Compute's capsule size + fill capacity now come from the
    // picked shell's attributes end-to-end. Reads:
    //   * attributes.capsule_size → size key (Single 0, ...)
    //   * attributes.max_weight_mg → fill capacity in mg
    //   * attributes.shell_weight_mg → declared shell mass
    // Live picker cache wins over server echo so freshly-toggled
    // picks drive compute the moment the checkbox fires. Falls
    // back to the legacy ``metadata.capsule_size`` string when no
    // shell is picked — that's how pre-picker formulations still
    // compute; when it's empty too, compute auto-picks from total.
    let shellSizeKey: string | null = null;
    let shellMaxWeightMg: number | null = null;
    if (
      metadata.dosage_form === "capsule" &&
      metadata.capsule_shell_item_ids.length > 0
    ) {
      const firstId = metadata.capsule_shell_item_ids[0] ?? "";
      const liveAttrs = firstId ? capsuleShellAttrs[firstId] : undefined;
      const echoedAttrs = (formulation.capsule_shell_items ?? []).find(
        (i) => i.id === firstId,
      )?.attributes;
      const attrs = liveAttrs ?? echoedAttrs ?? {};

      const sizeRaw = attrs["capsule_size"];
      if (typeof sizeRaw === "string" && sizeRaw.trim()) {
        shellSizeKey = sizeRaw.trim();
      }

      const maxRaw = attrs["max_weight_mg"];
      const maxNum =
        typeof maxRaw === "number"
          ? maxRaw
          : typeof maxRaw === "string"
            ? Number.parseFloat(maxRaw)
            : null;
      if (typeof maxNum === "number" && Number.isFinite(maxNum) && maxNum > 0) {
        shellMaxWeightMg = maxNum;
      }
    }
    // When the operator picks a capsule shell that has NO
    // ``capsule_size`` or ``max_weight_mg`` on its PSP row (data
    // gap that's genuinely common on shells mirrored before those
    // attributes were part of the schema), fall back through the
    // legacy ``metadata.capsule_size`` field so compute still runs
    // against a sensible size. If neither is set, compute auto-picks
    // from total active. This is what preserves the pre-strict math
    // behaviour — the operator sees viability + math instead of a
    // hard "over max weight" that's really a missing-attribute stop.
    const effectiveCapsuleSize =
      shellSizeKey ?? (metadata.capsule_size || null);
    return computeTotals({
      lines: computeInputs,
      dosageForm: metadata.dosage_form,
      capsuleSizeKey: effectiveCapsuleSize,
      capsuleShellOverride:
        shellSizeKey || shellMaxWeightMg
          ? { sizeKey: shellSizeKey, maxWeightMg: shellMaxWeightMg }
          : null,
      // Auto-pick against PSP's real shell catalog when no shell
      // is ticked yet. Compute picks the smallest shell (by
      // ``attributes.max_weight_mg``) that fits with ~21% headroom
      // for MCC / anti-caking / variance. Falls back to the
      // hardcoded ladder when the catalog is empty.
      capsuleShellCatalog: pspCapsuleShellCatalog,
      tabletSizeKey: metadata.tablet_size || null,
      defaultServingSize: metadata.serving_size,
      targetFillWeightMg: Number.isFinite(parsedFill) && parsedFill > 0
        ? parsedFill
        : null,
      powderType: metadata.powder_type,
      waterVolumeMl: Number.isFinite(parsedWater) && parsedWater >= 0
        ? parsedWater
        : null,
      gummyBaseItems: gummyBaseForMath,
      flavouringItems: flavouringForMath,
      colourItems: colourForMath,
      glazingItems: glazingForMath,
      gellingItems: gellingForMath,
      premixSweetenerItems: premixSweetenerForMath,
      acidityItems: acidityForMath,
      // Pass the picked capsule/tablet carriers + anti-caking through
      // so the math gates the auto-fills correctly. The anti-caking
      // labels matter -- the math classifier reads them by name to
      // decide whether each pick contributes to the stearate (1.0%)
      // or silica (0.4%) band, so picking only Silicon Dioxide fires
      // 0.4% rather than the full 1.4%.
      mccCarrierItems: metadata.mcc_carrier_item_ids.map((id) => ({
        id,
        label:
          mccCarrierNames[id] ??
          formulation.mcc_carrier_items.find((i) => i.id === id)?.name ??
          "",
      })),
      dcpCarrierItems: metadata.dcp_carrier_item_ids.map((id) => ({
        id,
        label:
          formulation.dcp_carrier_items.find((i) => i.id === id)?.name ??
          "",
      })),
      antiCakingItems: metadata.anti_caking_item_ids.map((id) => ({
        id,
        label:
          antiCakingNames[id] ??
          formulation.anti_caking_items.find((i) => i.id === id)?.name ??
          "",
      })),
      // Powder carrier picks fill the sachet's remainder band. The
      // label is taken straight from the saved formulation echo
      // Bare item names only -- the grouping helper later wraps
      // them as "Carrier (Maltodextrin, ...)" exactly once. Reading
      // ``ingredient_list_name`` here would double-bracket entries
      // whose EU 1169 form already includes a "Carrier" prefix.
      powderCarrierItems: metadata.powder_carrier_item_ids.map((id) => ({
        id,
        label:
          powderCarrierNames[id] ??
          formulation.powder_carrier_items.find((i) => i.id === id)
            ?.name ??
          "",
      })),
      // Powder sweetener picker (separate from the gummy sweetener
      // pool that goes through gummy_base_items). Live cache resolves
      // each picked id so a freshly-toggled sweetener doses in the
      // current render without a save round-trip; the server echo
      // is the fallback.
      sweetenerItems: metadata.sweetener_item_ids.map((id) => {
        const live = sweetenerLive[id];
        const echo = formulation.sweetener_items.find((i) => i.id === id);
        return {
          id,
          label:
            live?.label ||
            echo?.ingredient_list_name ||
            echo?.name ||
            "",
          useAs: live?.useAs || "Sweeteners",
          powderRateMgPerG:
            live?.powderRateMgPerG ?? echo?.powder_rate_mg_per_g ?? null,
        };
      }),
      excipientOverrides: metadata.excipient_overrides,
    });
  }, [
    lines,
    metadata.dosage_form,
    metadata.capsule_size,
    metadata.capsule_shell_item_ids,
    formulation.capsule_shell_items,
    capsuleShellAttrs,
    pspCapsuleShellCatalog,
    metadata.tablet_size,
    metadata.serving_size,
    metadata.target_fill_weight_mg,
    metadata.powder_type,
    metadata.water_volume_ml,
    metadata.excipient_overrides,
    metadata.mcc_carrier_item_ids,
    metadata.dcp_carrier_item_ids,
    metadata.anti_caking_item_ids,
    metadata.powder_carrier_item_ids,
    metadata.acidity_item_ids,
    metadata.sweetener_item_ids,
    // Live picked-id arrays for every gummy band the new resolver
    // iterates. Prior to this deps addition the memo didn't rerun on
    // a fresh tick, so compute stayed stale and the fine-tune panel
    // rendered band-aggregate placeholder rows even after the fix
    // that swapped the *ForMath iteration onto LIVE ids.
    metadata.flavouring_item_ids,
    metadata.colour_item_ids,
    metadata.gummy_base_item_ids,
    metadata.glazing_item_ids,
    metadata.gelling_item_ids,
    metadata.premix_sweetener_item_ids,
    mccCarrierNames,
    antiCakingNames,
    powderCarrierNames,
    acidityLive,
    flavouringLive,
    sweetenerLive,
    colourLive,
    // Shared "just picked" cache — populated by every gummy picker's
    // ``onPickedItemsChange``. Included so an unsaved pick on
    // gelling / glazing / premix / gummy_base / dcp / flavouring /
    // colour rehydrates the totals in the same render.
    pendingPicksCache,
    formulation.gummy_base_items,
    formulation.powder_carrier_items,
    formulation.sweetener_items,
    formulation.flavouring_items,
    formulation.colour_items,
    formulation.glazing_items,
    formulation.gelling_items,
    formulation.premix_sweetener_items,
    formulation.acidity_items,
  ]);

  // Per-stage BOM — every stage's card renders the FULL formulation
  // BOM (all actives across the main builder + every excipient band
  // split across picked SKUs). Same rows the Fine-tune panel edits.
  // Each stage's PSP item then holds the same complete recipe so
  // what NPD shows = what PSP holds, and no ingredient silently
  // drops off because it was assigned to a different stage bucket.
  //
  // Every stage after the first also prepends a synthesized "1×
  // prior stage's semi-finished" row so the multi-level structure
  // reads at a glance.
  const bomLinesByStage = useMemo(() => {
    const map = new Map<string, readonly BomLine[]>();
    const stages = formulation.stages;
    // Capsule shell picks — merge the picker's live attribute cache
    // (populated on toggle) with the server echo so freshly-toggled
    // shells emit with a resolvable ``shell_weight_mg`` before the
    // save round-trip refreshes ``formulation.capsule_shell_items``.
    // Restricted to ``dosage_form === "capsule"`` — other forms
    // don't ship a shell on the BOM.
    const capsuleShellRows =
      metadata.dosage_form === "capsule"
        ? metadata.capsule_shell_item_ids
            .map((id) => {
              const echo = (formulation.capsule_shell_items ?? []).find(
                (i) => i.id === id,
              );
              const liveAttrs = capsuleShellAttrs[id];
              const liveName = capsuleShellNames[id];
              const liveCode = capsuleShellCodes[id];
              if (!echo && !liveName) return null;
              return {
                id,
                name: echo?.name || liveName || "Capsule shell",
                internal_code: echo?.internal_code || liveCode || "",
                attributes: liveAttrs ?? echo?.attributes ?? {},
              };
            })
            .filter((r): r is NonNullable<typeof r> => r !== null)
        : [];

    // Auto-picked shell fallback — every capsule ships with a shell,
    // so the BOM must list one even when the operator hasn't ticked
    // anything explicit. Prefer a PSP catalog match by capsule size
    // (real SKU + real name + PSP uuid the push cascade can send);
    // fall back to the hardcoded per-size weight with a generic
    // label when the catalog is empty / offline.
    // Match compute's own auto-pick: smallest PSP shell whose
    // ``max_weight_mg`` fits total active with ~21% headroom.
    // Falls back to the hardcoded shell-weight table (indexed by
    // whatever size compute settled on) when the catalog is empty
    // or nothing fits. Only fires when nothing is explicitly ticked.
    const autoCapsuleShell =
      metadata.dosage_form === "capsule" && capsuleShellRows.length === 0
        ? (() => {
            const match = resolveAutoPickedShell(
              pspCapsuleShellCatalog,
              liveTotals.totalActiveMg,
            );
            if (match) {
              const sizeKey = match.capsuleSize || metadata.capsule_size || "";
              return {
                pspItemUuid: match.uuid,
                name: match.name,
                code: match.code,
                shellWeightMg: CAPSULE_SHELL_WEIGHTS[sizeKey] ?? 0,
              };
            }
            const sizeKey = metadata.capsule_size || "";
            const hardcodedWeight = CAPSULE_SHELL_WEIGHTS[sizeKey] ?? 0;
            if (hardcodedWeight <= 0) return null;
            return {
              pspItemUuid: null,
              name: sizeKey
                ? `Capsule Shell (${sizeKey})`
                : "Capsule Shell (Hypromellose)",
              code: "",
              shellWeightMg: hardcodedWeight,
            };
          })()
        : null;
    // Merged {itemId → code + pspSourceUuid} lookup drawn from every
    // server echo + the shared ``pendingPicksCache``. Passed into
    // ``deriveStageBomLines`` so gummy per-item + gummy_base rows can
    // stamp their ``code`` chip + "Open on PSP" link the same way
    // active lines already do — otherwise they'd render as name-only
    // read-only text with no way to cross-reference the SKU on PSP.
    const codeAndUuidSources: readonly (readonly {
      readonly id: string;
      readonly internal_code?: string;
      readonly psp_source_uuid?: string | null;
    }[])[] = [
      formulation.flavouring_items ?? [],
      formulation.sweetener_items ?? [],
      formulation.colour_items ?? [],
      formulation.acidity_items ?? [],
      formulation.gelling_items ?? [],
      formulation.glazing_items ?? [],
      formulation.premix_sweetener_items ?? [],
      formulation.powder_carrier_items ?? [],
      formulation.gummy_base_items ?? [],
      formulation.mcc_carrier_items ?? [],
      formulation.dcp_carrier_items ?? [],
      formulation.anti_caking_items ?? [],
      formulation.capsule_shell_items ?? [],
    ];
    const codeAndUuidById = new Map<
      string,
      { code: string; pspSourceUuid: string | null }
    >();
    for (const source of codeAndUuidSources) {
      for (const pick of source) {
        if (!pick.id) continue;
        codeAndUuidById.set(pick.id, {
          code: pick.internal_code ?? "",
          pspSourceUuid: pick.psp_source_uuid ?? null,
        });
      }
    }
    for (const [id, entry] of Object.entries(pendingPicksCache)) {
      // ``pendingPicksCache`` covers freshly-clicked picks the server
      // echo doesn't know about yet — merge only when the echo entry
      // is missing so a saved echo (with its authoritative code) wins.
      if (!codeAndUuidById.has(id)) {
        codeAndUuidById.set(id, {
          code: entry.code,
          pspSourceUuid: entry.pspSourceUuid,
        });
      }
    }
    const itemLookup = (id: string) =>
      codeAndUuidById.get(id) ?? null;
    const fullBomRaw = deriveStageBomLines({
      totals: liveTotals,
      lines,
      mccCarrierItems: formulation.mcc_carrier_items ?? [],
      dcpCarrierItems: formulation.dcp_carrier_items ?? [],
      antiCakingItems: formulation.anti_caking_items ?? [],
      capsuleShellItems: capsuleShellRows,
      autoCapsuleShell,
      excipientOverrides: metadata.excipient_overrides,
      itemLookup,
    });
    // Rewrite each row's label to the raw PSP item name when we
    // can resolve it — compute's default label falls back to
    // ``ingredient_list_name`` (which is the EU-1169 declaration
    // string, often generic like "Flavouring"). Every BOM / Fine-
    // tune / Routing surface wants the SKU's actual name so the
    // operator sees exactly what they picked, not a category
    // placeholder. Build a single {id → name} lookup across every
    // M2M so the loop stays O(1) per row.
    const nameByItemId = new Map<string, string>();
    const nameLookupSources: readonly (readonly {
      readonly id: string;
      readonly name: string;
    }[])[] = [
      formulation.flavouring_items ?? [],
      formulation.sweetener_items ?? [],
      formulation.colour_items ?? [],
      formulation.acidity_items ?? [],
      formulation.gelling_items ?? [],
      formulation.glazing_items ?? [],
      formulation.premix_sweetener_items ?? [],
      formulation.powder_carrier_items ?? [],
      formulation.gummy_base_items ?? [],
      formulation.mcc_carrier_items ?? [],
      formulation.dcp_carrier_items ?? [],
      formulation.anti_caking_items ?? [],
      formulation.capsule_shell_items ?? [],
    ];
    for (const source of nameLookupSources) {
      for (const pick of source) {
        if (pick.id && pick.name) nameByItemId.set(pick.id, pick.name);
      }
    }
    const fullBomComputed: BomLine[] = fullBomRaw.map((row) => {
      if (!row.itemId) return row;
      const realName = nameByItemId.get(row.itemId);
      if (!realName || realName === row.label) return row;
      return { ...row, label: realName };
    });
    // Guaranteed-visibility pass — some picks drop out of compute
    // silently (e.g. a powder flavouring picked without a
    // ``powder_flavouring_mg_per_g`` attribute → compute pushes a
    // warning + skips the row → operator sees no BOM entry despite
    // the tick). Walk every M2M relevant to the current dosage
    // form and append missing picks at mg=0 with a "rate missing"
    // note so the scientist always sees what they've ticked.
    const seenItemIds = new Set<string>(
      fullBomComputed
        .map((r) => r.itemId)
        .filter((id): id is string => Boolean(id)),
    );
    // Iterate the LIVE M2M ids the operator has ticked (from
    // ``metadata.*_item_ids``, updates on click, no save needed) so
    // freshly-added picks show up immediately. Name resolution
    // walks in priority order:
    //   1. Live cache populated by the picker's onPickedItemsChange
    //      (has the label the operator just clicked).
    //   2. Server echo (persisted picks — has the full attribute
    //      bag including allergens, use_as etc).
    //   3. Item id as a last-ditch label so the row still renders
    //      even when both caches missed.
    const ensuredRows: BomLine[] = [];
    type EchoLike = {
      readonly id: string;
      readonly name?: string;
      readonly internal_code?: string;
      readonly ingredient_list_name?: string;
      /** Populated on PSP-mirrored echo rows; drives the "Open on
       *  PSP" deep link on every downstream display. */
      readonly psp_source_uuid?: string | null;
    };
    const buildEchoMap = (rows: readonly EchoLike[]) =>
      new Map(rows.map((r) => [r.id, r]));
    const echoMaps = {
      flavouring: buildEchoMap(formulation.flavouring_items ?? []),
      sweetener: buildEchoMap(formulation.sweetener_items ?? []),
      colour: buildEchoMap(formulation.colour_items ?? []),
      acidity: buildEchoMap(formulation.acidity_items ?? []),
      gelling: buildEchoMap(formulation.gelling_items ?? []),
      glazing: buildEchoMap(formulation.glazing_items ?? []),
      premix_sweetener: buildEchoMap(formulation.premix_sweetener_items ?? []),
      powder_carrier: buildEchoMap(formulation.powder_carrier_items ?? []),
      gummy_base: buildEchoMap(formulation.gummy_base_items ?? []),
      mcc: buildEchoMap(formulation.mcc_carrier_items ?? []),
      dcp: buildEchoMap(formulation.dcp_carrier_items ?? []),
      anti_caking: buildEchoMap(formulation.anti_caking_items ?? []),
      capsule_shell: buildEchoMap(formulation.capsule_shell_items ?? []),
    } as const;
    type BandKind = keyof typeof echoMaps;
    const resolveName = (
      band: BandKind,
      itemId: string,
    ): { name: string; code: string; pspSourceUuid: string | null } => {
      // Live caches — prefer the raw PSP name (``it.name``) over
      // the declaration label (``ingredient_list_name``). The BOM /
      // Fine-tune / Routing displays show the SKU the operator
      // actually clicked ("Apple Flavouring 2sp-86644 (Natural)"),
      // not the generic declaration string ("Apple").
      const liveMap: Record<BandKind, string | undefined> = {
        flavouring: flavouringLive[itemId]?.name,
        sweetener: sweetenerLive[itemId]?.name,
        colour: colourLive[itemId]?.name,
        acidity: acidityLive[itemId]?.name,
        mcc: mccCarrierNames[itemId],
        anti_caking: antiCakingNames[itemId],
        powder_carrier: powderCarrierNames[itemId],
        capsule_shell: capsuleShellNames[itemId],
        // No dedicated live cache for these bands yet — they read
        // through the shared ``pendingPicksCache`` seeded by every
        // picker's ``onPickedItemsChange`` so a freshly-clicked pick
        // resolves to its name in the same render.
        gelling: undefined,
        glazing: undefined,
        premix_sweetener: undefined,
        gummy_base: undefined,
        dcp: undefined,
      };
      const liveName = liveMap[band];
      const echo = echoMaps[band].get(itemId);
      const cached = pendingPicksCache[itemId];
      const code =
        band === "capsule_shell"
          ? capsuleShellCodes[itemId] ??
            echo?.internal_code ??
            cached?.code ??
            ""
          : echo?.internal_code ?? cached?.code ?? "";
      // Fallback order: live picker cache → server echo → shared
      // pending-picks cache (updated by any picker's
      // ``onPickedItemsChange``) → an explicit "unsaved pick" label
      // so raw UUIDs never leak into the UI.
      const name =
        liveName || echo?.name || cached?.name || "(unsaved pick — save draft to name it)";
      const pspSourceUuid =
        echo?.psp_source_uuid ?? cached?.pspSourceUuid ?? null;
      return { name, code, pspSourceUuid };
    };
    const bandsToEnsure: readonly {
      readonly bandKey: BandKind;
      readonly ids: readonly string[];
    }[] = [
      { bandKey: "flavouring", ids: metadata.flavouring_item_ids },
      { bandKey: "sweetener", ids: metadata.sweetener_item_ids },
      { bandKey: "colour", ids: metadata.colour_item_ids },
      { bandKey: "acidity", ids: metadata.acidity_item_ids },
      { bandKey: "gelling", ids: metadata.gelling_item_ids },
      { bandKey: "glazing", ids: metadata.glazing_item_ids },
      {
        bandKey: "premix_sweetener",
        ids: metadata.premix_sweetener_item_ids,
      },
      { bandKey: "powder_carrier", ids: metadata.powder_carrier_item_ids },
      { bandKey: "gummy_base", ids: metadata.gummy_base_item_ids },
      { bandKey: "mcc", ids: metadata.mcc_carrier_item_ids },
      { bandKey: "dcp", ids: metadata.dcp_carrier_item_ids },
      { bandKey: "anti_caking", ids: metadata.anti_caking_item_ids },
      { bandKey: "capsule_shell", ids: metadata.capsule_shell_item_ids },
    ];
    for (const band of bandsToEnsure) {
      for (const itemId of band.ids) {
        if (!itemId || seenItemIds.has(itemId)) continue;
        const { name, code, pspSourceUuid } = resolveName(
          band.bandKey,
          itemId,
        );
        ensuredRows.push({
          key: `${band.bandKey}:${itemId}`,
          label: name,
          code,
          mg: 0,
          itemId,
          pspItemUuid: pspSourceUuid,
        });
        seenItemIds.add(itemId);
      }
    }
    const fullBom: BomLine[] = ensuredRows.length
      ? [...fullBomComputed, ...ensuredRows].sort((a, b) => a.mg - b.mg)
      : fullBomComputed;
    stages.forEach((stage, i) => {
      const prior = i > 0 ? stages[i - 1] : undefined;
      if (prior) {
        const priorLabel =
          prior.psp_item_name?.trim() ||
          prior.name?.trim() ||
          `Stage ${prior.sort_order + 1}`;
        const semiRow: BomLine = {
          key: `semi:${prior.id}`,
          label: `${priorLabel} (semi-finished)`,
          code: "",
          mg: 1,
          itemId: null,
        };
        map.set(stage.id, [semiRow, ...fullBom]);
      } else {
        map.set(stage.id, fullBom);
      }
    });
    return map;
  }, [
    liveTotals,
    lines,
    formulation.mcc_carrier_items,
    formulation.dcp_carrier_items,
    formulation.anti_caking_items,
    formulation.capsule_shell_items,
    formulation.flavouring_items,
    formulation.sweetener_items,
    formulation.colour_items,
    formulation.acidity_items,
    formulation.gelling_items,
    formulation.glazing_items,
    formulation.premix_sweetener_items,
    formulation.powder_carrier_items,
    formulation.gummy_base_items,
    formulation.stages,
    metadata.dosage_form,
    metadata.capsule_size,
    metadata.capsule_shell_item_ids,
    metadata.flavouring_item_ids,
    metadata.sweetener_item_ids,
    metadata.colour_item_ids,
    metadata.acidity_item_ids,
    metadata.gelling_item_ids,
    metadata.glazing_item_ids,
    metadata.premix_sweetener_item_ids,
    metadata.powder_carrier_item_ids,
    metadata.gummy_base_item_ids,
    metadata.mcc_carrier_item_ids,
    metadata.dcp_carrier_item_ids,
    metadata.anti_caking_item_ids,
    metadata.excipient_overrides,
    capsuleShellAttrs,
    capsuleShellNames,
    capsuleShellCodes,
    flavouringLive,
    sweetenerLive,
    colourLive,
    acidityLive,
    mccCarrierNames,
    antiCakingNames,
    powderCarrierNames,
    pspCapsuleShellCatalog,
    // Shared "just picked" cache used by ``itemLookup`` (feeds code +
    // PSP UUID to gummy per-item + gummy_base BomLine rows) and by
    // ``resolveName`` for the ensured-visibility ensured-rows pass.
    pendingPicksCache,
  ]);

  // Late-bind bomLinesByStage into the ref that ``handleSaveRouting``
  // reads at click-time. Keeps the wizard save handler's closure
  // dependency graph small (routingByKey + routingBaseline only).
  useEffect(() => {
    bomLinesByStageRef.current = bomLinesByStage;
  }, [bomLinesByStage]);

  //: F2a — compliance + ingredient declaration re-compute on every
  //: render from the same lines array. Both are pure and cheap.
  const compliance: ComplianceResult = useMemo(
    () =>
      computeCompliance(
        lines.map((line) => ({ attributes: line.item_attributes })),
      ),
    [lines],
  );

  const allergens: AllergensResult = useMemo(
    () =>
      computeAllergens(
        lines.map((line) => ({ attributes: line.item_attributes })),
      ),
    [lines],
  );

  // Stable arrays for the labels in the totals panel's bracket lists
  // ("Carrier (Maltodextrin)", "Anti-caking Agents (Silicon Dioxide)").
  // Previously rebuilt inline in JSX on every render which defeated
  // React.memo on TotalsBlock -- a fresh array identity per render
  // forced a full repaint even when no picked items had changed.
  const mccCarrierLabels = useMemo(
    () =>
      metadata.mcc_carrier_item_ids
        .map(
          (id) =>
            mccCarrierNames[id] ??
            formulation.mcc_carrier_items.find((i) => i.id === id)?.name ??
            "",
        )
        .filter((name) => name !== ""),
    [
      metadata.mcc_carrier_item_ids,
      mccCarrierNames,
      formulation.mcc_carrier_items,
    ],
  );

  const antiCakingLabels = useMemo(
    () =>
      metadata.anti_caking_item_ids
        .map(
          (id) =>
            antiCakingNames[id] ??
            formulation.anti_caking_items.find((i) => i.id === id)?.name ??
            "",
        )
        .filter((name) => name !== ""),
    [
      metadata.anti_caking_item_ids,
      antiCakingNames,
      formulation.anti_caking_items,
    ],
  );

  // Same live-name resolution for DCP carrier picks. No dedicated
  // live-name cache exists (the picker doesn't emit
  // ``onPickedItemsChange`` for DCP), so the server echo carries
  // the whole load — post-save it's fresh, pre-save the fallback
  // to the canonical label kicks in.
  const dcpCarrierLabels = useMemo(
    () =>
      metadata.dcp_carrier_item_ids
        .map(
          (id) =>
            formulation.dcp_carrier_items.find((i) => i.id === id)?.name ?? "",
        )
        .filter((name) => name !== ""),
    [metadata.dcp_carrier_item_ids, formulation.dcp_carrier_items],
  );

  // Picked-item lookups keyed to id + name + code — feeds the editable
  // per-item mg override on the Excipients panel and the shared
  // ``allocateBandShares`` allocator used by BomCard / stage BOM. Names
  // prefer the live picker cache (freshly-toggled picks) with a
  // server-echo fallback; codes come off the echo only. Filter out
  // ids we can't resolve to a name so a stale metadata id doesn't
  // render as an empty row.
  const mccCarrierPicks = useMemo<BandPick[]>(
    () =>
      metadata.mcc_carrier_item_ids
        .map((id) => {
          const server = formulation.mcc_carrier_items.find((i) => i.id === id);
          const name = mccCarrierNames[id] ?? server?.name ?? "";
          if (!name) return null;
          return { id, name, internal_code: server?.internal_code ?? "" };
        })
        .filter((p): p is BandPick => p !== null),
    [
      metadata.mcc_carrier_item_ids,
      mccCarrierNames,
      formulation.mcc_carrier_items,
    ],
  );
  const antiCakingPicks = useMemo<BandPick[]>(
    () =>
      metadata.anti_caking_item_ids
        .map((id) => {
          const server = formulation.anti_caking_items.find((i) => i.id === id);
          const name = antiCakingNames[id] ?? server?.name ?? "";
          if (!name) return null;
          return { id, name, internal_code: server?.internal_code ?? "" };
        })
        .filter((p): p is BandPick => p !== null),
    [
      metadata.anti_caking_item_ids,
      antiCakingNames,
      formulation.anti_caking_items,
    ],
  );
  const dcpCarrierPicks = useMemo<BandPick[]>(
    () =>
      metadata.dcp_carrier_item_ids
        .map((id) => {
          const server = formulation.dcp_carrier_items.find((i) => i.id === id);
          const name = server?.name ?? "";
          if (!name) return null;
          return { id, name, internal_code: server?.internal_code ?? "" };
        })
        .filter((p): p is BandPick => p !== null),
    [metadata.dcp_carrier_item_ids, formulation.dcp_carrier_items],
  );

  // Resolve the picked capsule shell (first pick — the M2M shape
  // matches other pickers even though shells are typically one).
  // Feeds both the declaration (label + shell mass) and, upstream,
  // the compute (size override) — attribute values come off the
  // server echo which now includes the full ``attributes`` map.
  const capsuleShellPick = useMemo(() => {
    if (metadata.dosage_form !== "capsule") return null;
    if (metadata.capsule_shell_item_ids.length === 0) return null;
    const firstId = metadata.capsule_shell_item_ids[0] ?? "";
    if (!firstId) return null;
    const pick = (formulation.capsule_shell_items ?? []).find(
      (i) => i.id === firstId,
    );
    // Live cache first (freshly-toggled picks), server echo
    // second (persisted picks). Either can drive the declaration
    // row — the compute path uses the same precedence for
    // ``capsule_size``.
    const liveAttrs = capsuleShellAttrs[firstId];
    const attrs = liveAttrs ?? pick?.attributes ?? {};
    const liveName = capsuleShellNames[firstId];
    const name =
      (attrs["ingredient_list_name"] as string | undefined) ||
      liveName ||
      pick?.name ||
      "";
    if (!name) return null;
    const rawWeight = attrs["shell_weight_mg"];
    const weight =
      typeof rawWeight === "number"
        ? rawWeight
        : typeof rawWeight === "string"
          ? Number.parseFloat(rawWeight)
          : null;
    return {
      name,
      shellWeightMg: Number.isFinite(weight) ? (weight as number) : null,
    };
  }, [
    metadata.dosage_form,
    metadata.capsule_shell_item_ids,
    formulation.capsule_shell_items,
    capsuleShellAttrs,
    capsuleShellNames,
  ]);

  // Consumer-facing ingredient declaration. Picked SKUs override
  // the canonical excipient placeholders ("Microcrystalline
  // Cellulose (Carrier)", "Anticaking Agents (...)") so the label
  // reads the actual pack contents, matching what the BOM prints.
  const declaration: IngredientDeclaration = useMemo(
    () =>
      buildIngredientDeclaration({
        lines: lines.map((line) => ({
          externalId: line.key,
          attributes: line.item_attributes,
          fallbackName: line.item_name,
        })),
        totals: liveTotals,
        mccCarrierPicks: mccCarrierLabels,
        dcpCarrierPicks: dcpCarrierLabels,
        antiCakingPicks: antiCakingLabels,
        capsuleShellPick,
      }),
    [
      lines,
      liveTotals,
      mccCarrierLabels,
      dcpCarrierLabels,
      antiCakingLabels,
      capsuleShellPick,
    ],
  );

  // Stable callback for the excipient overrides panel. Without this
  // the panel got a fresh closure every render, so React.memo on the
  // panel couldn't short-circuit. Uses the functional setMetadata
  // form so we don't depend on a churning ``metadata`` reference.
  const handleExcipientOverridesChange = useCallback(
    (next: Record<string, number>) =>
      setMetadata((prev) => ({ ...prev, excipient_overrides: next })),
    [],
  );

  // Per-pick rate rows shown in the override panel for powder
  // formulations. Iterates each band's live id list and resolves the
  // catalogue rate through the live cache first, falling back to the
  // formulation's saved echo. The resulting rows let the scientist
  // override one pick's mg/ml rate per formulation without touching
  // the shared catalogue value. Empty for non-powder forms.
  const perItemRateRows = useMemo<readonly PerItemRateOverrideRow[]>(() => {
    if (metadata.dosage_form !== "powder") return [];
    type BandSpec = {
      readonly band: PerItemRateOverrideRow["band"];
      readonly ids: readonly string[];
      readonly live: Record<
        string,
        { label: string; powderRateMgPerG?: number | null; waterDoseMgPerMl?: number | null }
      >;
      readonly echo: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly ingredient_list_name: string;
        readonly powder_rate_mg_per_g?: number | null;
        readonly water_dose_mg_per_ml?: number | null;
      }>;
    };
    const bands: readonly BandSpec[] = [
      {
        band: "acidity",
        ids: metadata.acidity_item_ids,
        live: Object.fromEntries(
          Object.entries(acidityLive).map(([id, v]) => [
            id,
            { label: v.label, waterDoseMgPerMl: v.waterDoseMgPerMl },
          ]),
        ),
        echo: formulation.acidity_items,
      },
      {
        band: "flavouring",
        ids: metadata.flavouring_item_ids,
        live: flavouringLive,
        echo: formulation.flavouring_items,
      },
      {
        band: "sweetener",
        ids: metadata.sweetener_item_ids,
        live: sweetenerLive,
        echo: formulation.sweetener_items,
      },
      {
        band: "colour",
        ids: metadata.colour_item_ids,
        live: colourLive,
        echo: formulation.colour_items,
      },
    ];
    // Pull water + total weight once so every row hands the same
    // conversion context to its ``BandOverrideRow``. Falls back to
    // zero so the row's internal guard switches it into raw-mg/ml
    // mode (rather than silently dividing by zero).
    const parsedWater = Number.parseFloat(metadata.water_volume_ml || "0");
    const waterMl =
      Number.isFinite(parsedWater) && parsedWater > 0 ? parsedWater : 0;
    const totalWeightMg =
      typeof liveTotals.totalWeightMg === "number" &&
      Number.isFinite(liveTotals.totalWeightMg) &&
      liveTotals.totalWeightMg > 0
        ? liveTotals.totalWeightMg
        : 0;
    const rows: PerItemRateOverrideRow[] = [];
    for (const band of bands) {
      for (const id of band.ids) {
        const live = band.live[id];
        const echo = band.echo.find((e) => e.id === id);
        if (!live && !echo) continue;
        const liveRate =
          live?.waterDoseMgPerMl ?? live?.powderRateMgPerG ?? null;
        const echoRate =
          echo?.water_dose_mg_per_ml ?? echo?.powder_rate_mg_per_g ?? null;
        const defaultRate = liveRate ?? echoRate ?? null;
        const label =
          live?.label ||
          echo?.ingredient_list_name ||
          echo?.name ||
          "";
        rows.push({
          id,
          label,
          band: band.band,
          defaultRate,
          waterMl,
          totalWeightMg,
        });
      }
    }
    return rows;
  }, [
    metadata.dosage_form,
    metadata.water_volume_ml,
    metadata.acidity_item_ids,
    metadata.flavouring_item_ids,
    metadata.sweetener_item_ids,
    metadata.colour_item_ids,
    acidityLive,
    flavouringLive,
    sweetenerLive,
    colourLive,
    formulation.acidity_items,
    formulation.flavouring_items,
    formulation.sweetener_items,
    formulation.colour_items,
    liveTotals.totalWeightMg,
  ]);

  // Shared body for the powder Flavouring / Sweetener / Colour
  // pickers' ``onPickedItemsChange``. Pulls the live attributes off
  // each just-toggled item, derives the band-aware label + per-item
  // rate, and merges them into the matching cache. Keeps the three
  // picker JSX blocks below from duplicating the same shape.
  const handlePowderBandPickerChange = useCallback(
    (
      setter: React.Dispatch<
        React.SetStateAction<Record<string, PowderBandLiveEntry>>
      >,
      defaultUseAs: string,
      items: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly attributes?: Readonly<Record<string, unknown>>;
      }>,
    ) => {
      setter((prev) => {
        const next = { ...prev };
        for (const it of items) {
          const attrs = it.attributes ?? null;
          const rawIngredient = attrs?.["ingredient_list_name"];
          const label =
            typeof rawIngredient === "string" &&
            rawIngredient.trim() !== ""
              ? rawIngredient
              : it.name;
          const rawUseAs = attrs?.["use_as"];
          const useAs =
            typeof rawUseAs === "string" ? rawUseAs : "";
          const rawRate = attrs?.["powder_water_dose_mg_per_ml"];
          const rate =
            typeof rawRate === "number"
              ? rawRate
              : typeof rawRate === "string" && rawRate.trim() !== ""
                ? Number.parseFloat(rawRate)
                : null;
          next[it.id] = {
            label,
            name: it.name,
            useAs: useAs || prev[it.id]?.useAs || defaultUseAs,
            powderRateMgPerG:
              attrs !== null
                ? Number.isFinite(rate ?? NaN)
                  ? rate
                  : null
                : (prev[it.id]?.powderRateMgPerG ?? null),
          };
        }
        return next;
      });
    },
    [],
  );

  // ---------------------------------------------------------------------
  // Raw-material picker — server-filtered, infinite-scroll.
  // ---------------------------------------------------------------------
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 200);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Keep the powder grams draft in sync with the mg source of truth
  // when the mg value changes from *outside* user typing — server
  // reload, rollback, or the dosage-form seeder flipping the value
  // from empty to the 10g default. The guard avoids feedback loops
  // when the user is typing partial strings like "10." that don't
  // yet re-serialise back to the stored mg value.
  useEffect(() => {
    if (gStringToMgString(powderFillG) !== (metadata.target_fill_weight_mg ?? "")) {
      setPowderFillG(mgStringToG(metadata.target_fill_weight_mg));
    }
    // powderFillG read inside the guard only — including it in the
    // deps array would turn every keystroke into a reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metadata.target_fill_weight_mg]);

  // When PSP is the live integration, the builder pulls ingredient
  // candidates from PSP instead of the local raw-materials catalogue.
  // Legacy formulations keep referencing whatever local Item their
  // FormulationLine points at (untouched by the swap); only NEW
  // picks route through PSP → mirror → local Item. The local
  // picker still fires when PSP is off so nothing regresses for
  // orgs that don't run the integration yet.
  const organization = useOrganization(orgId);
  const pspLive = Boolean(organization?.psp_live);

  const localPickerQuery = useInfiniteItems(orgId, RAW_MATERIALS_SLUG, {
    includeArchived: false,
    ordering: "name",
    pageSize: 50,
    search: debouncedSearch || undefined,
  });

  const pspPickerQuery = usePspItems(orgId, {
    enabled: pspLive,
    // Same debounced value as the local picker so the search UX
    // is identical across both data sources.
    search: debouncedSearch || undefined,
    // Only raw materials — the builder is building recipes out of
    // ingredients, not packaging. PSP's item taxonomy maps 1:1.
    itemTypes: ["raw_material"],
  });

  const mirrorPsp = useMirrorPspItem(orgId);

  // ItemDto shim carrying enough shape for the picker JSX +
  // ``attributesFromItem`` compute check. PSP UUIDs prefixed so
  // they never collide with real local Item UUIDs on the ``id``
  // key (used for the "already in lines" dedupe). The real local
  // id lands on the row only after the mirror mutation completes.
  const pickerItems: readonly ItemDto[] = useMemo(() => {
    if (pspLive) {
      const rows: readonly PspItemDto[] = pspPickerQuery.data?.items ?? [];
      return rows.map((row) => ({
        id: `psp:${row.uuid}`,
        name: row.name,
        internal_code: row.code || row.external_sku,
        unit: "",
        base_price:
          row.selling_price !== null && row.selling_price !== undefined
            ? String(row.selling_price)
            : null,
        is_archived: !row.is_active,
        // Full attributes map (PSP wire returns this since
        // ``feat(integration): full attributes map on /items read``)
        // — powers ``canComputeMaterial`` + ``attributesFromItem``
        // on the picker row same as a local Item would.
        attributes: row.attributes ?? {},
        created_at: "",
        updated_at: "",
      }));
    }
    return (
      localPickerQuery.data?.pages.flatMap((page) => [...page.results]) ?? []
    );
  }, [pspLive, pspPickerQuery.data, localPickerQuery.data]);

  // Only the LOCAL query participates in infinite scrolling — PSP's
  // list endpoint caps server-side so no next-page dance is needed
  // when PSP is live. Consumers below branch on ``pspLive`` for
  // the loading / hasNextPage bits.
  const pickerQuery = localPickerQuery;

  const pickerScrollRef = useRef<HTMLUListElement>(null);
  const pickerSentinelRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Infinite scroll is a local-picker-only concern — PSP's list
    // endpoint caps server-side, no next-page dance.
    if (pspLive) return;
    const scrollEl = pickerScrollRef.current;
    const sentinelEl = pickerSentinelRef.current;
    if (!scrollEl || !sentinelEl) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (
          entry?.isIntersecting &&
          pickerQuery.hasNextPage &&
          !pickerQuery.isFetchingNextPage
        ) {
          void pickerQuery.fetchNextPage();
        }
      },
      { root: scrollEl, rootMargin: "120px" },
    );
    observer.observe(sentinelEl);
    return () => observer.disconnect();
  }, [pspLive, pickerQuery, pickerItems.length]);

  // ---------------------------------------------------------------------
  // Line edits
  // ---------------------------------------------------------------------
  // Sticky "adding to which stage" context — set when the operator
  // clicks "Add ingredient" on a specific stage card OR picks a
  // stage from the "Adding to:" chip near the picker. Every pick
  // that follows lands with this stage assigned. NULL falls into
  // the terminal stage on the push cascade.
  const [activeStageId, setActiveStageId] = useState<string | null>(
    () => formulation.stages[0]?.id ?? null,
  );
  // Drill-down state: null = show the stage list on the Stages tab,
  // set = swap the tab body for the ingredient builder scoped to that
  // stage (with a back arrow to return). Isolated from ``activeStageId``
  // because that one tracks the picker's default target (kept even
  // when we're not drilled in). Clicking "Build ingredients" on a
  // stage sets both — the drill target AND the picker default —
  // so subsequent picks land where the scientist is looking.
  // Stage drill-down was removed in the wizard restructure. The
  // "Build ingredients" per-stage button on the Stages tab is gone
  // (line-to-stage routing lives on the Routing tab now), and the
  // Formulation tab hosts the builder in one place. Nothing needs
  // per-stage drill state here.
  // Keep active stage in sync when stages get created / deleted on
  // a save. If the previously-active stage disappeared, snap to the
  // first available one so subsequent picks always have a target.
  useEffect(() => {
    if (
      activeStageId &&
      formulation.stages.some((s) => s.id === activeStageId)
    ) {
      return;
    }
    setActiveStageId(formulation.stages[0]?.id ?? null);
  }, [activeStageId, formulation.stages]);


  // Pick-in-flight tracking so the picker overlay + row-disable
  // fire on EVERY click, not just PSP-mirror round-trips. Local
  // catalogue picks skip the HTTP mutation and would otherwise
  // never trigger a visible loader — but compute + re-render on
  // the resulting state change still takes long enough for the
  // operator to feel a lag. Min-visible window (150ms) keeps the
  // spinner on-screen long enough to register even when the pick
  // resolves in <10ms.
  const pickingRef = useRef(false);
  const [pickingVisible, setPickingVisible] = useState(false);
  const releasePickLock = useCallback(() => {
    // 500ms min-visible window so the operator actually clocks
    // the overlay — 150ms felt like a flicker on fast local picks.
    // The picker stays blocked for the whole window; that's the
    // whole point (prevents the race we're guarding).
    setTimeout(() => {
      pickingRef.current = false;
      setPickingVisible(false);
    }, 500);
  }, []);

  const appendIngredientLine = useCallback(
    (item: ItemDto) => {
      setLines((prev) => {
        if (prev.some((line) => line.item_id === item.id)) {
          return prev;
        }
        const key = `new-${clientUuid()}`;
        return [
          ...prev,
          {
            key,
            item_id: item.id,
            item_name: item.name,
            item_internal_code: item.internal_code,
            item_psp_source_uuid: item.psp_source_uuid ?? null,
            item_attributes: attributesFromItem(item),
            label_claim_mg: "0",
            purity_override: "",
            overage_override: "",
            extract_ratio_override: "",
            display_order: prev.length,
            // Every new pick lands unassigned. Stage routing lives
            // on the Routing tab — the scientist decides which stage
            // an ingredient belongs to as an explicit step, so nothing
            // is auto-bucketed into a stage on the picker.
            stage_id: null,
            source_kind: "active",
            band_key: null,
          },
        ];
      });
    },
    [],
  );

  // Batch pick from the Routing tab's inventory picker. Mirrors
  // each PSP item to a local ``catalogues.Item`` in sequence (avoids
  // racing on the local FK creation), then appends one active
  // ``FormulationLine`` per pick with the operator-supplied qty as
  // ``label_claim_mg``. Everything lands ``stage_id: null`` (routing
  // still handled explicitly on the Routing tab); dedup by item_id
  // so a re-pick of an already-added line is a no-op.
  const handleAddManualPicks = useCallback(
    async (
      picks: readonly {
        readonly pspUuid: string;
        readonly qtyString: string;
      }[],
    ) => {
      setErrorMessage(null);
      for (const pick of picks) {
        try {
          const dto = await mirrorPsp.mutateAsync(pick.pspUuid);
          setLines((prev) => {
            if (prev.some((line) => line.item_id === dto.id)) return prev;
            const parsed = Number.parseFloat(pick.qtyString || "1");
            const claim = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
            return [
              ...prev,
              {
                key: `new-${clientUuid()}`,
                item_id: dto.id,
                item_name: dto.name,
                item_internal_code: dto.internal_code,
                item_psp_source_uuid:
                  (dto as { psp_source_uuid?: string | null })
                    .psp_source_uuid ?? pick.pspUuid,
                item_attributes: attributesFromItem({
                  id: dto.id,
                  name: dto.name,
                  internal_code: dto.internal_code,
                  unit: dto.unit,
                  base_price: dto.base_price,
                  is_archived: dto.is_archived,
                  attributes: dto.attributes,
                  created_at: "",
                  updated_at: "",
                }),
                // Store the user's qty verbatim. On PSP push it
                // rides as the BOM line's ``qty`` in the item's
                // native unit (bottle / kg / unit). The scientist
                // can refine on the Formulation tab later.
                label_claim_mg: String(claim),
                purity_override: "",
                overage_override: "",
                extract_ratio_override: "",
                display_order: prev.length,
                stage_id: null,
                // ``manual`` distinguishes Routing-tab picks from the
                // Formulation-tab active picker so the Routing inventory
                // shows a remove-× on these rows only (a scientist can
                // undo a manual pick right where they made it; actives
                // + band picks remain managed on Formulation).
                source_kind: "manual",
                band_key: null,
              },
            ];
          });
        } catch (err) {
          setErrorMessage(extractApiErrorMessage(err, tErrors));
          break;
        }
      }
    },
    [mirrorPsp, tErrors],
  );

  // Remove a line by key — used by the × on Routing inventory rows.
  const handleRemoveLine = useCallback((lineKey: string) => {
    setLines((prev) => prev.filter((line) => line.key !== lineKey));
  }, []);

  const addIngredient = useCallback(
    (item: ItemDto) => {
      // Hard-block re-entry while any pick (PSP mirror OR local
      // append) is being processed. Belt-and-braces with the
      // disabled state on every picker button — a fast operator can
      // still fire multiple clicks in the ~milliseconds between
      // mutation start and the re-render that flips ``disabled``
      // on the DOM.
      if (mirrorPsp.isPending || pickingRef.current) return;
      // Flip the visible-loader flag synchronously so the overlay
      // shows on the very next paint — even for local picks where
      // no HTTP round-trip fires. Cleared with a min-visible
      // window below so the flash isn't imperceptible.
      pickingRef.current = true;
      setPickingVisible(true);
      // PSP-sourced picker rows carry a ``psp:<uuid>`` synthetic id.
      // Route them through the mirror endpoint first — that returns
      // a real local :class:`catalogues.Item` with a stable UUID —
      // and only then attach a formulation line. The FormulationLine
      // FK stays local (nothing polymorphic downstream); PSP just
      // populates the row.
      if (item.id.startsWith("psp:")) {
        const pspUuid = item.id.slice("psp:".length);
        // Clear any stale error banner before we kick off the
        // mirror round-trip. On success or failure it gets
        // replaced with a fresh message below.
        setErrorMessage(null);
        mirrorPsp.mutate(pspUuid, {
          onSuccess: (dto) => {
            appendIngredientLine({
              id: dto.id,
              name: dto.name,
              internal_code: dto.internal_code,
              unit: dto.unit,
              base_price: dto.base_price,
              is_archived: dto.is_archived,
              attributes: dto.attributes,
              created_at: "",
              updated_at: "",
            });
            releasePickLock();
          },
          onError: (err) => {
            // Surface the mirror failure in the same error banner
            // the rest of the builder uses. Without this the click
            // fails silently — the button appears to do nothing
            // and the operator can't tell PSP integration status
            // from a real network / permission issue.
            setErrorMessage(extractApiErrorMessage(err, tErrors));
            releasePickLock();
          },
        });
        return;
      }
      appendIngredientLine(item);
      releasePickLock();
    },
    [appendIngredientLine, mirrorPsp, tErrors, releasePickLock],
  );

  const updateLineClaim = useCallback((key: string, value: string) => {
    const sanitized = sanitizeDecimalInput(value);
    setLines((prev) =>
      prev.map((line) =>
        line.key === key ? { ...line, label_claim_mg: sanitized } : line,
      ),
    );
  }, []);

  const updateLineOverride = useCallback(
    (
      key: string,
      field: "purity_override" | "overage_override" | "extract_ratio_override",
      value: string,
    ) => {
      const sanitized = sanitizeDecimalInput(value);
      setLines((prev) =>
        prev.map((line) =>
          line.key === key ? { ...line, [field]: sanitized } : line,
        ),
      );
    },
    [],
  );

  const removeLine = useCallback((key: string) => {
    setLines((prev) =>
      prev
        .filter((line) => line.key !== key)
        .map((line, index) => ({ ...line, display_order: index })),
    );
  }, []);

  // Per-line "Advanced" disclosure — toggles the row that exposes
  // purity / overage / extract-ratio override inputs. Stored as a
  // ``Set`` of line keys so toggling is a single set/unset call and
  // the rest of the page never re-renders unnecessarily.
  const [expandedOverrides, setExpandedOverrides] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const toggleOverridePanel = useCallback((key: string) => {
    setExpandedOverrides((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // ---------------------------------------------------------------------
  // Save metadata + lines to the backend.
  // ---------------------------------------------------------------------
  const handleSaveMetadata = useCallback(async () => {
    setErrorMessage(null);
    try {
      const parsedFill = Number.parseFloat(metadata.target_fill_weight_mg);
      const parsedWater = Number.parseFloat(metadata.water_volume_ml);
      const updated = await updateMutation.mutateAsync({
        name: metadata.name,
        code: metadata.code,
        description: metadata.description,
        dosage_form: metadata.dosage_form,
        // The capsule size dropdown is gone — the shell picker is
        // the single source of truth going forward. When a shell
        // is picked, clear the legacy ``capsule_size`` so its
        // ``attributes.capsule_size`` drives compute cleanly.
        // When no shell is picked, preserve whatever the model
        // already has: legacy formulations saved with an explicit
        // size (before the picker existed) continue to compute
        // against that size until the scientist picks a shell —
        // no silent behaviour change on save-without-change.
        capsule_size:
          metadata.capsule_shell_item_ids.length > 0
            ? ""
            : metadata.capsule_size,
        tablet_size: metadata.tablet_size,
        serving_size: metadata.serving_size,
        servings_per_pack: metadata.servings_per_pack,
        target_fill_weight_mg:
          Number.isFinite(parsedFill) && parsedFill > 0
            ? String(parsedFill)
            : null,
        powder_type: metadata.powder_type,
        water_volume_ml:
          Number.isFinite(parsedWater) && parsedWater >= 0
            ? String(parsedWater)
            : null,
        // Empty array clears the picks; any other array replaces
        // the M2M. The server validates cross-org + canonical
        // ``use_as`` on every id. Flavouring + Colour are shared
        // between gummy + powder; sweetener is powder-only; the
        // rest are gummy-only.
        gummy_base_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.gummy_base_item_ids
            : [],
        flavouring_item_ids:
          metadata.dosage_form === "gummy" ||
          metadata.dosage_form === "powder"
            ? metadata.flavouring_item_ids
            : [],
        colour_item_ids:
          metadata.dosage_form === "gummy" ||
          metadata.dosage_form === "powder"
            ? metadata.colour_item_ids
            : [],
        sweetener_item_ids:
          metadata.dosage_form === "powder"
            ? metadata.sweetener_item_ids
            : [],
        glazing_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.glazing_item_ids
            : [],
        gelling_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.gelling_item_ids
            : [],
        premix_sweetener_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.premix_sweetener_item_ids
            : [],
        acidity_item_ids:
          metadata.dosage_form === "gummy" ||
          metadata.dosage_form === "powder"
            ? metadata.acidity_item_ids
            : [],
        // Capsule shell is capsule-only. Swap to any other dosage
        // form clears the picks so orphaned references don't
        // linger — same discipline as the other picker fields.
        capsule_shell_item_ids:
          metadata.dosage_form === "capsule"
            ? metadata.capsule_shell_item_ids
            : [],
        // MCC carrier flows to BOTH capsules and tablets — they
        // share the same structural-filler slot. Other dosage forms
        // clear the picks so a one-off swap from capsule → powder
        // doesn't leave orphaned references behind.
        mcc_carrier_item_ids:
          metadata.dosage_form === "capsule" ||
          metadata.dosage_form === "tablet"
            ? metadata.mcc_carrier_item_ids
            : [],
        // DCP carrier is tablet-only; capsules have no DCP line.
        dcp_carrier_item_ids:
          metadata.dosage_form === "tablet"
            ? metadata.dcp_carrier_item_ids
            : [],
        // Anti-caking flows to capsules + tablets + powders. Empty
        // picker on a dosage form that supports it means the
        // scientist explicitly wants no lubricant band on the
        // formulation.
        anti_caking_item_ids:
          metadata.dosage_form === "capsule" ||
          metadata.dosage_form === "tablet" ||
          metadata.dosage_form === "powder"
            ? metadata.anti_caking_item_ids
            : [],
        // Powder carrier is powder-only. Other dosage forms clear it
        // so a one-off swap from powder to capsule doesn't leave
        // orphaned Maltodextrin picks behind.
        powder_carrier_item_ids:
          metadata.dosage_form === "powder"
            ? metadata.powder_carrier_item_ids
            : [],
        excipient_overrides:
          metadata.dosage_form === "gummy"
            ? metadata.excipient_overrides
            : {},
        directions_of_use: metadata.directions_of_use,
        suggested_dosage: metadata.suggested_dosage,
        appearance: metadata.appearance,
        disintegration_spec: metadata.disintegration_spec,
        // Finished-product spec (Setup tab source of truth; the push
        // cascade mirrors these onto the finished stage's PSP spec).
        regulatory_category: metadata.regulatory_category || null,
        warnings_text: metadata.warnings_text,
        shelf_life_months: metadata.shelf_life_months
          ? Number(metadata.shelf_life_months)
          : null,
        storage_conditions: metadata.storage_conditions,
        target_markets: metadata.target_markets,
        net_quantity: metadata.net_quantity || null,
        net_quantity_uom_uuid: metadata.net_quantity_uom_uuid,
        serving_size_uom_uuid: metadata.serving_size_uom_uuid,
        storage_tags: metadata.storage_tags,
        min_stock_qty: metadata.min_stock_qty || null,
        target_stock_qty: metadata.target_stock_qty || null,
        allergen_uuids: metadata.allergen_uuids,
        may_contain_allergen_keys: metadata.may_contain_allergen_keys,
        may_contain_justification: metadata.may_contain_justification,
      });
      setFormulation(updated);
      setMetadata(metadataFrom(updated));
      router.refresh();
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }, [metadata, updateMutation, router, tErrors]);

  const handleSaveLines = useCallback(async () => {
    setErrorMessage(null);
    try {
      // Empty override strings → ``null`` so the backend clears any
      // existing override (back to catalogue value). Non-empty strings
      // travel as-is; the DRF DecimalField parses them.
      const overrideOrNull = (raw: string): string | null =>
        raw && raw.trim() !== "" ? raw : null;
      // Bake Routing-tab intent into the line payload for actives.
      // Save chain runs handleSaveLines before handleSaveRouting, so
      // new picks land with the right ``stage_id`` in one round-trip
      // — no post-save correlation dance for ``new-…`` client-only
      // keys. handleSaveRouting is then band-only.
      const overrideStageIdFor = (line: BuilderLine): string | null => {
        if (line.source_kind === "band_pick") return line.stage_id;
        const routingIntent = routingByKey.get(`active:${line.key}`);
        return routingIntent !== undefined ? routingIntent : line.stage_id;
      };
      const updated = await replaceLinesMutation.mutateAsync({
        lines: lines.map((line, index) => ({
          item_id: line.item_id,
          label_claim_mg: line.label_claim_mg || "0",
          purity_override: overrideOrNull(line.purity_override),
          overage_override: overrideOrNull(line.overage_override),
          extract_ratio_override: overrideOrNull(line.extract_ratio_override),
          display_order: index,
          stage_id: overrideStageIdFor(line),
          // Preserve ``source_kind`` across the round-trip so
          // Routing-tab manual picks keep their × affordance after
          // save. Server's ``replace_lines`` wipes + recreates all
          // lines, so without this manual picks get demoted to
          // active on every save.
          source_kind: line.source_kind,
        })),
      });
      setFormulation(updated);
      setLines(linesFrom(updated));
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }, [lines, routingByKey, replaceLinesMutation, tErrors]);

  const handleSaveVersion = useCallback(async () => {
    setErrorMessage(null);
    try {
      await handleSaveMetadata();
      // Lines fires unconditionally when routing is dirty too —
      // Routing-tab intent for actives is baked into the lines
      // payload (see ``handleSaveLines`` override), so the version
      // snapshot picks up the freshly-routed lines in one round-trip.
      await handleSaveLines();
      // Persist any pending stage edits before cutting the version
      // so the snapshot reflects them + so the auto-push cascade
      // fires with the latest workstation / operation / cost data.
      // The strip's save mutation already updates our local
      // ``formulation`` state via ``onSaved``, so bomLinesByStage
      // re-derives against the fresh stage graph before the save-
      // version payload is built below.
      if (stagesDirty && stagesSaveHandleRef.current) {
        await stagesSaveHandleRef.current();
      }
      // Materialize band picks (flavouring / sweetener / …) as
      // routed FormulationLine rows. No-op when nothing changed.
      if (routingDirty) {
        await handleSaveRouting();
      }
      // Ship the FE-computed per-stage BOM as part of the save so
      // (1) version history preserves exactly what each stage's PSP
      // BOM held at this save, and (2) the auto-push inside
      // save_version uses the snapshot as the PSP override — PSP
      // ends up with the same rows the operator sees. Compute-only
      // placeholder rows without a picked SKU (empty excipient
      // bands, the synthesized "prior semi" row) are dropped.
      const stageBoms: Record<
        string,
        {
          item_id: string | null;
          psp_item_uuid?: string | null;
          mg: number;
          sort_order: number;
          label: string;
          code: string;
        }[]
      > = {};
      bomLinesByStage.forEach((rows, stageId) => {
        stageBoms[stageId] = rows
          // Keep rows that resolve to either a local item id (the
          // usual mirror path) OR a raw PSP uuid (auto-picked
          // capsule shell before any explicit tick). Drop rows with
          // neither — those are compute-only placeholders (empty
          // excipient bands, the synthesized prior-semi link).
          .filter((row) => Boolean(row.itemId) || Boolean(row.pspItemUuid))
          .map((row, idx) => ({
            item_id: row.itemId,
            psp_item_uuid: row.pspItemUuid ?? null,
            mg: row.mg,
            sort_order: idx,
            label: row.label,
            code: row.code,
          }));
      });
      await saveVersionMutation.mutateAsync({ label: "", stage_boms: stageBoms });
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }, [
    handleSaveMetadata,
    handleSaveLines,
    handleSaveRouting,
    saveVersionMutation,
    bomLinesByStage,
    stagesDirty,
    routingDirty,
    tErrors,
  ]);

  const handleRollback = useCallback(
    async (versionNumber: number) => {
      if (
        !confirm(
          tFormulations("versions.rollback_confirm_body", {
            version: versionNumber,
          }),
        )
      ) {
        return;
      }
      setErrorMessage(null);
      try {
        const updated = await rollbackMutation.mutateAsync({
          version_number: versionNumber,
        });
        setFormulation(updated);
        setMetadata(metadataFrom(updated));
        setLines(linesFrom(updated));
        router.refresh();
      } catch (err) {
        setErrorMessage(extractApiErrorMessage(err, tErrors));
      }
    },
    [rollbackMutation, router, tErrors, tFormulations],
  );

  const handleToggleApproved = useCallback(
    async (versionNumber: number) => {
      setErrorMessage(null);
      const alreadyApproved =
        formulation.approved_version_number === versionNumber;
      try {
        const updated = await approveMutation.mutateAsync(
          alreadyApproved ? null : versionNumber,
        );
        setFormulation(updated);
      } catch (err) {
        setErrorMessage(extractApiErrorMessage(err, tErrors));
      }
    },
    [approveMutation, formulation.approved_version_number, tErrors],
  );

  // ---------------------------------------------------------------------
  // Dirty-state flags
  // ---------------------------------------------------------------------
  const metadataDirty = useMemo(
    () => JSON.stringify(metadataFrom(formulation)) !== JSON.stringify(metadata),
    [formulation, metadata],
  );

  // Metadata fields owned by the Formulation tab — every M2M picker
  // (flavouring, sweetener, colour, acidity, gelling, glazing, MCC,
  // DCP, anti-caking, powder carrier, capsule shell, gummy base,
  // premix sweetener) plus the per-SKU excipient overrides. Split
  // out so the "unsaved" dot lights up on the tab the operator is
  // actually editing, not on Setup where the tab-strip's default
  // ``metadataDirty`` mapping used to route every picker change.
  const FORMULATION_TAB_METADATA_KEYS = useMemo(
    () =>
      [
        "flavouring_item_ids",
        "sweetener_item_ids",
        "colour_item_ids",
        "acidity_item_ids",
        "gelling_item_ids",
        "glazing_item_ids",
        "premix_sweetener_item_ids",
        "mcc_carrier_item_ids",
        "dcp_carrier_item_ids",
        "anti_caking_item_ids",
        "powder_carrier_item_ids",
        "capsule_shell_item_ids",
        "gummy_base_item_ids",
        "excipient_overrides",
      ] as const,
    [],
  );
  const formulationMetadataDirty = useMemo(() => {
    const saved = metadataFrom(formulation);
    return FORMULATION_TAB_METADATA_KEYS.some(
      (k) => JSON.stringify(saved[k]) !== JSON.stringify(metadata[k]),
    );
  }, [formulation, metadata, FORMULATION_TAB_METADATA_KEYS]);
  // Setup dot fires only when the user touched a Setup-owned field.
  // Iterate every metadata key, skipping the ones the Formulation tab
  // owns — so editing a picker doesn't also light Setup.
  const setupMetadataDirty = useMemo(() => {
    if (!metadataDirty) return false;
    const saved = metadataFrom(formulation);
    const pickerSet = new Set<string>(FORMULATION_TAB_METADATA_KEYS);
    for (const key of Object.keys(metadata) as (keyof MetadataDraft)[]) {
      if (pickerSet.has(key as string)) continue;
      if (JSON.stringify(saved[key]) !== JSON.stringify(metadata[key])) {
        return true;
      }
    }
    return false;
  }, [
    metadataDirty,
    formulation,
    metadata,
    FORMULATION_TAB_METADATA_KEYS,
  ]);

  const linesDirty = useMemo(() => {
    const stripKey = (line: BuilderLine) => ({
      item_id: line.item_id,
      label_claim_mg: line.label_claim_mg,
      display_order: line.display_order,
    });
    const original = linesFrom(formulation).map(stripKey);
    const current = lines.map(stripKey);
    return JSON.stringify(original) !== JSON.stringify(current);
  }, [formulation, lines]);

  // Split ``linesDirty`` by the picker that spawned each row so the
  // "unsaved" dot lights on the tab the operator is actually editing.
  // Any change to ``manual`` picks routes to Routing; anything else
  // (actives, band picks) routes to Formulation. Both feed the top-
  // of-page Save chain the same way — this is a UX affordance only.
  const savedLinesByItemAndKind = useMemo(() => {
    const map = new Map<
      string,
      { label_claim_mg: string; stage_id: string | null }
    >();
    for (const line of linesFrom(formulation)) {
      const k = `${line.source_kind ?? "active"}:${line.item_id}`;
      map.set(k, {
        label_claim_mg: line.label_claim_mg,
        stage_id: line.stage_id,
      });
    }
    return map;
  }, [formulation]);
  const routingLinesDirty = useMemo(() => {
    // A manual pick is dirty iff (a) it's new (no saved twin) OR
    // (b) its claim / stage changed vs saved. Matches the same
    // shape ``linesDirty`` compares so the two flags flip together
    // on a real save round-trip.
    const currentManuals = lines.filter((l) => l.source_kind === "manual");
    const savedManualCount = Array.from(savedLinesByItemAndKind.keys()).filter(
      (k) => k.startsWith("manual:"),
    ).length;
    if (currentManuals.length !== savedManualCount) return true;
    for (const line of currentManuals) {
      const saved = savedLinesByItemAndKind.get(`manual:${line.item_id}`);
      if (!saved) return true;
      if (saved.label_claim_mg !== line.label_claim_mg) return true;
    }
    return false;
  }, [lines, savedLinesByItemAndKind]);
  // Formulation-tab dot sees line-changes only when a NON-manual line
  // moved (added / removed active, mg edit on an active). Isolates
  // manual picks from lighting the wrong tab.
  const formulationLinesDirty = useMemo(() => {
    if (!linesDirty) return false;
    const nonManualNow = lines.filter((l) => l.source_kind !== "manual");
    const savedNonManuals = Array.from(savedLinesByItemAndKind.entries())
      .filter(([k]) => !k.startsWith("manual:"))
      .map(([, v]) => v);
    if (nonManualNow.length !== savedNonManuals.length) return true;
    for (const line of nonManualNow) {
      const kind = line.source_kind ?? "active";
      const saved = savedLinesByItemAndKind.get(`${kind}:${line.item_id}`);
      if (!saved) return true;
      if (saved.label_claim_mg !== line.label_claim_mg) return true;
    }
    return false;
  }, [linesDirty, lines, savedLinesByItemAndKind]);

  // Snapshot of the last-saved ``label_claim_mg`` per line, keyed by
  // the builder line ``key`` (stable per item_id). Feeds the per-row
  // undo affordance on the fine-tune panel: an active row shows a ↺
  // when its current mg differs from this saved value, and clicking
  // ↺ writes the saved value back. ``item_id`` on the saved line is
  // the join key — lines share their key with the item id after the
  // ``linesFrom`` projection.
  const savedActiveMgByLineKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of linesFrom(formulation)) {
      const mg = Number.parseFloat(line.label_claim_mg || "0");
      map.set(line.key, Number.isFinite(mg) ? mg : 0);
    }
    return map;
  }, [formulation]);

  // Global "revert unsaved changes" — rewinds every in-memory edit
  // back to the last-saved state. Used both by the fine-tune panel's
  // header button and the top-of-page save banner. Cheap enough to
  // recompute both projections inline since ``formulation`` only
  // changes on save / restore.
  const handleRevertAllUnsaved = useCallback(() => {
    setMetadata(metadataFrom(formulation));
    setLines(linesFrom(formulation));
  }, [formulation]);

  const isBusy =
    updateMutation.isPending ||
    replaceLinesMutation.isPending ||
    saveVersionMutation.isPending ||
    rollbackMutation.isPending;

  const versions = versionsQuery.data ?? [];

  const supported = FULLY_SUPPORTED_DOSAGE_FORMS.includes(metadata.dosage_form);

  return (
    <div className="mt-6 flex flex-col gap-6">
      {/* ------------------------------------------------------------ */}
      {/* Action bar — the project shell above already renders the     */}
      {/* code + name + status pills, so we don't repeat them here.    */}
      {/* Just the primary CTAs (Open on PSP / Duplicate / Save        */}
      {/* draft / Save version) plus an "unsaved" hint on the right.   */}
      {/* ------------------------------------------------------------ */}
      {canWrite ? (
        <section className="flex flex-wrap items-center justify-end gap-3">
          {metadataDirty || linesDirty || stagesDirty || routingDirty ? (
            <span className="mr-auto text-xs font-medium uppercase tracking-wide text-ink-500">
              {tFormulations("builder.unsaved_changes")}
            </span>
          ) : null}
          <div className="flex flex-wrap gap-3">
              {/* Deep-link into PSP — always targets the finished
                  product (the terminal stage's PSP item). Points at
                  the item detail page (shows every BOM version this
                  formulation has pushed), not a specific BOM version
                  — the item page is a stable target that keeps
                  working across future version bumps. Hidden when
                  either the finished-product link isn't set
                  (formulation predates the picker) or PSP isn't
                  configured (empty base url). */}
              {formulation.psp_finished_product_uuid &&
              organization?.psp_base_url ? (
                <a
                  href={`${organization.psp_base_url}/production/items/${formulation.psp_finished_product_uuid}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  title="Opens the finished product's item + BOM history on PSP in a new tab"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open on PSP
                </a>
              ) : null}
              <DuplicateFormulationModal
                orgId={orgId}
                source={formulation}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    className="gap-1.5 rounded-lg bg-ink-0 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                    isDisabled={isBusy}
                  >
                    <CopyPlus className="h-4 w-4" />
                    {tFormulations("duplicate.trigger")}
                  </Button>
                }
              />
              <Button
                type="button"
                variant="outline"
                size="md"
                className="gap-1.5 rounded-lg bg-ink-0 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                isDisabled={
                  isBusy ||
                  (!metadataDirty && !linesDirty && !stagesDirty && !routingDirty)
                }
                onClick={async () => {
                  const hadChanges =
                    metadataDirty ||
                    linesDirty ||
                    stagesDirty ||
                    routingDirty;
                  if (metadataDirty) await handleSaveMetadata();
                  // Actives ride handleSaveLines with their Routing-
                  // tab intent baked in — so run lines when either
                  // ``linesDirty`` OR ``routingDirty`` is set.
                  if (linesDirty || routingDirty) await handleSaveLines();
                  if (stagesDirty && stagesSaveHandleRef.current) {
                    await stagesSaveHandleRef.current();
                  }
                  // Band picks (flavouring / sweetener / …) have no
                  // FormulationLine until this endpoint materializes
                  // them, so it fires even when only routing is dirty.
                  if (routingDirty) await handleSaveRouting();
                  // Fire-and-forget auto-snapshot so the History tab's
                  // Activity revert has a target for this draft save.
                  // ``is_auto: true`` skips the PSP push cascade on
                  // the server so we don't spam PSP on every keystroke.
                  // Silent-degrade — a failed snapshot doesn't fail
                  // the draft save; the current formulation is
                  // authoritative and the next draft will retry.
                  if (hadChanges) {
                    saveVersionMutation.mutate({
                      label: "",
                      is_auto: true,
                    });
                  }
                }}
              >
                <Save className="h-4 w-4" />
                {tFormulations("builder.save_draft")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="gap-1.5 rounded-lg bg-orange-500 font-medium text-ink-0 hover:bg-orange-600"
                // Gate on the same dirty flags as Save draft — a
                // Version snapshots the current state, so firing
                // it with nothing dirty just clones the previous
                // version verbatim.
                isDisabled={
                  isBusy ||
                  (!metadataDirty && !linesDirty && !stagesDirty && !routingDirty)
                }
                onClick={handleSaveVersion}
              >
                <Save className="h-4 w-4" />
                {tFormulations("builder.save_version")}
              </Button>
          </div>
        </section>
      ) : null}

      {errorMessage ? (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* Tab strip — Setup / Stages / Ingredients / Preview           */}
      {/*                                                              */}
      {/* Each tab wraps a subset of the builder's existing sections   */}
      {/* in a permanently-mounted <div> that toggles via ``hidden``   */}
      {/* — no unmounts, so state (line drafts, focus, scroll)         */}
      {/* survives tab switches. The dirty dot on each tab surfaces    */}
      {/* which sections carry unsaved edits so a scientist can see    */}
      {/* what a Save Version would actually persist.                  */}
      {/* ------------------------------------------------------------ */}
      {/* Pill-style segmented control — reads as clearly secondary
          to the project shell's icon-based underline tabs above
          (Overview / Builder / Spec sheets / …). */}
      <nav
        aria-label="Formulation builder tabs"
        className="sticky top-0 z-30 -mx-4 flex justify-start bg-ink-0/95 px-4 py-2 backdrop-blur"
      >
        <div className="inline-flex items-center gap-1 rounded-full bg-ink-100 p-1">
            {(
              [
                {
                  id: "setup" as const,
                  label: "Setup",
                  dirty: setupMetadataDirty,
                },
                {
                  id: "formulation" as const,
                  label: "Formulation",
                  dirty: formulationLinesDirty || formulationMetadataDirty,
                },
                {
                  id: "stages" as const,
                  label: "Stages",
                  dirty: false,
                },
                {
                  id: "routing" as const,
                  label: "Routing",
                  dirty: routingDirty || routingLinesDirty,
                },
                {
                  id: "preview" as const,
                  label: "Preview",
                  dirty: false,
                },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={
                  activeTab === t.id
                    ? "relative rounded-full bg-ink-0 px-4 py-1.5 text-sm font-medium text-ink-1000 shadow-sm"
                    : "relative rounded-full px-4 py-1.5 text-sm font-medium text-ink-600 hover:text-ink-1000"
                }
              >
                {t.label}
                {t.dirty ? (
                  <span
                    className="absolute right-1.5 top-1 h-1.5 w-1.5 rounded-full bg-orange-500"
                    aria-label="unsaved changes"
                  />
                ) : null}
              </button>
            ))}
        </div>
      </nav>

      {/* ------------------------------------------------------------ */}
      {/* Metadata form  (tab: SETUP)                                  */}
      {/* ------------------------------------------------------------ */}
      <div className={activeTab === "setup" ? "flex flex-col gap-10" : "hidden"}>
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("builder.metadata")}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          <TextField
            label={tFormulations("fields.name")}
            value={metadata.name}
            onChange={(v) => setMetadata({ ...metadata, name: v })}
            disabled={!canWrite}
          />
          <TextField
            label={tFormulations("fields.code")}
            value={metadata.code}
            onChange={(v) => setMetadata({ ...metadata, code: v })}
            disabled={!canWrite}
          />
          <SelectField
            label={tFormulations("fields.dosage_form")}
            value={metadata.dosage_form}
            onChange={(v) =>
              setMetadata({
                ...metadata,
                dosage_form: v as DosageForm,
                capsule_size: v === "capsule" ? metadata.capsule_size : "",
                tablet_size: v === "tablet" ? metadata.tablet_size : "",
                // Seed the sachet mass the reference workbooks use
                // (10g = 10000mg) when the user lands on powder with
                // an empty field — matches Excel's silent default so
                // the excipient table populates without extra input.
                target_fill_weight_mg:
                  v === "powder" && !metadata.target_fill_weight_mg
                    ? POWDER_DEFAULT_FILL_MG
                    : metadata.target_fill_weight_mg,
                // Same reasoning for the water-volume default —
                // 500ml is the reference the flavour-system mg
                // values are calibrated against.
                water_volume_ml:
                  v === "powder" && !metadata.water_volume_ml
                    ? POWDER_DEFAULT_WATER_ML
                    : metadata.water_volume_ml,
              })
            }
            disabled={!canWrite}
            options={DOSAGE_FORMS.map((key) => ({
              value: key,
              label: tFormulations(`dosage_forms.${key}`),
            }))}
          />
          {metadata.dosage_form === "powder" ? (
            <SelectField
              label={tFormulations("fields.powder_type")}
              value={metadata.powder_type}
              onChange={(v) =>
                setMetadata({ ...metadata, powder_type: v as PowderType })
              }
              disabled={!canWrite}
              options={POWDER_TYPES.map((key) => ({
                value: key,
                label: tFormulations(`powder_types.${key}`),
              }))}
            />
          ) : null}
          {metadata.dosage_form === "powder" ? (
            <TextField
              label={tFormulations("fields.water_volume_ml")}
              value={metadata.water_volume_ml}
              onChange={(v) =>
                setMetadata({ ...metadata, water_volume_ml: v })
              }
              disabled={!canWrite}
              hint={tFormulations("fields.water_volume_ml_hint")}
            />
          ) : null}
          {metadata.dosage_form === "tablet" ? (
            <SelectField
              label={tFormulations("fields.tablet_size")}
              value={metadata.tablet_size}
              onChange={(v) => setMetadata({ ...metadata, tablet_size: v })}
              disabled={!canWrite}
              options={[
                { value: "", label: "—" },
                ...TABLET_SIZES.map((s) => ({
                  value: s.key,
                  label: `${s.label} (${s.max_weight_mg} mg)`,
                })),
              ]}
            />
          ) : null}
        </div>
      </section>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* Excipient pickers (tab: INGREDIENTS)                         */}
      {/*                                                              */}
      {/* Category-scoped pickers for the excipient bands the          */}
      {/* formulation needs. Every pick lands on a formulation-level   */}
      {/* M2M (mcc_carrier_items, anti_caking_items, ...) and feeds    */}
      {/* the ingredient declaration + compute cascade. Moved out of   */}
      {/* Setup because these are ingredients, not product setup —     */}
      {/* the picker context also drives the compute's use_as          */}
      {/* inference so keeping them near the actives picker below is   */}
      {/* the right mental model.                                      */}
      {/* ------------------------------------------------------------ */}
      <div
        className={
          activeTab === "formulation"
            ? "flex flex-col gap-10"
            : "hidden"
        }
      >
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          Excipients
        </p>
        <p className="mt-1 text-sm text-ink-700">
          Pick the specific SKUs used for each band. Empty = the
          declaration falls back to a generic placeholder for that
          band. Every pick feeds the compute + declaration.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* Capsule size hint — lives on the Ingredients tab now
              alongside the shell picker that drives it. No dropdown:
              shell picked → drives size via ``attributes.capsule_size``;
              no shell picked → compute auto-picks the smallest PSP
              shell that fits total active (falling back to the
              hardcoded ladder). Renders only for capsule form. */}
          {metadata.dosage_form === "capsule" ? (
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Capsule size
              </span>
              <div className="flex items-center gap-2 rounded-xl bg-orange-50/60 px-3 py-2 text-sm text-ink-700 ring-1 ring-inset ring-orange-200">
                <ShieldCheck className="h-4 w-4 shrink-0 text-orange-700" />
                <span>
                  {(() => {
                    // With an explicit pick: point the operator at
                    // where to change it. Without: name the shell
                    // NPD auto-picked so it's not a mystery which
                    // SKU / size the BOM inherits by default.
                    if (metadata.capsule_shell_item_ids.length > 0) {
                      return "Driven by the picked capsule shell — edit the shell's capsule_size attribute on PSP to change.";
                    }
                    const match = resolveAutoPickedShell(
                      pspCapsuleShellCatalog,
                      liveTotals.totalActiveMg,
                    );
                    if (match) {
                      const sizeKey =
                        match.capsuleSize || metadata.capsule_size || "";
                      const shellWeight =
                        CAPSULE_SHELL_WEIGHTS[sizeKey] ?? 0;
                      return (
                        <>
                          Auto-picked from PSP:{" "}
                          <strong>{match.name}</strong>
                          {sizeKey ? ` (${sizeKey})` : ""}
                          {shellWeight > 0 ? ` — ${shellWeight} mg` : ""}.
                          Tick a shell below to lock a different one.
                        </>
                      );
                    }
                    const sizeKey = metadata.capsule_size || "";
                    const shellWeight = CAPSULE_SHELL_WEIGHTS[sizeKey] ?? 0;
                    if (shellWeight > 0) {
                      return (
                        <>
                          Auto-picked from the hardcoded shell-weight
                          table: <strong>Capsule Shell ({sizeKey})</strong>{" "}
                          — {shellWeight} mg. Tick a shell below to
                          use a specific SKU on PSP.
                        </>
                      );
                    }
                    return "Auto-picked from total active weight — tick a capsule shell below to lock a specific size.";
                  })()}
                </span>
              </div>
            </div>
          ) : null}
          {/* Capsule shell picker — capsule-only. Picks flow into
              compute via ``attributes.capsule_size`` (overriding the
              size dropdown) and ``attributes.shell_weight_mg``
              (declared shell mass). Empty list → hardcoded per-size
              CAPSULE_SHELL_WEIGHTS table + the size dropdown drives
              compute, matching the pre-picker behaviour. Copy is
              inline (non-i18n) until the translation keys land in
              the shared locale bundle. */}
          {metadata.dosage_form === "capsule" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.capsule_shell_item_ids}
              preselected={formulation.capsule_shell_items ?? []}
              disabled={!canWrite}
              useAsIn={CAPSULE_SHELL_USE_CATEGORIES}
              // Classify capsule shells as ``raw_material`` on the
              // PSP side so the "Used as" compliance dropdown (only
              // shown for raw_material) is available on the item
              // form. That's the field the picker filters on. The
              // default ``["raw_material"]`` filter picks them up
              // without a per-mount override.
              label="Capsule Shell"
              placeholderText="Pick a capsule shell SKU"
              hint="Empty capsule shells (Size 0 HPMC, Size 00 Gelatin, …). The picked shell's attributes.capsule_size drives fill capacity and attributes.shell_weight_mg drives the declared shell mass — leaving this empty falls back to the size dropdown + hardcoded shell weights."
              loadingText="Loading capsule shells…"
              emptyText="No capsule shells tagged with use_as = 'Capsule Shell' on the integration yet."
              onChange={(ids) =>
                setMetadata({ ...metadata, capsule_shell_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                setCapsuleShellNames((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.name;
                  return next;
                });
                setCapsuleShellCodes((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.internal_code;
                  return next;
                });
                setCapsuleShellAttrs((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.attributes ?? {};
                  return next;
                });
              }}
            />
          ) : null}
          {/* Capsule + tablet MCC carrier picker. Mirrors the gummy
              base picker — picks split the MCC remainder equally
              and the spec sheet emits one row per pick. Empty list
              falls back to the generic placeholder + a soft warning
              in the viability strip; the form is intentionally
              optional so legacy formulations keep rendering. */}
          {metadata.dosage_form === "capsule" ||
          metadata.dosage_form === "tablet" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.mcc_carrier_item_ids}
              preselected={formulation.mcc_carrier_items}
              disabled={!canWrite}
              useAsIn={MCC_CARRIER_USE_CATEGORIES}
              label={tFormulations("fields.mcc_carrier_item")}
              placeholderText={tFormulations(
                "fields.mcc_carrier_item_placeholder",
              )}
              hint={tFormulations("fields.mcc_carrier_item_hint")}
              loadingText={tFormulations(
                "fields.mcc_carrier_item_loading",
              )}
              emptyText={tFormulations("fields.mcc_carrier_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, mcc_carrier_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                setMccCarrierNames((prev) => {
                  // Merge so previously-known names survive even when
                  // the picker page is currently scrolled past them.
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.name;
                  return next;
                });
                setMccCarrierCodes((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.internal_code;
                  return next;
                });
              }}
            />
          ) : null}
          {/* DCP carrier — tablet-only, since capsules don't have a
              DCP line in their excipient math. */}
          {metadata.dosage_form === "tablet" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.dcp_carrier_item_ids}
              preselected={formulation.dcp_carrier_items}
              disabled={!canWrite}
              useAsIn={DCP_CARRIER_USE_CATEGORIES}
              label={tFormulations("fields.dcp_carrier_item")}
              placeholderText={tFormulations(
                "fields.dcp_carrier_item_placeholder",
              )}
              hint={tFormulations("fields.dcp_carrier_item_hint")}
              loadingText={tFormulations(
                "fields.dcp_carrier_item_loading",
              )}
              emptyText={tFormulations("fields.dcp_carrier_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, dcp_carrier_item_ids: ids })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
          {/* Anti-caking picker — capsule + tablet. Optional. Empty
              picker means the formulation ships without any
              Stearate / Silica band at all; non-empty fires the
              combined 1.4% (Stearate 1% + Silica 0.4%) auto-fill,
              split equally across picks. Filters use_as =
              "Anti-caking Agent". */}
          {metadata.dosage_form === "capsule" ||
          metadata.dosage_form === "tablet" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.anti_caking_item_ids}
              preselected={formulation.anti_caking_items}
              disabled={!canWrite}
              useAsIn={ANTI_CAKING_USE_CATEGORIES}
              label={tFormulations("fields.anti_caking_item")}
              placeholderText={tFormulations(
                "fields.anti_caking_item_placeholder",
              )}
              hint={tFormulations("fields.anti_caking_item_hint")}
              loadingText={tFormulations(
                "fields.anti_caking_item_loading",
              )}
              emptyText={tFormulations("fields.anti_caking_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, anti_caking_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                setAntiCakingNames((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.name;
                  return next;
                });
                setAntiCakingCodes((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.internal_code;
                  return next;
                });
              }}
            />
          ) : null}
          {/* Powder fill weight is edited in grams because scientists
              think about scoop mass as "10g", not "10000mg". The
              storage + math stays in mg — ``powderFillG`` is a UI
              draft that converts to mg on every keystroke. */}
          {metadata.dosage_form === "powder" ? (
            <TextField
              label={tFormulations("fields.powder_fill_weight")}
              value={powderFillG}
              onChange={(v) => {
                setPowderFillG(v);
                setMetadata({
                  ...metadata,
                  target_fill_weight_mg: gStringToMgString(v),
                });
              }}
              disabled={!canWrite}
              hint={tFormulations("fields.powder_fill_weight_hint")}
            />
          ) : metadata.dosage_form === "gummy" ? (
            // Per-gummy mass stays in mg — values live in the
            // 500-2500mg band where mg reads more naturally than
            // "0.5g".
            <TextField
              label={tFormulations("fields.gummy_fill_weight")}
              value={metadata.target_fill_weight_mg}
              onChange={(v) =>
                setMetadata({ ...metadata, target_fill_weight_mg: v })
              }
              disabled={!canWrite}
              hint={tFormulations("fields.gummy_fill_weight_hint")}
            />
          ) : null}
          {/* Powder pickers — Flavouring / Sweetener / Colour mirror
              the gummy pickers but pull from powder-relevant
              ``use_as`` pools. The picker mg total = preset rate
              (mg/ml) × water volume, split equally across picks.
              Empty list keeps the generic placeholder row in the
              flavour-system table. */}
          {metadata.dosage_form === "powder" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.flavouring_item_ids}
              preselected={formulation.flavouring_items}
              disabled={!canWrite}
              useAsIn={FLAVOURING_USE_CATEGORIES}
              label={tFormulations("fields.powder_flavouring_item")}
              placeholderText={tFormulations(
                "fields.powder_flavouring_item_placeholder",
              )}
              hint={tFormulations("fields.powder_flavouring_item_hint")}
              loadingText={tFormulations(
                "fields.powder_flavouring_item_loading",
              )}
              emptyText={tFormulations(
                "fields.powder_flavouring_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, flavouring_item_ids: ids })
              }
              onPickedItemsChange={(items) =>
                handlePowderBandPickerChange(
                  setFlavouringLive,
                  "Flavouring",
                  items,
                )
              }
            />
          ) : null}
          {metadata.dosage_form === "powder" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.sweetener_item_ids}
              preselected={formulation.sweetener_items}
              disabled={!canWrite}
              useAsIn={SWEETENER_USE_CATEGORIES}
              label={tFormulations("fields.powder_sweetener_item")}
              placeholderText={tFormulations(
                "fields.powder_sweetener_item_placeholder",
              )}
              hint={tFormulations("fields.powder_sweetener_item_hint")}
              loadingText={tFormulations(
                "fields.powder_sweetener_item_loading",
              )}
              emptyText={tFormulations(
                "fields.powder_sweetener_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, sweetener_item_ids: ids })
              }
              onPickedItemsChange={(items) =>
                handlePowderBandPickerChange(
                  setSweetenerLive,
                  "Sweeteners",
                  items,
                )
              }
            />
          ) : null}
          {metadata.dosage_form === "powder" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.colour_item_ids}
              preselected={formulation.colour_items}
              disabled={!canWrite}
              useAsIn={COLOUR_USE_CATEGORIES}
              label={tFormulations("fields.powder_colour_item")}
              placeholderText={tFormulations(
                "fields.powder_colour_item_placeholder",
              )}
              hint={tFormulations("fields.powder_colour_item_hint")}
              loadingText={tFormulations(
                "fields.powder_colour_item_loading",
              )}
              emptyText={tFormulations(
                "fields.powder_colour_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, colour_item_ids: ids })
              }
              onPickedItemsChange={(items) =>
                handlePowderBandPickerChange(
                  setColourLive,
                  "Colour",
                  items,
                )
              }
            />
          ) : null}
          {/* Powder Acidity Regulator picker -- per-item rows, each
              dosed at the catalogue item's
              ``powder_water_dose_mg_per_ml`` × the formulation's
              water volume. Empty picker = no acidity band. */}
          {metadata.dosage_form === "powder" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.acidity_item_ids}
              preselected={formulation.acidity_items}
              disabled={!canWrite}
              useAsIn={ACIDITY_USE_CATEGORIES}
              label={tFormulations("fields.powder_acidity_item")}
              placeholderText={tFormulations(
                "fields.powder_acidity_item_placeholder",
              )}
              hint={tFormulations("fields.powder_acidity_item_hint")}
              loadingText={tFormulations(
                "fields.powder_acidity_item_loading",
              )}
              emptyText={tFormulations(
                "fields.powder_acidity_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, acidity_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                setAcidityLive((prev) => {
                  const next = { ...prev };
                  for (const it of items) {
                    // Prefer the live picker's attribute map over a
                    // stale server echo so a just-edited dose rate
                    // takes effect without a re-save. Falls back to
                    // the previous entry when the picker emits an
                    // attribute-less id (preselected-only).
                    const attrs = it.attributes ?? null;
                    const rawDose = attrs?.["powder_water_dose_mg_per_ml"];
                    const dose =
                      typeof rawDose === "number"
                        ? rawDose
                        : typeof rawDose === "string" && rawDose.trim() !== ""
                          ? Number.parseFloat(rawDose)
                          : null;
                    const rawIngredient =
                      attrs?.["ingredient_list_name"];
                    const label =
                      typeof rawIngredient === "string" &&
                      rawIngredient.trim() !== ""
                        ? rawIngredient
                        : it.name;
                    const rawUseAs = attrs?.["use_as"];
                    const useAs =
                      typeof rawUseAs === "string" ? rawUseAs : "";
                    next[it.id] = {
                      label,
                      name: it.name,
                      useAs: useAs || prev[it.id]?.useAs || "",
                      waterDoseMgPerMl:
                        attrs !== null
                          ? Number.isFinite(dose ?? NaN)
                            ? dose
                            : null
                          : (prev[it.id]?.waterDoseMgPerMl ?? null),
                    };
                  }
                  return next;
                });
              }}
            />
          ) : null}
          {/* Powder Anti-caking picker -- same M2M as capsule/tablet.
              Empty picker = no Stearate / Silica band. Picks are
              name-classified (silica-only -> 0.4%, stearate-only ->
              1.0%, both -> 1.4% of total active). */}
          {metadata.dosage_form === "powder" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.anti_caking_item_ids}
              preselected={formulation.anti_caking_items}
              disabled={!canWrite}
              useAsIn={ANTI_CAKING_USE_CATEGORIES}
              label={tFormulations("fields.anti_caking_item")}
              placeholderText={tFormulations(
                "fields.anti_caking_item_placeholder",
              )}
              hint={tFormulations("fields.anti_caking_item_hint")}
              loadingText={tFormulations(
                "fields.anti_caking_item_loading",
              )}
              emptyText={tFormulations("fields.anti_caking_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, anti_caking_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                setAntiCakingNames((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.name;
                  return next;
                });
                setAntiCakingCodes((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.internal_code;
                  return next;
                });
              }}
            />
          ) : null}
          {/* Powder Carrier picker -- Maltodextrin and similar
              bulking agents. Fills the remainder of the sachet after
              actives + other bands. Empty picker = no carrier band
              (the powder may be under-filled). */}
          {metadata.dosage_form === "powder" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.powder_carrier_item_ids}
              preselected={formulation.powder_carrier_items}
              disabled={!canWrite}
              useAsIn={MCC_CARRIER_USE_CATEGORIES}
              label={tFormulations("fields.powder_carrier_item")}
              placeholderText={tFormulations(
                "fields.powder_carrier_item_placeholder",
              )}
              hint={tFormulations("fields.powder_carrier_item_hint")}
              loadingText={tFormulations(
                "fields.powder_carrier_item_loading",
              )}
              emptyText={tFormulations(
                "fields.powder_carrier_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, powder_carrier_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                // Bare item names only -- the grouping helper wraps
                // them in "Carrier (...)" outside this cache.
                setPowderCarrierNames((prev) => {
                  const next = { ...prev };
                  for (const it of items) next[it.id] = it.name;
                  return next;
                });
              }}
            />
          ) : null}
          {metadata.dosage_form === "gummy" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.gummy_base_item_ids}
              preselected={formulation.gummy_base_items}
              disabled={!canWrite}
              useAsIn={GUMMY_BASE_USE_CATEGORIES}
              label={tFormulations("fields.gummy_base_item")}
              placeholderText={tFormulations(
                "fields.gummy_base_item_placeholder",
              )}
              hint={tFormulations("fields.gummy_base_item_hint")}
              loadingText={tFormulations(
                "fields.gummy_base_item_loading",
              )}
              emptyText={tFormulations("fields.gummy_base_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, gummy_base_item_ids: ids })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
          {metadata.dosage_form === "gummy" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.acidity_item_ids}
              preselected={formulation.acidity_items}
              disabled={!canWrite}
              useAsIn={ACIDITY_USE_CATEGORIES}
              label={tFormulations("fields.acidity_item")}
              placeholderText={tFormulations(
                "fields.acidity_item_placeholder",
              )}
              hint={tFormulations("fields.acidity_item_hint")}
              loadingText={tFormulations("fields.acidity_item_loading")}
              emptyText={tFormulations("fields.acidity_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, acidity_item_ids: ids })
              }
              onPickedItemsChange={(items) => {
                // Gummy doesn't read the dose rate, but it still
                // benefits from a live label cache so toggling a
                // pick updates the brackets in the totals panel
                // without a save round-trip.
                setAcidityLive((prev) => {
                  const next = { ...prev };
                  for (const it of items) {
                    const attrs = it.attributes ?? null;
                    const rawIngredient = attrs?.["ingredient_list_name"];
                    const label =
                      typeof rawIngredient === "string" &&
                      rawIngredient.trim() !== ""
                        ? rawIngredient
                        : it.name;
                    const rawUseAs = attrs?.["use_as"];
                    const useAs =
                      typeof rawUseAs === "string" ? rawUseAs : "";
                    next[it.id] = {
                      label,
                      name: it.name,
                      useAs: useAs || prev[it.id]?.useAs || "",
                      waterDoseMgPerMl:
                        prev[it.id]?.waterDoseMgPerMl ?? null,
                    };
                  }
                  return next;
                });
              }}
            />
          ) : null}
          {metadata.dosage_form === "gummy" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.flavouring_item_ids}
              preselected={formulation.flavouring_items}
              disabled={!canWrite}
              useAsIn={FLAVOURING_USE_CATEGORIES}
              label={tFormulations("fields.flavouring_item")}
              placeholderText={tFormulations(
                "fields.flavouring_item_placeholder",
              )}
              hint={tFormulations("fields.flavouring_item_hint")}
              loadingText={tFormulations(
                "fields.flavouring_item_loading",
              )}
              emptyText={tFormulations(
                "fields.flavouring_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, flavouring_item_ids: ids })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
          {metadata.dosage_form === "gummy" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.colour_item_ids}
              preselected={formulation.colour_items}
              disabled={!canWrite}
              useAsIn={COLOUR_USE_CATEGORIES}
              label={tFormulations("fields.colour_item")}
              placeholderText={tFormulations(
                "fields.colour_item_placeholder",
              )}
              hint={tFormulations("fields.colour_item_hint")}
              loadingText={tFormulations(
                "fields.colour_item_loading",
              )}
              emptyText={tFormulations(
                "fields.colour_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({ ...metadata, colour_item_ids: ids })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
          {metadata.dosage_form === "gummy" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.glazing_item_ids}
              preselected={formulation.glazing_items}
              disabled={!canWrite}
              useAsIn={GLAZING_USE_CATEGORIES}
              label={tFormulations("fields.glazing_item")}
              placeholderText={tFormulations(
                "fields.glazing_item_placeholder",
              )}
              hint={tFormulations("fields.glazing_item_hint")}
              loadingText={tFormulations("fields.glazing_item_loading")}
              emptyText={tFormulations("fields.glazing_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, glazing_item_ids: ids })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
          {metadata.dosage_form === "gummy" ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.gelling_item_ids}
              preselected={formulation.gelling_items}
              disabled={!canWrite}
              useAsIn={GELLING_USE_CATEGORIES}
              label={tFormulations("fields.gelling_item")}
              placeholderText={tFormulations(
                "fields.gelling_item_placeholder",
              )}
              hint={tFormulations("fields.gelling_item_hint")}
              loadingText={tFormulations("fields.gelling_item_loading")}
              emptyText={tFormulations("fields.gelling_item_empty")}
              onChange={(ids) =>
                setMetadata({ ...metadata, gelling_item_ids: ids })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
          {metadata.dosage_form === "gummy" &&
          metadata.gelling_item_ids.length > 0 ? (
            <CatalogueMultiPicker
              orgId={orgId}
              value={metadata.premix_sweetener_item_ids}
              preselected={formulation.premix_sweetener_items}
              disabled={!canWrite}
              useAsIn={GUMMY_BASE_USE_CATEGORIES}
              label={tFormulations("fields.premix_sweetener_item")}
              placeholderText={tFormulations(
                "fields.premix_sweetener_item_placeholder",
              )}
              hint={tFormulations("fields.premix_sweetener_item_hint")}
              loadingText={tFormulations(
                "fields.premix_sweetener_item_loading",
              )}
              emptyText={tFormulations(
                "fields.premix_sweetener_item_empty",
              )}
              onChange={(ids) =>
                setMetadata({
                  ...metadata,
                  premix_sweetener_item_ids: ids,
                })
              }
              onPickedItemsChange={mergePendingPicks}
            />
          ) : null}
        </div>
      </section>
      </div>

      {/* ------------------------------------------------------------ */}
      {/* Setup (continued) — trailing product-setup fields (tab: SETUP) */}
      {/* Servings, appearance, disintegration spec, directions of     */}
      {/* use, suggested dosage. Second Setup wrapper segment because  */}
      {/* the excipient pickers above split the metadata form.         */}
      {/* ------------------------------------------------------------ */}
      <div className={activeTab === "setup" ? "flex flex-col gap-10" : "hidden"}>
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
          {/* Serving-size units vary by form: capsules, tablets,
              gummies, and powders (scoops) each get their own label
              so the input reads naturally in the scientist's mental
              model. The line math divides ``label_claim_mg`` by this
              value so ``mg / scoop`` scales correctly when a powder
              serving is 2+ scoops. */}
          <NumberField
            label={tFormulations(
              metadata.dosage_form === "capsule"
                ? "fields.serving_size_capsule"
                : metadata.dosage_form === "tablet"
                  ? "fields.serving_size_tablet"
                  : metadata.dosage_form === "gummy"
                    ? "fields.serving_size_gummy"
                    : metadata.dosage_form === "powder"
                      ? "fields.serving_size_powder"
                      : "fields.serving_size",
            )}
            value={metadata.serving_size}
            onChange={(v) => setMetadata({ ...metadata, serving_size: v })}
            disabled={!canWrite}
            hint={tFormulations(
              `fields.serving_size_hint_${metadata.dosage_form}` as
                | "fields.serving_size_hint_capsule"
                | "fields.serving_size_hint_tablet"
                | "fields.serving_size_hint_gummy"
                | "fields.serving_size_hint_powder"
                | "fields.serving_size_hint_default",
            )}
          />
          <NumberField
            label={tFormulations("fields.servings_per_pack")}
            value={metadata.servings_per_pack}
            onChange={(v) => setMetadata({ ...metadata, servings_per_pack: v })}
            disabled={!canWrite}
            hint={tFormulations("fields.servings_per_pack_hint")}
          />
          <TextField
            label={tFormulations("fields.appearance")}
            value={metadata.appearance}
            onChange={(v) => setMetadata({ ...metadata, appearance: v })}
            disabled={!canWrite}
            placeholder={tFormulations(
              `fields.appearance_placeholder_${metadata.dosage_form}` as
                | "fields.appearance_placeholder_capsule"
                | "fields.appearance_placeholder_tablet"
                | "fields.appearance_placeholder_gummy"
                | "fields.appearance_placeholder_powder"
                | "fields.appearance_placeholder_default",
            )}
            hint={tFormulations("fields.appearance_hint")}
          />
          <TextField
            label={tFormulations("fields.disintegration_spec")}
            value={metadata.disintegration_spec}
            onChange={(v) =>
              setMetadata({ ...metadata, disintegration_spec: v })
            }
            disabled={!canWrite}
            placeholder={tFormulations("fields.disintegration_spec_placeholder")}
            hint={tFormulations("fields.disintegration_spec_hint")}
          />
          <TextAreaField
            label={tFormulations("fields.directions_of_use")}
            value={metadata.directions_of_use}
            onChange={(v) =>
              setMetadata({ ...metadata, directions_of_use: v })
            }
            disabled={!canWrite}
            placeholder={tFormulations(
              `fields.directions_of_use_placeholder_${metadata.dosage_form}` as
                | "fields.directions_of_use_placeholder_capsule"
                | "fields.directions_of_use_placeholder_tablet"
                | "fields.directions_of_use_placeholder_gummy"
                | "fields.directions_of_use_placeholder_powder"
                | "fields.directions_of_use_placeholder_default",
            )}
            hint={tFormulations("fields.directions_of_use_hint")}
          />
          <TextAreaField
            label={tFormulations("fields.suggested_dosage")}
            value={metadata.suggested_dosage}
            onChange={(v) =>
              setMetadata({ ...metadata, suggested_dosage: v })
            }
            disabled={!canWrite}
            placeholder={tFormulations(
              `fields.suggested_dosage_placeholder_${metadata.dosage_form}` as
                | "fields.suggested_dosage_placeholder_capsule"
                | "fields.suggested_dosage_placeholder_tablet"
                | "fields.suggested_dosage_placeholder_gummy"
                | "fields.suggested_dosage_placeholder_powder"
                | "fields.suggested_dosage_placeholder_default",
            )}
            hint={tFormulations("fields.suggested_dosage_hint")}
          />
        </div>
      </section>

      {/* Finished-product spec — mirrored to the finished stage's PSP
          spec sub-table on push. Setup is the source of truth so
          scientists never re-type these on each stage. */}
      <FinishedProductSpecSetupSection
        orgId={orgId}
        metadata={metadata}
        onChange={(patch) => setMetadata({ ...metadata, ...patch })}
        canWrite={canWrite}
      />

      {/* Warehouse identity + allergens — mirrored to the finished
          stage's PSP item on push (storage tags, reorder points, EU
          allergens, may-contain). */}
      <WarehouseAndAllergensSetupSection
        orgId={orgId}
        metadata={metadata}
        onChange={(patch) => setMetadata({ ...metadata, ...patch })}
        canWrite={canWrite}
        derivedAllergenKeys={formulation.derived_allergen_keys ?? []}
      />

      {/* Photos + certificates render side-by-side on wide screens
          — both are compact PSP-mirror widgets so they don't need
          full-width real estate, and pairing them cuts the Setup
          tab's vertical scroll. Stack on mobile. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <FormulationPhotosSetupSection
          orgId={orgId}
          formulationId={formulation.id}
          canWrite={canWrite}
        />
        <FormulationCertificatesSetupSection
          orgId={orgId}
          formulationId={formulation.id}
          canWrite={canWrite}
        />
      </div>

      </div>

      {/* ------------------------------------------------------------ */}
      {/* Production stages  (tab: STAGES)                             */}
      {/* ------------------------------------------------------------ */}
      <div
        className={
          activeTab === "stages" ? "flex flex-col gap-10" : "hidden"
        }
      >
      <StageStrip
        pspBaseUrl={organization?.psp_base_url ?? null}
        pspFinishedProductUuid={formulation.psp_finished_product_uuid ?? null}
        onSyncNow={async () => {
          // Ship the FE-computed full BOM per stage so PSP's per-
          // stage BOM matches what NPD displays (actives + every
          // excipient band at compute-adjusted mg). Rows without a
          // resolvable local item id (compute-only placeholders) are
          // dropped server-side.
          const stageBoms: Record<
            string,
            {
              item_id: string | null;
              psp_item_uuid?: string | null;
              mg: number;
              sort_order: number;
            }[]
          > = {};
          bomLinesByStage.forEach((rows, stageId) => {
            stageBoms[stageId] = rows
              .filter(
                (row) => Boolean(row.itemId) || Boolean(row.pspItemUuid),
              )
              .map((row, idx) => ({
                item_id: row.itemId,
                psp_item_uuid: row.pspItemUuid ?? null,
                mg: row.mg,
                sort_order: idx,
              }));
          });
          await syncPspMutation.mutateAsync({ stageBoms });
        }}
        syncPending={syncPspMutation.isPending}
        orgId={orgId}
        formulation={formulation}
        canEdit={canWrite}
        activeStageId={activeStageId}
        onActiveStageChange={setActiveStageId}
        lines={lines}
        onSaved={(updated) => {
          // Server has fresh stage state — mirror it into the
          // builder's local ``formulation`` so the Stage BOMs
          // preview + picker chip + line render + metadata pane
          // all see the same data the strip does. Without this
          // the parent stays stale and the four surfaces drift.
          setFormulation(updated);
          setLines(linesFrom(updated));
        }}
        onDirtyChange={setStagesDirty}
        onRegisterSave={(fn) => {
          stagesSaveHandleRef.current = fn;
        }}
      />

      </div>

      {/* ------------------------------------------------------------ */}
      {/* Builder: picker + lines + totals  (tab: FORMULATION)         */}
      {/* Also carries the compliance + declaration panels since       */}
      {/* those are derived from the ingredient list. Standalone tab   */}
      {/* — the operator builds the flat recipe here (no stage         */}
      {/* awareness); stage routing lives on the Routing tab.          */}
      {/* ------------------------------------------------------------ */}
      <div
        className={
          activeTab === "formulation"
            ? "flex flex-col gap-10"
            : "hidden"
        }
      >
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
        {/* Picker */}
        <div className="relative rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
          {/* Blocking overlay while a mirror round-trip is in
              flight. Sits above every interactive control in the
              picker card (search input + rows) so no click lands
              during the wait. Keeps the card outline visible so the
              operator doesn't lose their place in the layout. */}
          {mirrorPsp.isPending || pickingVisible ? (
            <div
              className="pointer-events-auto fixed inset-0 z-[999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
              role="status"
              aria-live="assertive"
              style={{ position: "fixed" }}
            >
              <div className="flex min-w-[320px] flex-col items-center gap-4 rounded-2xl bg-white px-8 py-6 shadow-2xl ring-1 ring-black/10">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-orange-100">
                  <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
                </div>
                <div className="text-center">
                  <p className="text-base font-semibold text-ink-1000">
                    Adding ingredient…
                  </p>
                  <p className="mt-1 text-xs text-ink-600">
                    Waiting for PSP so this pick lands on the right
                    stage.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("builder.picker_title")}
          </p>
          {pspLive ? (
            // Small non-translated affordance so scientists know
            // where these rows come from. Deliberately not chip-
            // heavy — the picker header already labels this pane
            // as "Ingredients".
            <p className="mt-1 text-[11px] font-medium text-orange-700">
              Sourced from PSP
            </p>
          ) : null}
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={tFormulations("builder.picker_search")}
            disabled={!canWrite || mirrorPsp.isPending || pickingVisible}
            className="mt-3 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-50"
          />
          <ul
            ref={pickerScrollRef}
            className="mt-3 flex max-h-[420px] flex-col gap-1 overflow-y-auto"
          >
            {(pspLive
              ? pspPickerQuery.isLoading
              : pickerQuery.isLoading) && pickerItems.length === 0 ? (
              <li className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tCommon("states.loading")}
              </li>
            ) : pickerItems.length === 0 ? (
              <li className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tFormulations("builder.picker_empty")}
              </li>
            ) : (
              // O(1) dedup: build two sets ONCE per render pass —
              // one keyed on the local Item id (for legacy /
              // already-mirrored picks), one keyed on the item's
              // internal_code (a stable identifier that survives
              // PSP → local mirror translation, so a PSP picker row
              // with ``id=psp:<uuid>`` still matches its already-
              // added local twin whose ``item_id`` is a local UUID).
              // Replaces an O(N × M) ``lines.some(...)`` scan run
              // per picker row on every render.
              (() => {
                // Formulation tab hosts the whole recipe in one
                // place — dedup runs across every picked line so a
                // single active can't be added twice. Stage-scoped
                // dedup went away with the per-stage drill-down.
                const scopedLines = lines;
                const pickedIds = new Set<string>();
                const pickedCodes = new Set<string>();
                for (const l of scopedLines) {
                  if (l.item_id) pickedIds.add(l.item_id);
                  if (l.item_internal_code)
                    pickedCodes.add(l.item_internal_code);
                }
                const mirroringUuid =
                  mirrorPsp.isPending && typeof mirrorPsp.variables === "string"
                    ? mirrorPsp.variables
                    : null;
                // Lock EVERY picker row while any mirror round-trip
                // is in flight — not just the row being mirrored.
                // The delay between click → server response is where
                // multi-click races happen (operator taps three rows
                // in quick succession, all three fan out, ordering
                // of resolutions decides which stage / use_as each
                // ends up bound to). A page-wide lock forces one
                // pick to fully land before the next can start.
                const pickerLocked = mirrorPsp.isPending || pickingVisible;
                return pickerItems.map((item) => {
                  const already =
                    pickedIds.has(item.id) ||
                    (item.internal_code
                      ? pickedCodes.has(item.internal_code)
                      : false);
                  const failure = canComputeMaterial(
                    attributesFromItem(item),
                  );
                  const mirroring =
                    item.id.startsWith("psp:") &&
                    mirroringUuid === item.id.slice("psp:".length);
                  const disabled =
                    !canWrite ||
                    already ||
                    failure !== null ||
                    mirroring ||
                    pickerLocked;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => addIngredient(item)}
                        title={
                          already
                            ? "Already added on this formulation"
                            : mirroring
                              ? "Adding to builder…"
                              : pickerLocked
                                ? "Wait — finishing the previous pick"
                                : failure
                                  ? tFormulations(
                                      `builder.failure_reason.${failure}` as `builder.failure_reason.missing_claim`,
                                    )
                                  : undefined
                        }
                        className={`flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs text-ink-1000 ring-1 ring-inset hover:bg-ink-100 disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-500 ${
                          failure ? "ring-warning/30" : "ring-ink-200"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold">
                            {item.name}
                          </span>
                          <span className="text-ink-600">
                            {item.internal_code || "—"}
                          </span>
                          {failure ? (
                            <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-warning">
                              {tFormulations(
                                `builder.failure_reason.${failure}` as `builder.failure_reason.missing_claim`,
                              )}
                            </span>
                          ) : null}
                        </span>
                        {/* Status pill on the right edge of the
                            row. Priority: spinner while a mirror
                            round-trip is in flight for THIS row →
                            "Added" chip when the ingredient already
                            sits on the formulation. Silent
                            otherwise so the row stays scannable. */}
                        {mirroring ? (
                          <span
                            aria-label="Adding to builder…"
                            className="mt-0.5 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-orange-700"
                          >
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Adding
                          </span>
                        ) : already ? (
                          <span
                            aria-label="Already added"
                            className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-600"
                          >
                            <Check className="h-3 w-3" />
                            Added
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                });
              })()
            )}
            {!pspLive && pickerItems.length > 0 ? (
              <li ref={pickerSentinelRef} aria-hidden className="h-px" />
            ) : null}
            {!pspLive && pickerQuery.isFetchingNextPage ? (
              <li className="py-2 text-center text-xs font-medium uppercase tracking-wide text-ink-500">
                {tCommon("states.loading")}
              </li>
            ) : null}
          </ul>
        </div>

        {/* Lines editor */}
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("builder.ingredients")}
          </p>
          {metadata.serving_size > 1 ? (
            <p className="mt-2 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-800 ring-1 ring-inset ring-orange-200">
              {tFormulations("builder.serving_size_banner", {
                units: metadata.serving_size,
              })}
            </p>
          ) : null}
          {(() => {
            // Drill-down = scoped to a single stage. Filter the
            // Formulation tab always shows the full recipe — every
            // pick regardless of stage assignment (routing lives on
            // the Routing tab, not here).
            const visibleLines = lines;
            return visibleLines.length === 0 ? (
            <p className="mt-6 text-sm text-ink-600">
              {tFormulations("builder.picker_none_added")}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-ink-100">
                    <th className="px-2 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                      {tFormulations("columns.name")}
                    </th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                      {tFormulations("builder.label_claim_column")}
                    </th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                      {tFormulations("builder.mg_per_serving_column")}
                    </th>
                    <th className="px-2 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                      {tFormulations("builder.nrv_column")}
                    </th>
                    <th className="px-2 py-2" />
                  </tr>
                </thead>
              <tbody>
                {visibleLines.map((line) => {
                  const computed = liveTotals.lineValues.get(line.key) ?? null;
                  const failure: LineFailureReason | null =
                    liveTotals.lineFailures.get(line.key) ??
                    canComputeMaterial(line.item_attributes);
                  const showFailure =
                    failure !== null && failure !== "missing_claim";
                  const parseOverrideForExplain = (raw: string): number | null => {
                    if (!raw) return null;
                    const v = Number.parseFloat(raw);
                    return Number.isFinite(v) ? v : null;
                  };
                  const explanation = explainLine(
                    line.item_attributes,
                    Number.parseFloat(line.label_claim_mg || "0"),
                    {
                      purityOverride: parseOverrideForExplain(
                        line.purity_override,
                      ),
                      overageOverride: parseOverrideForExplain(
                        line.overage_override,
                      ),
                      extractRatioOverride: parseOverrideForExplain(
                        line.extract_ratio_override,
                      ),
                    },
                  );
                  return (
                    <Fragment key={line.key}>
                    <tr
                      className="border-b border-ink-100 last:border-b-0"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-start gap-2">
                          {showFailure ? (
                            <span
                              className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-warning"
                              aria-hidden
                            />
                          ) : null}
                          <div>
                            <span className="block font-semibold">
                              {line.item_name}
                            </span>
                            <span className="text-xs text-ink-600">
                              {line.item_internal_code || "—"}
                            </span>
                            {showFailure ? (
                              <span className="mt-1 block text-xs font-medium uppercase tracking-wide text-warning">
                                {tFormulations(
                                  `builder.failure_reason.${failure}` as `builder.failure_reason.missing_claim`,
                                )}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3 text-right">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={line.label_claim_mg}
                          disabled={!canWrite}
                          onChange={(e) =>
                            updateLineClaim(line.key, e.target.value)
                          }
                          className="w-20 rounded-xl bg-ink-0 px-2 py-1 text-right text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </td>
                      <td className="px-2 py-3 text-right text-xs">
                        <div>
                          {computed !== null
                            ? numberFormatter.format(computed)
                            : "—"}
                        </div>
                        {computed !== null && metadata.serving_size > 1 ? (
                          <div className="mt-0.5 text-[10px] font-medium text-orange-700">
                            {tFormulations("builder.per_serving_total_hint", {
                              total: numberFormatter.format(
                                computed * metadata.serving_size,
                              ),
                            })}
                          </div>
                        ) : null}
                        {computed !== null && explanation ? (
                          <div
                            className="mt-0.5 text-[10px] text-ink-500"
                            title="How this number was computed"
                          >
                            {explanation}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 text-right text-xs tabular-nums text-ink-700">
                        {(() => {
                          const nrv = computeNrvPercent(
                            line.item_attributes,
                            Number.parseFloat(line.label_claim_mg || "0"),
                          );
                          const target = getNrvTargetMg(line.item_attributes);
                          const hint =
                            target !== null
                              ? tFormulations("builder.nrv_hint_100", {
                                  mg: numberFormatter.format(target),
                                })
                              : null;
                          let display: string;
                          if (nrv === null) {
                            display = "—";
                          } else {
                            // Integer display with a space thousands
                            // separator so the number is unambiguous
                            // against our ``.``-as-decimal convention.
                            // ``90 909%`` reads as "ninety thousand",
                            // never as "ninety point nine zero nine".
                            const rounded = Math.round(nrv);
                            const grouped = String(rounded).replace(
                              /\B(?=(\d{3})+(?!\d))/g,
                              "\u202F",
                            );
                            display = `${grouped}%`;
                          }
                          return (
                            <>
                              <div>{display}</div>
                              {hint ? (
                                <div className="mt-0.5 text-[10px] text-ink-500">
                                  {hint}
                                </div>
                              ) : null}
                            </>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => toggleOverridePanel(line.key)}
                            aria-label={tFormulations(
                              "builder.toggle_overrides",
                            )}
                            title={tFormulations(
                              "builder.toggle_overrides",
                            )}
                            className={`inline-flex items-center justify-center rounded-md p-1.5 text-ink-500 hover:bg-ink-50 ${
                              expandedOverrides.has(line.key)
                                ? "bg-ink-100 text-ink-1000"
                                : ""
                            }`}
                          >
                            <Sliders className="h-4 w-4" />
                          </button>
                          {canWrite ? (
                            <button
                              type="button"
                              onClick={() => removeLine(line.key)}
                              aria-label={tFormulations("builder.remove_line")}
                              title={tFormulations("builder.remove_line")}
                              className="inline-flex items-center justify-center rounded-md p-1.5 text-ink-500 hover:bg-ink-50 hover:text-danger"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    {expandedOverrides.has(line.key) ? (
                      <tr
                        key={`${line.key}-overrides`}
                        className="border-b border-ink-100 bg-ink-50/50 last:border-b-0"
                      >
                        <td colSpan={5} className="px-3 py-3">
                          <LineOverridesPanel
                            line={line}
                            disabled={!canWrite}
                            onChange={(field, value) =>
                              updateLineOverride(line.key, field, value)
                            }
                            tFormulations={tFormulations}
                          />
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </div>
            );
          })()}
        </div>

        {/* Totals + viability */}
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("builder.totals")}
          </p>

          {!supported ? (
            <p className="mt-4 text-sm text-ink-600">
              {tFormulations("builder.unsupported_form")}
            </p>
          ) : null}

          <TotalsBlock
            totals={liveTotals}
            servingSize={metadata.serving_size}
            dosageForm={metadata.dosage_form}
            numberFormatter={numberFormatter}
            tFormulations={tFormulations}
            // Stable refs from the parent's useMemo so the memoised
            // TotalsBlock can short-circuit when these don't change.
            // Picks carry id + name + code so each SKU renders as its
            // own row; overrides feed the ``allocateBandShares`` split.
            // Editing happens in the dedicated fine-tune panel below —
            // this column is a status readout only.
            mccCarrierPicks={mccCarrierPicks}
            antiCakingPicks={antiCakingPicks}
            dcpCarrierPicks={dcpCarrierPicks}
            excipientOverrides={metadata.excipient_overrides}
          />
          {hasTrialBatches ? (
            // Override editor only surfaces once a trial batch exists
            // -- before then the lab hasn't measured a real fill, so
            // the band percentages don't have a physical baseline to
            // tune against.
            <ExcipientOverridesPanel
              overrides={metadata.excipient_overrides}
              dosageForm={metadata.dosage_form}
              hasAntiCaking={metadata.anti_caking_item_ids.length > 0}
              hasDcpCarrier={metadata.dcp_carrier_item_ids.length > 0}
              hasMccCarrier={metadata.mcc_carrier_item_ids.length > 0}
              hasFlavouring={metadata.flavouring_item_ids.length > 0}
              hasSweetener={metadata.sweetener_item_ids.length > 0}
              hasColour={metadata.colour_item_ids.length > 0}
              hasGelling={metadata.gelling_item_ids.length > 0}
              perItemRates={perItemRateRows}
              disabled={!canWrite}
              onChange={handleExcipientOverridesChange}
              tFormulations={tFormulations}
            />
          ) : null}
        </div>
      </section>

      {/* ------------------------------------------------------------ */}
      {/* Excipient fine-tune — wide surface below the builder where   */}
      {/* the scientist can shift mg / % between picks within each     */}
      {/* band. The sidebar Excipients block is a read-only echo; all  */}
      {/* editing lives here so the layout has room for two inputs +   */}
      {/* a full ingredient name without wrap-hell. Only mounts when   */}
      {/* at least one band has picks — no clutter for gummies or      */}
      {/* early-build formulations.                                    */}
      {/* ------------------------------------------------------------ */}
      <ExcipientFineTunePanel
        totalWeightMg={liveTotals.totalWeightMg}
        pspBaseUrl={organization?.psp_base_url ?? null}
        productName={formulation.name}
        productCode={formulation.code}
        activeLines={lines
          .map((line) => {
            const nominalMg = Number.parseFloat(line.label_claim_mg || "0");
            return {
              key: line.key,
              name: line.item_name,
              code: line.item_internal_code || "",
              pspSourceUuid: line.item_psp_source_uuid ?? null,
              nominalMg: Number.isFinite(nominalMg) ? nominalMg : 0,
              savedMg: savedActiveMgByLineKey.get(line.key) ?? null,
            };
          })
          .filter((row) => row.nominalMg > 0)}
        onActiveMgChange={canWrite ? updateLineClaim : null}
        dirty={metadataDirty || linesDirty}
        onRevertAllUnsaved={canWrite ? handleRevertAllUnsaved : null}
        bands={
          // Band-total dosing (compute picks a band total, split
          // across the SKUs the scientist ticked) only applies to
          // capsule + tablet forms. For powder / gummy the same SKUs
          // route through the per-item ``excipients.rows`` branch
          // (each SKU carries its own ``powder_water_dose_mg_per_ml``
          // rate). Passing empty ``bands`` for those forms keeps the
          // per-item rows as the single source of truth and avoids
          // showing a phantom 0-mg row for every band.
          metadata.dosage_form === "capsule" ||
          metadata.dosage_form === "tablet"
            ? [
                {
                  key: "anti_caking",
                  label: tFormulations("builder.excipients.anti_caking"),
                  totalMg:
                    (liveTotals.excipients?.mgStearateMg ?? 0) +
                    (liveTotals.excipients?.silicaMg ?? 0),
                  picks: antiCakingPicks,
                },
                {
                  key: "dcp",
                  label: tFormulations("builder.excipients.dcp"),
                  totalMg: liveTotals.excipients?.dcpMg ?? 0,
                  picks: dcpCarrierPicks,
                },
                {
                  key: "mcc",
                  label: tFormulations("builder.excipients.mcc"),
                  totalMg: liveTotals.excipients?.mccMg ?? 0,
                  picks: mccCarrierPicks,
                },
              ]
            : []
        }
        overrides={metadata.excipient_overrides}
        onChange={canWrite ? handleExcipientOverridesChange : null}
        canEdit={canWrite}
        // Capsule shell rows — same source as the stage BOMs. Read-
        // only in this panel (the shell is picked in Setup / auto-
        // resolved from PSP), just shown here so the scientist sees
        // the full BOM the finished product actually ships with.
        extraRows={(() => {
          // Reuse the same "full BOM" list that feeds the stage cards
          // + routing tab. Drop rows already covered by other props on
          // this panel — actives are in ``activeLines``, and
          // anti-caking / DCP / MCC are the editable ``bands``. What
          // remains: capsule shells, flavourings, sweeteners, colours,
          // acidity regulators, gelling / glazing / premix sweetener,
          // powder carrier, gummy base, and any pick compute couldn't
          // dose (rate missing → mg=0 fallback from the ensured-
          // visibility pass). Sync-to-PSP + stage cards + this panel
          // then read from one source.
          const stages = formulation.stages;
          const firstStageId = stages[0]?.id;
          const source: readonly BomLine[] =
            (firstStageId
              ? bomLinesByStage.get(firstStageId) ?? []
              : []);
          const alreadyCovered = new Set<string>([
            // Capsule-branch band slug (from ``deriveStageBomLines``
            // ``emitBand`` — line 5865). Rendered by the editable
            // ``bands`` prop above.
            "anticaking",
            // Powder-branch per-item slug for the same band (from
            // ``math.ts`` per-item loop). Excluded here so we don't
            // double-render Silica in editable ``bands`` AND read-only
            // ``extraRows`` when both branches emit at once.
            "anti_caking",
            "mcc",
            "dcp",
          ]);
          const rows: {
            key: string;
            label: string;
            code?: string;
            mg: number;
            hint?: string;
            itemId?: string;
            pspSourceUuid?: string | null;
            notDosed?: boolean;
            /** Band placeholder — compute emitted an mg total but no
             *  SKU is picked for this band yet, so the row can't
             *  actually procure anything. Surfaced as an amber "PICK
             *  A SKU" call-to-action so the scientist knows the
             *  formula isn't finished. */
            needsPick?: boolean;
          }[] = [];
          for (const row of source) {
            const [prefix] = row.key.split(":");
            if (!prefix) continue;
            // Skip actives — they're the editable ``activeLines``.
            if (prefix === "active") continue;
            // For capsule / tablet forms the anti-caking / MCC / DCP
            // rows are rendered by the editable ``bands`` prop above.
            // For powder / gummy those bands don't exist (``bands ===
            // []``) so we KEEP the per-item rows in ``extraRows``
            // instead — otherwise Silica / DCP would vanish from
            // powder Fine-tune. This mirrors the FE compute branch
            // that dosage-form-gates the band split.
            if (
              (metadata.dosage_form === "capsule" ||
                metadata.dosage_form === "tablet") &&
              alreadyCovered.has(prefix)
            ) {
              continue;
            }
            // Skip the synthesised "prior semi" link — not a real
            // ingredient, doesn't belong here.
            if (prefix === "semi") continue;
            // Band-placeholder detection: any row with an mg total
            // but no ``itemId`` is a placeholder the scientist needs
            // to attach to a real SKU (glazing / gelling / colour /
            // flavouring / gummy-base / water). Without an itemId
            // procurement has nothing to source, so it can't ship
            // as-is even though the mass is dosed. Flag it so the
            // fine-tune UI renders an amber "PICK A SKU" pill and
            // adds it to the top-of-panel incomplete-bands banner.
            // Rows that already resolved to a pick (``itemId``
            // non-null) — including the water row when a water-
            // named gummy_base SKU was picked — skip the warning.
            const isBandPlaceholder = !row.itemId && row.mg > 0;
            rows.push({
              key: row.key,
              label: row.label,
              code: row.code || undefined,
              mg: row.mg,
              itemId: row.itemId ?? undefined,
              pspSourceUuid: row.pspItemUuid ?? null,
              notDosed: row.mg <= 0 && !!row.itemId,
              needsPick: isBandPlaceholder,
            });
          }
          return rows;
        })()}
        numberFormatter={numberFormatter}
        tFormulations={tFormulations}
      />

      {/* ------------------------------------------------------------ */}
      {/* F2a — compliance + ingredient declaration                    */}
      {/* ------------------------------------------------------------ */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <CompliancePanel
          compliance={compliance}
          allergens={allergens}
          tFormulations={tFormulations}
          hasLines={lines.length > 0}
        />
        <DeclarationPanel
          declaration={declaration}
          allergens={allergens}
          tFormulations={tFormulations}
          hasLines={lines.length > 0}
        />
      </section>

      </div>

      {/* ------------------------------------------------------------ */}
      {/* Routing tab — Wizard Step 3: assign every ingredient        */}
      {/* (actives + compute-derived band picks) to a manufacturing   */}
      {/* stage. Save materialises band picks as FormulationLine rows */}
      {/* with source_kind='band_pick' so the PSP push cascade reads  */}
      {/* each stage's real BOM from the ORM.                          */}
      {/* ------------------------------------------------------------ */}
      <div className={activeTab === "routing" ? "flex flex-col gap-6" : "hidden"}>
        <RoutingTabBody
          orgId={orgId}
          formulation={formulation}
          lines={lines}
          bomLinesByStage={bomLinesByStage}
          routingByKey={routingByKey}
          setRoutingByKey={setRoutingByKey}
          isSaving={wizardRoutingMutation.isPending}
          canWrite={canWrite}
          numberFormatter={numberFormatter}
          errorMessage={wizardRoutingMutation.error?.message ?? null}
          onAddManualPicks={handleAddManualPicks}
          onRemoveLine={handleRemoveLine}
          pickBusy={mirrorPsp.isPending}
          servingsPerPack={metadata.servings_per_pack || 1}
        />
      </div>

      {/* ------------------------------------------------------------ */}
      {/* Preview tab: Stage BOMs (with terminal-stage authoritative  */}
      {/* MRPeasy-style BOM injected) + version history               */}
      {/* ------------------------------------------------------------ */}
      <div className={activeTab === "preview" ? "flex flex-col gap-10" : "hidden"}>
      <StageBomsPreview
        formulationCode={formulation.code}
        formulationName={formulation.name}
        stages={formulation.stages}
        lines={lines}
        // Inject the compute-based per-1kg breakdown into the
        // terminal stage's card. This is what BomCard has
        // always rendered — actives + all excipient bands + SKU
        // codes at their real weights (extract-ratio + purity
        // resolved). The Stage BOMs preview owns the routing
        // layout + non-terminal per-line breakdowns; the terminal
        // BOM is the finished product's authoritative recipe and
        // lives inside its card.
        terminalBom={
          <BomCard
            totals={liveTotals}
            lines={lines}
            gummyBaseItems={formulation.gummy_base_items}
            flavouringItems={formulation.flavouring_items}
            colourItems={formulation.colour_items}
            glazingItems={formulation.glazing_items}
            gellingItems={formulation.gelling_items}
            premixSweetenerItems={formulation.premix_sweetener_items}
            acidityItems={formulation.acidity_items}
            mccCarrierItemIds={metadata.mcc_carrier_item_ids}
            dcpCarrierItemIds={metadata.dcp_carrier_item_ids}
            antiCakingItemIds={metadata.anti_caking_item_ids}
            mccCarrierNames={mccCarrierNames}
            antiCakingNames={antiCakingNames}
            mccCarrierCodes={mccCarrierCodes}
            antiCakingCodes={antiCakingCodes}
            mccCarrierItems={formulation.mcc_carrier_items}
            dcpCarrierItems={formulation.dcp_carrier_items}
            antiCakingItems={formulation.anti_caking_items}
            excipientOverrides={metadata.excipient_overrides}
            formulationCode={formulation.code}
            formulationName={formulation.name}
            tFormulations={tFormulations}
          />
        }
      />

      {/* ------------------------------------------------------------ */}
      {/* Version history                                              */}
      {/* ------------------------------------------------------------ */}
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("versions.title")}
        </p>
        {versionsQuery.isLoading ? (
          <p className="mt-3 text-sm text-ink-600">
            {tCommon("states.loading")}
          </p>
        ) : versions.length === 0 ? (
          <p className="mt-3 text-sm text-ink-600">
            {tFormulations("versions.none_yet")}
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {versions.map((v) => {
              const isApproved =
                formulation.approved_version_number === v.version_number;
              return (
                <li
                  key={v.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-lg px-3 py-2 ring-1 ring-inset ${
                    isApproved
                      ? "bg-success/5 ring-success/30"
                      : "ring-ink-200"
                  }`}
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {tFormulations("versions.version_prefix")}
                      {v.version_number}
                    </span>
                    {isApproved ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success ring-1 ring-inset ring-success/30">
                        <ShieldCheck className="h-3 w-3" />
                        {tFormulations("versions.approved_badge")}
                      </span>
                    ) : null}
                    {v.label ? (
                      <span className="text-xs text-ink-600">{v.label}</span>
                    ) : null}
                    <span className="text-xs text-ink-500">
                      {dateFormatter.format(new Date(v.created_at))}
                    </span>
                  </div>
                  {canWrite ? (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleToggleApproved(v.version_number)}
                        disabled={approveMutation.isPending}
                        className={`text-xs font-medium uppercase tracking-wide hover:text-ink-1000 disabled:cursor-not-allowed disabled:opacity-50 ${
                          isApproved ? "text-success" : "text-ink-500"
                        }`}
                      >
                        {tFormulations(
                          isApproved
                            ? "versions.unapprove"
                            : "versions.approve",
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRollback(v.version_number)}
                        className="text-xs font-medium uppercase tracking-wide text-ink-500 hover:text-ink-1000"
                      >
                        {tFormulations("versions.rollback")}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      </div>
    </div>
  );
}


// Memoised: re-renders only when compliance, allergens, or hasLines
// change. Keystrokes in unrelated metadata fields no longer cascade
// through this panel.
const CompliancePanel = memo(function CompliancePanel({
  compliance,
  allergens,
  hasLines,
  tFormulations,
}: {
  compliance: ComplianceResult;
  allergens: AllergensResult;
  hasLines: boolean;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {tFormulations("compliance.title")}
      </p>
      {!hasLines ? (
        <p className="mt-4 text-sm text-ink-600">
          {tFormulations("compliance.empty_hint")}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {compliance.flags.map((flag) => (
            <li
              key={flag.key}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm font-medium text-ink-700">
                {tFormulations(
                  `compliance.flag_label.${flag.key}` as `compliance.flag_label.vegan`,
                )}
              </span>
              <ComplianceChip
                flag={flag}
                tFormulations={tFormulations}
              />
            </li>
          ))}
          {/* Allergen row — EU 1169/2011 requires explicit allergen
              disclosure on the label. Shown after the four compliance
              flags so the chip layout stays consistent; uses the
              danger palette when any source is present so it stands
              out from the neutral "Non-Organic" chip above. */}
          <li className="flex items-center justify-between gap-3 border-t border-ink-100 pt-3">
            <span className="text-sm font-medium text-ink-700">
              {tFormulations("compliance.flag_label.allergen")}
            </span>
            <AllergenChip
              allergens={allergens}
              tFormulations={tFormulations}
            />
          </li>
        </ul>
      )}
    </div>
  );
});


function AllergenChip({
  allergens,
  tFormulations,
}: {
  allergens: AllergensResult;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
  if (allergens.sources.length === 0) {
    return (
      <span className={`${base} bg-success/10 text-success ring-success/20`}>
        {tFormulations("compliance.allergen.none")}
      </span>
    );
  }
  return (
    <span
      className={`${base} bg-danger/10 text-danger ring-danger/20`}
      title={tFormulations("compliance.allergen.count", {
        count: allergens.allergenCount,
      })}
    >
      {allergens.sources.join(", ")}
    </span>
  );
}


function ComplianceChip({
  flag,
  tFormulations,
}: {
  flag: ComplianceFlagResult;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
  let classes: string;
  let label: string;
  if (flag.status === true) {
    classes = `${base} bg-success/10 text-success ring-success/20`;
    label = tFormulations("compliance.status.yes", { label: flag.label });
  } else if (flag.status === false) {
    classes = `${base} bg-danger/10 text-danger ring-danger/20`;
    label = tFormulations("compliance.status.no", {
      label: flag.label,
      count: flag.nonCompliantCount,
    });
  } else {
    classes = `${base} bg-ink-100 text-ink-500 ring-ink-200`;
    label = tFormulations("compliance.status.unknown", {
      label: flag.label,
    });
  }
  return (
    <span
      className={classes}
      title={
        flag.unknownCount > 0
          ? tFormulations("compliance.unknown_tooltip", {
              count: flag.unknownCount,
            })
          : undefined
      }
    >
      {label}
    </span>
  );
}


// Memoised: declaration + allergens are already derived via useMemo
// in the parent, so this panel only re-paints when those inputs
// actually change.
const DeclarationPanel = memo(function DeclarationPanel({
  declaration,
  allergens,
  hasLines,
  tFormulations,
}: {
  declaration: IngredientDeclaration;
  allergens: AllergensResult;
  hasLines: boolean;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  // ``declaration.text`` carries ``<b>`` tags around allergens
  // inside grouped brackets so the spec-sheet HTML render bolds
  // them. The copy-to-clipboard path strips the markup so an
  // external paste lands as plain text.
  const copyable = declaration.text;
  const plainCopy = copyable
    ? copyable.replace(/<\/?b>/gi, "")
    : "";
  const handleCopy = async () => {
    if (!plainCopy) return;
    // Plain-text copy — when the scientist pastes into an external
    // system, they usually want the comma-joined string without
    // HTML markup. Bold-formatting is a visual convenience for the
    // on-screen preview.
    try {
      await navigator.clipboard.writeText(plainCopy);
    } catch {
      /* copy failures are visible in the browser's own UI */
    }
  };

  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("declaration.title")}
        </p>
        {copyable ? (
          <button
            type="button"
            onClick={handleCopy}
            className="text-xs font-medium uppercase tracking-wide text-ink-500 hover:text-ink-1000"
          >
            {tFormulations("declaration.copy")}
          </button>
        ) : null}
      </div>
      {!hasLines || !copyable ? (
        <p className="mt-4 text-sm text-ink-600">
          {tFormulations("declaration.empty_hint")}
        </p>
      ) : (
        <>
          {allergens.sources.length > 0 ? (
            <p className="mt-4 font-serif text-sm leading-relaxed text-ink-1000">
              <strong>{tFormulations("declaration.allergens_prefix")}:</strong>{" "}
              {allergens.sources.join(", ")}
            </p>
          ) : null}
          <p
            className="mt-2 font-serif text-sm leading-relaxed text-ink-1000"
            // Render the grouped declaration text directly — the
            // ``<b>`` tags around allergen names inside group
            // brackets ("Sweeteners (..., <b>Soy Lecithin</b>, ...)")
            // come from :func:`formatGroupedDeclaration` which mirrors
            // the server's :func:`_format_grouped_declaration` so the
            // builder preview matches the spec-sheet output verbatim.
            dangerouslySetInnerHTML={{ __html: declaration.text }}
          />
          <p className="mt-3 text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("declaration.sort_hint")}
          </p>
          <ul className="mt-4 flex flex-col gap-1 text-xs text-ink-700">
            {declaration.entries.map((entry, idx) => (
              <li
                key={`${entry.category}-${entry.label}-${idx}`}
                className="flex items-center justify-between gap-3 border-b border-ink-100 py-1 last:border-b-0"
              >
                <span className="flex items-center gap-2">
                  <CategoryBadge
                    category={entry.category}
                    tFormulations={tFormulations}
                  />
                  <span className={entry.isAllergen ? "font-semibold" : ""}>
                    {entry.label}
                  </span>
                </span>
                <span>
                  {entry.mg.toFixed(2)} <span className="text-ink-500">mg</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
});


/**
 * MRPeasy BOM card — per 1 kg of finished product.
 *
 * Mirrors the BOM scientists currently paste from
 * ``BOM Actives Calculation`` into MRPeasy. Each row is grams per
 * 1 kg of finished product (so 6% acidity → 60g/kg). Pectin Premix
 * is collapsed: the gelling agent (3%) and premix sweetener (6%)
 * combine into one in-house "Pectin Premix" line at 9% / 90g per kg
 * because procurement orders the premix as a single SKU, even
 * though the label declaration lists the components individually.
 *
 * Print stylesheet (``print:`` Tailwind variants) hides everything
 * except this card so a Cmd+P emits a clean handoff sheet.
 */
/**
 * Compact projection of the full formulation BOM for the Stages
 * tab. Same rows the Fine-tune panel edits (actives at their
 * extract-ratio-adjusted per-serving mg + every excipient band
 * split across the picked SKUs). One list per formulation — every
 * stage card renders the same list so the operator sees "the
 * whole recipe" on each stage. Sorted smallest first.
 */
type BomLine = {
  key: string;
  label: string;
  code: string;
  mg: number;
  /** Local ``catalogues.Item.id`` for the row's SKU when one is
   *  picked (and mirrored). ``null`` for compute-only placeholder
   *  rows OR for auto-picked-from-PSP rows that haven't been
   *  mirrored locally yet — those carry a raw ``pspItemUuid``
   *  instead so the server can bypass the local lookup. */
  itemId: string | null;
  /** Raw PSP item UUID for rows where NPD hasn't yet mirrored the
   *  underlying SKU into its local catalogue (e.g. an auto-picked
   *  capsule shell that the operator didn't explicitly tick). The
   *  BE ``stage_bom_overrides`` handler prefers ``item_id`` when
   *  present; falls back to this uuid otherwise. */
  pspItemUuid?: string | null;
};

function deriveStageBomLines(inputs: {
  totals: FormulationTotals;
  lines: readonly BuilderLine[];
  mccCarrierItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
  }[];
  dcpCarrierItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
  }[];
  antiCakingItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
  }[];
  /** Picked capsule-shell SKUs. Empty for non-capsule dosage forms
   *  or when the operator hasn't picked a shell yet. Each pick
   *  emits a row on the stage BOM using its ``shell_weight_mg``
   *  attribute (falls back to 1 mg so the row still shows). */
  capsuleShellItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }[];
  /** When ``capsuleShellItems`` is empty AND the formulation is a
   *  capsule, we auto-pick from PSP's shell catalog. This is the
   *  fallback candidate — the row still emits even when the
   *  operator hasn't ticked a shell explicitly, since the finished
   *  capsule cannot ship without one. Undefined for non-capsule
   *  forms. */
  autoCapsuleShell?: {
    readonly pspItemUuid: string | null;
    readonly name: string;
    readonly code: string;
    readonly shellWeightMg: number;
  } | null;
  excipientOverrides: Readonly<Record<string, number>>;
  /** Resolve an item id → its catalogue code + PSP mirror UUID for
   *  rows the compute emits without carrying the fields inline (gummy
   *  per-item + gummy_base branches, which get plain ``{id, label}``
   *  picks). The builder side wires this from a merged view of every
   *  server echo + ``pendingPicksCache`` so freshly-clicked picks
   *  resolve immediately. Returns ``null`` when the id is unknown —
   *  the row still renders, just without the ``MAxxxxx`` chip or the
   *  "Open on PSP" link. */
  itemLookup?: (
    itemId: string,
  ) => { code: string; pspSourceUuid: string | null } | null;
}): BomLine[] {
  const {
    totals,
    lines,
    mccCarrierItems,
    dcpCarrierItems,
    antiCakingItems,
    capsuleShellItems,
    autoCapsuleShell,
    excipientOverrides,
    itemLookup,
  } = inputs;
  const out: BomLine[] = [];
  const lookup = (id: string | null | undefined) =>
    (id && itemLookup ? itemLookup(id) : null) ?? {
      code: "",
      pspSourceUuid: null,
    };

  // Capsule shells — one row per picked shell SKU with the shell's
  // own ``shell_weight_mg`` attribute as its per-serving mg. Every
  // capsule uses one shell per serving, so quantity = weight. Rows
  // without a resolvable weight fall back to 1 mg so the SKU still
  // appears on the BOM (procurement then knows the shell is needed
  // even if the weight attribute wasn't populated on the mirror).
  if (capsuleShellItems.length > 0) {
    for (const shell of capsuleShellItems) {
      const rawWeight = shell.attributes?.["shell_weight_mg"];
      const weight =
        typeof rawWeight === "number"
          ? rawWeight
          : typeof rawWeight === "string"
            ? Number.parseFloat(rawWeight)
            : null;
      const mg = Number.isFinite(weight) && (weight as number) > 0
        ? (weight as number)
        : 1;
      out.push({
        key: `capsule-shell:${shell.id}`,
        label: shell.name,
        code: shell.internal_code || "",
        mg,
        itemId: shell.id,
      });
    }
  } else if (autoCapsuleShell && autoCapsuleShell.shellWeightMg > 0) {
    // No explicit shell pick — synthesize the auto-picked row so
    // the finished capsule's BOM still lists a shell. Weight comes
    // from PSP's catalog match (or the hardcoded per-size fallback
    // when the catalog is empty). Sent to PSP with its raw PSP uuid
    // (no local mirror row yet).
    out.push({
      key: `capsule-shell:auto`,
      label: autoCapsuleShell.name,
      code: autoCapsuleShell.code,
      mg: autoCapsuleShell.shellWeightMg,
      itemId: null,
      pspItemUuid: autoCapsuleShell.pspItemUuid,
    });
  }

  // Include every main-builder line (regardless of ``stage_id``).
  // The stage strip renders this whole list on every stage's card
  // because the operator's mental model is "the formulation has one
  // recipe; every manufacturing stage lists it in full."
  for (const line of lines) {
    const computed = totals.lineValues.get(line.key);
    // Manual picks (Routing-tab inventory picker) don't ride the
    // compute pipeline — no purity / overage / extract-ratio to
    // adjust — so ``totals.lineValues`` returns undefined or 0.
    // Fall back to the raw ``label_claim_mg`` the scientist typed
    // in the qty modal so the row stays visible in inventory + on
    // every stage card even before the first save.
    let mg = computed ?? 0;
    if (mg <= 0 && line.source_kind === "manual") {
      const raw = Number.parseFloat(line.label_claim_mg || "0");
      if (Number.isFinite(raw) && raw > 0) mg = raw;
    }
    if (mg <= 0) continue;
    out.push({
      key: `active:${line.key}`,
      label: line.item_name,
      code: line.item_internal_code || "",
      mg,
      itemId: line.item_id || null,
      pspItemUuid: line.item_psp_source_uuid ?? null,
    });
  }

  const excipients = totals.excipients;
  // Emit every excipient band split across picked SKUs — anti-
  // caking, DCP, MCC — on every stage. Matches the Fine-tune
  // panel rows so what NPD displays per stage = what the operator
  // has actually picked into the formulation.
  if (excipients) {
    const emitBand = (
      totalMg: number,
      picks: readonly {
        readonly id: string;
        readonly name: string;
        readonly internal_code: string;
      }[],
      placeholder: string,
      slugPrefix: string,
    ) => {
      // For powder/gummy the anti-caking / DCP / MCC band totals are
      // zero (the compute doses those SKUs via ``excipients.rows``
      // per-item instead). Emitting a zero-mg placeholder row here
      // would collide with the real per-item row further down and
      // show every SKU twice in the Fine-tune panel + Stage BOM.
      // Skip the whole band when the total is zero so the per-item
      // branch is the single source of truth.
      if (totalMg <= 0) return;
      const shares = allocateBandShares({
        totalMg,
        picks,
        overrides: excipientOverrides,
        placeholderName: placeholder,
      });
      for (const share of shares) {
        out.push({
          key: share.itemId ? `${slugPrefix}:${share.itemId}` : slugPrefix,
          label: share.name,
          code: share.code,
          mg: share.mg,
          itemId: share.itemId,
        });
      }
    };

    const antiCakingTotal =
      (excipients.mgStearateMg || 0) + (excipients.silicaMg || 0);
    const antiCakingPlaceholder =
      excipients.mgStearateMg && excipients.silicaMg
        ? "Magnesium Stearate + Silicon Dioxide"
        : excipients.mgStearateMg
          ? "Magnesium Stearate"
          : "Silicon Dioxide";
    emitBand(antiCakingTotal, antiCakingItems, antiCakingPlaceholder, "anticaking");
    emitBand(excipients.dcpMg || 0, dcpCarrierItems, "Dicalcium Phosphate", "dcp");
    emitBand(excipients.mccMg || 0, mccCarrierItems, "Microcrystalline Cellulose", "mcc");

    // Powder / gummy per-item rows — compute produces one entry per
    // picked SKU across the flavour-system + acidity + gelling +
    // glazing + sweetener + colour + gummy-base + carrier bands.
    // ``slug`` shape is ``<band>:<item_id>`` for real picks and
    // ``<band>`` (no colon) for synthetic placeholder rows. Emit
    // each so the routing wizard + stage BOMs list them alongside
    // the capsule/tablet bands.
    for (const row of excipients.rows ?? []) {
      if (!row || row.mg <= 0) continue;
      const [bandSlug, itemId] = row.slug.split(":");
      const meta = lookup(itemId);
      out.push({
        key: `${bandSlug}:${itemId ?? row.slug}`,
        label: row.label,
        code: meta.code,
        mg: row.mg,
        itemId: itemId || null,
        pspItemUuid: meta.pspSourceUuid,
      });
    }

    // Gummy base rows — one per picked gummy-base SKU with an equal
    // share of the total base weight. Kept separate on
    // ``gummyBaseRows`` (not on ``rows``) so the compute layer can
    // decorate them with allergen info at declaration time; here we
    // just need the per-item mg for BOM parity.
    for (const row of excipients.gummyBaseRows ?? []) {
      if (!row || row.mg <= 0) continue;
      const meta = lookup(row.itemId);
      out.push({
        key: `gummy-base:${row.itemId}`,
        label: row.label,
        code: meta.code,
        mg: row.mg,
        itemId: row.itemId,
        pspItemUuid: meta.pspSourceUuid,
      });
    }
    // Gummy base placeholder — the base is the structural bulking
    // matrix (sweeteners + bulking agents that let the gel set). If
    // the compute wants to allocate mass here but no non-water pick
    // is selected, no per-SKU row gets emitted above — the fine-
    // tune panel would then quietly skip the biggest structural
    // component of the gummy. Emit an explicit placeholder so the
    // "PICK A SKU" warning fires; the row shows the mg the compute
    // reserved and disappears the moment the scientist ticks a
    // sweetener or bulking agent.
    if (
      (excipients.gummyBaseMg ?? 0) > 0 &&
      (!excipients.gummyBaseRows || excipients.gummyBaseRows.length === 0)
    ) {
      out.push({
        key: "gummy-base",
        label: "Gummy Base",
        code: "",
        mg: excipients.gummyBaseMg ?? 0,
        itemId: null,
      });
    }

    // Water for gummies — a fixed 5.5% of the target gummy mass. If
    // one of the picked gummy_base SKUs is water/aqua, the compute
    // attached its ``waterItemId`` so procurement sees the exact SKU
    // + PSP link (and the same pick is dropped from the gummy_base
    // split so its mass isn't double-counted). Otherwise the row
    // renders as a generic synthetic entry with no itemId — the
    // scientist can go pick a water SKU to link it.
    if (excipients.waterMg && excipients.waterMg > 0) {
      const meta = lookup(excipients.waterItemId);
      out.push({
        key: excipients.waterItemId
          ? `gummy-water:${excipients.waterItemId}`
          : "gummy-water",
        label: excipients.waterLabel,
        code: meta.code,
        mg: excipients.waterMg,
        itemId: excipients.waterItemId,
        pspItemUuid: meta.pspSourceUuid,
      });
    }
  }

  out.sort((a, b) => a.mg - b.mg);
  return out;
}


// Memoised: BOM rows recompute only when totals / lines / picker
// state change. Keystrokes elsewhere (search input, metadata fields)
// no longer drive a full table re-render.
/**
 * Wizard step 3 body — split view: full ingredient inventory on the
 * left, stage cards on the right. Scientist assigns each row to a
 * stage via a dropdown; Save persists the layout to the DB (actives
 * update stage_id in place, band picks materialise as
 * source_kind='band_pick' lines). Legacy formulations open with
 * everything unassigned — Save is blocked until every row lands
 * on a stage OR is explicitly parked on "Terminal (unassigned)"
 * which the push cascade treats as "flows into the finished
 * product" for backwards compat.
 */
const RoutingTabBody = memo(function RoutingTabBody({
  orgId,
  formulation,
  lines,
  bomLinesByStage,
  routingByKey,
  setRoutingByKey,
  isSaving,
  canWrite,
  numberFormatter,
  errorMessage,
  onAddManualPicks,
  onRemoveLine,
  pickBusy,
  servingsPerPack,
}: {
  orgId: string;
  formulation: FormulationDto;
  lines: readonly BuilderLine[];
  bomLinesByStage: ReadonlyMap<string, readonly BomLine[]>;
  routingByKey: Map<string, string | null>;
  setRoutingByKey: React.Dispatch<
    React.SetStateAction<Map<string, string | null>>
  >;
  isSaving: boolean;
  canWrite: boolean;
  numberFormatter: Intl.NumberFormat;
  errorMessage: string | null;
  onAddManualPicks: (
    picks: readonly {
      readonly pspUuid: string;
      readonly qtyString: string;
    }[],
  ) => Promise<void>;
  onRemoveLine: (lineKey: string) => void;
  pickBusy: boolean;
  /** How many servings each finished pack ships with (from Setup).
   *  Drives the per-row "for N finished units, you need X g / Y kg"
   *  projection on the stage cards. */
  servingsPerPack: number;
}) {
  // Number of finished units the operator plans to make in this run.
  // Multiplied against every ingredient's per-unit mg to project the
  // total mass rendered on each stage card's row.
  const [finishedUnitsInput, setFinishedUnitsInput] = useState("1");
  const finishedUnits = Math.max(
    1,
    Number.parseInt(finishedUnitsInput || "1", 10) || 1,
  );
  const perUnitToBatch = servingsPerPack * finishedUnits;
  const stages = formulation.stages;

  // Build a de-duplicated inventory of every ingredient the
  // formulation carries. Walks the full-BOM map once (any stage's
  // list is identical after Phase 2's revert), then annotates each
  // row with its wizard routing key + whether it maps to an
  // existing FormulationLine (so we can show a chip like "on PSP").
  const inventory = useMemo(() => {
    const seen = new Set<string>();
    const rows: {
      routingKey: string;
      label: string;
      code: string;
      mg: number;
      band: "active" | string;
      itemId: string | null;
      linePresent: boolean;
    }[] = [];
    const linesByItemBand = new Map<string, BuilderLine>();
    for (const l of lines) {
      const bandKey =
        l.source_kind === "band_pick" ? l.band_key ?? "" : "active";
      linesByItemBand.set(`${bandKey}:${l.item_id}`, l);
    }
    // Prefer the first stage's rows as the canonical "one of each"
    // list — every stage's fullBom carries the same items after the
    // Phase 2 revert. Fallback to iterating every stage in case a
    // future refactor makes them diverge.
    const firstStageRows = stages[0]
      ? (bomLinesByStage.get(stages[0].id) ?? [])
      : [];
    const allSources: readonly (readonly BomLine[])[] = firstStageRows.length
      ? [firstStageRows]
      : Array.from(bomLinesByStage.values());
    for (const source of allSources) {
      for (const row of source) {
        // Skip the synthesised "prior semi" links — they're not
        // routable, they're a derived visual only.
        if (row.key.startsWith("semi:")) continue;
        const [prefix] = row.key.split(":");
        const band =
          prefix === "active"
            ? "active"
            : prefix === "anticaking"
              ? "anti_caking"
              : prefix === "mcc"
                ? "mcc"
                : prefix === "dcp"
                  ? "dcp"
                  : prefix === "capsule-shell"
                    ? "capsule_shell"
                    : prefix ?? "";
        const routingKey =
          band === "active"
            ? `active:${row.key.slice("active:".length)}`
            : `band:${band}:${row.itemId ?? ""}`;
        if (seen.has(routingKey)) continue;
        seen.add(routingKey);
        const linePresent =
          band === "active"
            ? Boolean(row.itemId)
            : linesByItemBand.has(`${band}:${row.itemId}`);
        rows.push({
          routingKey,
          label: row.label,
          code: row.code,
          mg: row.mg,
          band,
          itemId: row.itemId ?? null,
          linePresent,
        });
      }
    }
    rows.sort((a, b) => a.mg - b.mg);
    return rows;
  }, [bomLinesByStage, lines, stages]);

  // Per-stage view — what's currently assigned to each stage.
  const rowsByStage = useMemo(() => {
    const map = new Map<string, typeof inventory>();
    for (const stage of stages) map.set(stage.id, []);
    const unassigned: typeof inventory = [];
    for (const row of inventory) {
      const stageId = routingByKey.get(row.routingKey) ?? null;
      if (stageId && map.has(stageId)) {
        map.get(stageId)!.push(row);
      } else {
        unassigned.push(row);
      }
    }
    return { map, unassigned };
  }, [inventory, routingByKey, stages]);

  const setStageForRow = useCallback(
    (routingKey: string, stageId: string | null) => {
      setRoutingByKey((prev) => {
        const next = new Map(prev);
        next.set(routingKey, stageId);
        return next;
      });
    },
    [setRoutingByKey],
  );

  // "Auto-route unassigned → terminal" was removed: routing is now
  // an explicit act the scientist performs. Silent auto-parking on
  // the terminal stage hides intent + defeats the "everything
  // unassigned by default" contract.

  const bandChip = (band: string) =>
    band === "active" ? null : (
      <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-600">
        {band.replace(/_/g, " ")}
      </span>
    );

  // ── Ingredient picker (swaps in over the inventory column) ────────
  type PickerType = "all" | "raw_material" | "semi_finished" | "packaging";
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerType, setPickerType] = useState<PickerType>("all");
  const [pickerSelection, setPickerSelection] = useState<Set<string>>(
    () => new Set(),
  );
  // Confirm modal state — populated when the operator clicks
  // "Add N selected". Carries the picked PSP items + a live qty
  // draft per item so the scientist can tweak values before commit.
  const [qtyModal, setQtyModal] = useState<
    | {
        readonly picks: readonly PspItemDto[];
        readonly qtyDraft: Record<string, string>;
      }
    | null
  >(null);

  const closePicker = () => {
    setPickerOpen(false);
    setPickerSelection(new Set());
    setPickerSearch("");
  };
  const togglePickerSelection = (uuid: string) => {
    setPickerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  // Item-type map for the picker's chip filter. ``raw_material`` is
  // PSP's stock key for consumables the operator draws off shelves
  // (actives + excipients); ``packaging`` is a distinct type on PSP;
  // ``semi_finished`` covers intermediates + the terminal finished
  // product would be filtered out downstream (a scientist picking a
  // finished product into a formulation is almost always a mistake).
  const pspItemsQuery = usePspItems(orgId, {
    enabled: pickerOpen,
    search: pickerSearch.trim(),
    itemTypes:
      pickerType === "all"
        ? ["raw_material", "semi_finished", "packaging"]
        : [pickerType],
  });
  const pspItems = pspItemsQuery.data?.items ?? [];

  // Stage outputs — semi-finished items produced by earlier stages of
  // THIS formulation, so the scientist can grab the Blending output
  // when routing Encapsulation in one click. Excludes the terminal
  // (a stage doesn't consume its own output) and unpushed stages
  // (which don't have a PSP uuid yet).
  const stageOutputs = useMemo(() => {
    return stages
      .slice(0, -1)
      .map((stage) => ({
        stage,
        uuid: stage.psp_semi_finished_uuid ?? null,
      }))
      .filter(
        (x): x is { stage: (typeof stages)[number]; uuid: string } =>
          Boolean(x.uuid),
      );
  }, [stages]);
  const stageOutputUuids = useMemo(
    () => new Set(stageOutputs.map((o) => o.uuid)),
    [stageOutputs],
  );

  // Split PSP results into pinned stage-outputs + everything else.
  const pinnedResults = pspItems.filter((it) =>
    stageOutputUuids.has(it.uuid),
  );
  const otherResults = pspItems.filter(
    (it) => !stageOutputUuids.has(it.uuid),
  );

  // Already-in-inventory dedup so the picker greys out items that
  // the formulation already carries (via lines OR band picks).
  const alreadyPickedPspUuids = useMemo(() => {
    const set = new Set<string>();
    for (const line of lines) {
      const attrs = line.item_attributes as
        | Record<string, unknown>
        | null
        | undefined;
      const uuid =
        attrs && typeof attrs["psp_source_uuid"] === "string"
          ? (attrs["psp_source_uuid"] as string)
          : "";
      if (uuid) set.add(uuid);
    }
    return set;
  }, [lines]);

  const openQtyModal = () => {
    const picks = pspItems.filter((it) => pickerSelection.has(it.uuid));
    if (picks.length === 0) return;
    const qtyDraft: Record<string, string> = {};
    for (const p of picks) qtyDraft[p.uuid] = "1";
    setQtyModal({ picks, qtyDraft });
  };
  const confirmQtyModal = async () => {
    if (!qtyModal) return;
    const payload = qtyModal.picks.map((p) => ({
      pspUuid: p.uuid,
      qtyString: qtyModal.qtyDraft[p.uuid] ?? "1",
    }));
    setQtyModal(null);
    closePicker();
    await onAddManualPicks(payload);
  };

  // Look up a native unit label for a PSP item. Prefers a
  // ``unit`` attribute the mirror surfaces; falls back to a plain
  // ``"unit"`` label so the qty modal always renders something.
  const pspUnitLabel = (item: PspItemDto): string => {
    const attrs = item.attributes as Record<string, unknown>;
    const raw = attrs?.["unit"];
    if (typeof raw === "string" && raw.trim() !== "") return raw;
    return "unit";
  };

  const typeChipLabel = (itemType: string): string =>
    itemType === "raw_material"
      ? "Raw"
      : itemType === "semi_finished"
        ? "Semi"
        : itemType === "packaging"
          ? "Packaging"
          : itemType === "finished_product"
            ? "Finished"
            : itemType;

  // Only Routing-tab manual picks are removable inline. Actives
  // stay managed on Formulation; band picks stay managed on the
  // M2M pickers upstream. Both paths already have their own
  // remove affordances, so exposing × on those here would just
  // create parallel truth.
  const lineKeyByRoutingKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const line of lines) {
      if (line.source_kind !== "manual") continue;
      map.set(`active:${line.key}`, line.key);
    }
    return map;
  }, [lines]);

  // ── Bulk selection on the inventory list ────────────────────────
  // Scientists can tick many rows at once and assign them to a stage
  // in a single click. The per-row stage dropdown still works for
  // one-offs; the bulk bar only appears when at least one row is
  // ticked. Selection is transient — cleared on assign, on clear-all,
  // and whenever the inventory shape changes underneath (line
  // removal, save round-trip).
  const [invSelection, setInvSelection] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkStageId, setBulkStageId] = useState<string>("");
  const toggleInvSelection = useCallback((routingKey: string) => {
    setInvSelection((prev) => {
      const next = new Set(prev);
      if (next.has(routingKey)) next.delete(routingKey);
      else next.add(routingKey);
      return next;
    });
  }, []);
  const clearInvSelection = useCallback(
    () => setInvSelection(new Set()),
    [],
  );
  // Prune stale keys whenever inventory changes so a delete /
  // save-round-trip doesn't leave orphan checked keys pointing at
  // rows that no longer exist.
  useEffect(() => {
    setInvSelection((prev) => {
      if (prev.size === 0) return prev;
      const validKeys = new Set(inventory.map((r) => r.routingKey));
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (validKeys.has(k)) next.add(k);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [inventory]);
  const allSelected =
    inventory.length > 0 && invSelection.size === inventory.length;
  const toggleSelectAll = useCallback(() => {
    setInvSelection((prev) =>
      prev.size === inventory.length
        ? new Set()
        : new Set(inventory.map((r) => r.routingKey)),
    );
  }, [inventory]);
  const applyBulkAssign = useCallback(() => {
    if (invSelection.size === 0) return;
    const target = bulkStageId || null;
    setRoutingByKey((prev) => {
      const next = new Map(prev);
      for (const key of invSelection) next.set(key, target);
      return next;
    });
    clearInvSelection();
  }, [invSelection, bulkStageId, setRoutingByKey, clearInvSelection]);

  if (stages.length === 0) {
    return (
      <section className="rounded-2xl bg-ink-0 p-8 shadow-sm ring-1 ring-ink-200">
        <p className="text-sm text-ink-600">
          Add manufacturing stages on the <strong>Stages</strong> tab
          before routing ingredients — the routing wizard needs at
          least one stage to assign items to.
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Wizard · Step 3 · Routing
            </p>
            <h2 className="mt-1 text-lg font-semibold text-ink-1000">
              Assign each ingredient to a manufacturing stage
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-ink-600">
              Left: everything the formulation carries. Right: each
              stage&apos;s Consumes list + the SKU it produces. Every
              stage&apos;s output feeds the next stage automatically
              — you only route the raw ingredients here. Changes ride
              along with <strong>Save draft</strong> /{" "}
              <strong>Save version</strong> above.
            </p>
          </div>
          {/* Finished-units input — drives the per-row projections
              (mg / unit + g total + kg total) rendered inside every
              stage card below. Purely a visualisation input; nothing
              is persisted. */}
          <div className="shrink-0 rounded-xl bg-ink-50 px-3 py-2 ring-1 ring-inset ring-ink-200">
            <label className="block text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              Finished units to make
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                value={finishedUnitsInput}
                onChange={(e) => setFinishedUnitsInput(e.target.value)}
                onBlur={() => {
                  const parsed = Number.parseInt(finishedUnitsInput || "1", 10);
                  setFinishedUnitsInput(
                    Number.isFinite(parsed) && parsed >= 1
                      ? String(parsed)
                      : "1",
                  );
                }}
                className="w-28 rounded-md bg-ink-0 px-2 py-1 text-right text-sm ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
              />
              <span className="text-[11px] text-ink-500">
                × {numberFormatter.format(servingsPerPack)} servings
              </span>
            </div>
          </div>
        </div>
        {errorMessage ? (
          <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20">
            {errorMessage}
          </p>
        ) : null}
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]">
        {/* ────────── Inventory column ────────── */}
        <div className="rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
          {pickerOpen ? (
            <RoutingInventoryPicker
              search={pickerSearch}
              onSearchChange={setPickerSearch}
              pickerType={pickerType}
              onPickerTypeChange={setPickerType}
              pinnedResults={pinnedResults}
              otherResults={otherResults}
              stageOutputUuids={stageOutputUuids}
              alreadyPickedPspUuids={alreadyPickedPspUuids}
              selection={pickerSelection}
              onToggle={togglePickerSelection}
              isLoading={pspItemsQuery.isFetching}
              onCancel={closePicker}
              onNext={openQtyModal}
              typeChipLabel={typeChipLabel}
              canWrite={canWrite}
              pickBusy={pickBusy}
            />
          ) : (
            <>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                    Ingredient inventory · {inventory.length}
                  </p>
                  <p className="mt-1 text-xs text-ink-500">
                    Every SKU the formulation ships. Change the stage
                    on any row to move it.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  disabled={!canWrite || isSaving || pickBusy}
                  className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span aria-hidden>+</span>
                  Add ingredient
                </button>
              </div>
              {/* Bulk action bar — only mounts when a row is ticked
                  so it doesn't nag the operator on the common
                  single-row assignment path. */}
              {invSelection.size > 0 ? (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-orange-50 p-2 ring-1 ring-inset ring-orange-200">
                  <span className="text-xs font-semibold text-orange-800">
                    {invSelection.size} selected
                  </span>
                  <div className="flex items-center gap-2">
                    <select
                      value={bulkStageId}
                      onChange={(e) => setBulkStageId(e.target.value)}
                      disabled={!canWrite || isSaving}
                      className="rounded-md bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-50"
                    >
                      <option value="">Assign to…</option>
                      <option value="__unassigned__">Unassign</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          Stage {s.sort_order + 1} · {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        if (bulkStageId === "__unassigned__") {
                          setRoutingByKey((prev) => {
                            const next = new Map(prev);
                            for (const key of invSelection)
                              next.set(key, null);
                            return next;
                          });
                          clearInvSelection();
                          return;
                        }
                        applyBulkAssign();
                      }}
                      disabled={
                        !canWrite || isSaving || bulkStageId === ""
                      }
                      className="rounded-md bg-orange-500 px-3 py-1 text-xs font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      onClick={clearInvSelection}
                      className="rounded-md px-2 py-1 text-xs text-orange-800 hover:bg-orange-100"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              ) : null}
              {inventory.length > 0 ? (
                <label className="mt-3 flex cursor-pointer items-center gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-ink-500 hover:text-ink-1000">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={!canWrite || isSaving}
                    className="h-3.5 w-3.5 accent-orange-500"
                    aria-label="Select all"
                  />
                  Select all
                </label>
              ) : null}
              <ul className="mt-2 flex flex-col gap-1">
                {inventory.length === 0 ? (
                  <li className="rounded-lg bg-ink-50 px-3 py-4 text-center text-xs text-ink-500">
                    No ingredients yet. Click <strong>+ Add ingredient</strong>{" "}
                    to pick from PSP.
                  </li>
                ) : (
                  inventory.map((row) => {
                    const assigned = routingByKey.get(row.routingKey) ?? null;
                    const lineKey = lineKeyByRoutingKey.get(row.routingKey);
                    const canRemove = Boolean(lineKey) && canWrite;
                    const isChecked = invSelection.has(row.routingKey);
                    return (
                      <li
                        key={row.routingKey}
                        className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm ${
                          isChecked
                            ? "border-orange-400 bg-orange-50/70"
                            : assigned
                              ? "border-ink-200 bg-ink-0"
                              : "border-orange-300 bg-orange-50/50"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() =>
                              toggleInvSelection(row.routingKey)
                            }
                            disabled={!canWrite || isSaving}
                            className="h-4 w-4 shrink-0 accent-orange-500"
                            aria-label={`Select ${row.label}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              {bandChip(row.band)}
                              <span className="truncate font-medium text-ink-1000">
                                {row.label}
                              </span>
                            </div>
                            <span className="mt-0.5 block text-[11px] text-ink-500">
                              {row.code || "—"} ·{" "}
                              {numberFormatter.format(row.mg)} mg
                            </span>
                          </div>
                          <select
                            value={assigned ?? ""}
                            onChange={(e) =>
                              setStageForRow(
                                row.routingKey,
                                e.target.value || null,
                              )
                            }
                            disabled={!canWrite || isSaving}
                            className="min-w-[140px] rounded-md bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-50"
                          >
                            <option value="">Unassigned</option>
                            {stages.map((s) => (
                              <option key={s.id} value={s.id}>
                                Stage {s.sort_order + 1} · {s.name}
                              </option>
                            ))}
                          </select>
                          {canRemove ? (
                            <button
                              type="button"
                              onClick={() => onRemoveLine(lineKey!)}
                              disabled={isSaving}
                              className="rounded-md p-1 text-ink-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                              aria-label={`Remove ${row.label}`}
                              title="Remove from formulation"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          )}
        </div>

        {/* ────────── Stage cards column ────────── */}
        <div className="flex flex-col gap-4">
          {rowsByStage.unassigned.length > 0 ? (
            <div className="rounded-2xl bg-orange-50/70 p-4 ring-1 ring-inset ring-orange-200">
              <p className="text-xs font-semibold uppercase tracking-wide text-orange-800">
                {rowsByStage.unassigned.length} unassigned ·
                won&apos;t ship on any stage&apos;s BOM
              </p>
              <p className="mt-1 text-xs text-orange-700">
                Assign each one to a stage below. Every ingredient
                needs a home before the finished product can ship.
              </p>
            </div>
          ) : null}
          {stages.map((stage) => {
            const rows = rowsByStage.map.get(stage.id) ?? [];
            const isFinished = stage.psp_item_type === "finished_product";
            return (
              <div
                key={stage.id}
                className={`rounded-2xl border-2 bg-ink-0 p-5 shadow-sm ${
                  isFinished
                    ? "border-orange-300"
                    : "border-ink-200"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                      Stage {stage.sort_order + 1} ·{" "}
                      {isFinished ? "Finished product" : "Semi-finished"}
                    </p>
                    <h3 className="mt-0.5 text-base font-semibold text-ink-1000">
                      {stage.name || "Untitled stage"}
                    </h3>
                  </div>
                  <span className="text-xs font-medium text-ink-500">
                    Produces →{" "}
                    <span className="text-ink-1000">
                      {stage.psp_item_name ||
                        (isFinished ? "Finished product" : "Semi output")}
                    </span>
                  </span>
                </div>

                {/* Every quantity below is normalised to ONE unit of
                    what this stage produces — not per batch, not per
                    500 caps. Prevents the "wait, is this per bottle
                    or per pack?" confusion at handoff. */}
                <p className="mt-2 inline-flex items-center gap-1 rounded-full bg-ink-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600 ring-1 ring-inset ring-ink-200">
                  Per 1 ×{" "}
                  <span className="text-ink-1000">
                    {stage.psp_item_name ||
                      (isFinished ? "finished product" : "semi output")}
                  </span>
                </p>

                <ul className="mt-3 flex flex-col gap-1 text-sm">
                  {rows.length === 0 ? (
                    <li className="rounded-lg border border-dashed border-ink-200 px-3 py-4 text-center text-xs text-ink-500">
                      No ingredients routed here yet — pick a row on
                      the left and set its stage to{" "}
                      &quot;{stage.name || "this stage"}&quot;.
                    </li>
                  ) : (
                    rows.map((row) => {
                      const totalMg = row.mg * perUnitToBatch;
                      const totalG = totalMg / 1000;
                      const totalKg = totalG / 1000;
                      return (
                        <li
                          key={row.routingKey}
                          className="flex items-center justify-between gap-2 rounded-lg border border-ink-100 px-3 py-2 text-xs"
                        >
                          <span className="flex items-center gap-2">
                            {bandChip(row.band)}
                            <span className="font-medium text-ink-1000">
                              {row.label}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-baseline gap-3 text-right tabular-nums">
                            <span className="text-ink-500">
                              {numberFormatter.format(
                                Number(row.mg.toFixed(2)),
                              )}{" "}
                              mg / unit
                            </span>
                            <span className="text-ink-1000">
                              {numberFormatter.format(
                                Number(totalG.toFixed(3)),
                              )}{" "}
                              g
                            </span>
                            <span className="text-ink-700">
                              {numberFormatter.format(
                                Number(totalKg.toFixed(4)),
                              )}{" "}
                              kg
                            </span>
                          </span>
                        </li>
                      );
                    })
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </section>

      {qtyModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setQtyModal(null)}
        >
          <div
            className="w-full max-w-xl rounded-2xl bg-ink-0 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Confirm quantities
            </p>
            <h3 className="mt-1 text-base font-semibold text-ink-1000">
              How much of each to add?
            </h3>
            <p className="mt-1 text-xs text-ink-500">
              Enter the qty in each item&apos;s native unit. Everything
              is per 1 unit of what the stage produces. You can refine
              on the Formulation tab.
            </p>
            <ul className="mt-4 divide-y divide-ink-100 rounded-xl ring-1 ring-ink-200">
              {qtyModal.picks.map((pick) => (
                <li
                  key={pick.uuid}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink-1000">
                      {pick.name}
                    </p>
                    <p className="text-[11px] text-ink-500">
                      {pick.code || "—"} · {typeChipLabel(pick.item_type)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={qtyModal.qtyDraft[pick.uuid] ?? "1"}
                      onChange={(e) =>
                        setQtyModal((prev) =>
                          prev
                            ? {
                                ...prev,
                                qtyDraft: {
                                  ...prev.qtyDraft,
                                  [pick.uuid]: e.target.value,
                                },
                              }
                            : prev,
                        )
                      }
                      className="w-20 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <span className="text-[11px] text-ink-500">
                      {pspUnitLabel(pick)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setQtyModal(null)}
                disabled={pickBusy}
                className="rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmQtyModal}
                disabled={pickBusy || !canWrite}
                className="rounded-lg bg-orange-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pickBusy
                  ? "Adding…"
                  : `Add ${qtyModal.picks.length} to inventory`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
});

/**
 * PSP catalog picker embedded in the Routing tab's inventory column.
 * Search + item-type filter chips + a pinned "Stage outputs" band at
 * the top for the semi-finished items produced by earlier stages of
 * this formulation. Multi-select via checkboxes; the parent then
 * opens a qty-confirm modal on ``onNext``.
 */
function RoutingInventoryPicker({
  search,
  onSearchChange,
  pickerType,
  onPickerTypeChange,
  pinnedResults,
  otherResults,
  stageOutputUuids,
  alreadyPickedPspUuids,
  selection,
  onToggle,
  isLoading,
  onCancel,
  onNext,
  typeChipLabel,
  canWrite,
  pickBusy,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  pickerType: "all" | "raw_material" | "semi_finished" | "packaging";
  onPickerTypeChange: (
    t: "all" | "raw_material" | "semi_finished" | "packaging",
  ) => void;
  pinnedResults: readonly PspItemDto[];
  otherResults: readonly PspItemDto[];
  stageOutputUuids: ReadonlySet<string>;
  alreadyPickedPspUuids: ReadonlySet<string>;
  selection: ReadonlySet<string>;
  onToggle: (uuid: string) => void;
  isLoading: boolean;
  onCancel: () => void;
  onNext: () => void;
  typeChipLabel: (itemType: string) => string;
  canWrite: boolean;
  pickBusy: boolean;
}) {
  const chips: {
    key: "all" | "raw_material" | "semi_finished" | "packaging";
    label: string;
  }[] = [
    { key: "all", label: "All" },
    { key: "raw_material", label: "Raw" },
    { key: "semi_finished", label: "Semi" },
    { key: "packaging", label: "Packaging" },
  ];

  const renderRow = (item: PspItemDto) => {
    const isSelected = selection.has(item.uuid);
    const isAlready = alreadyPickedPspUuids.has(item.uuid);
    const isStageOutput = stageOutputUuids.has(item.uuid);
    return (
      <li
        key={item.uuid}
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
          isSelected
            ? "border-orange-400 bg-orange-50/50"
            : isStageOutput
              ? "border-orange-200 bg-orange-50/20"
              : "border-ink-200 bg-ink-0"
        } ${isAlready ? "opacity-40" : ""}`}
      >
        <input
          type="checkbox"
          checked={isSelected}
          disabled={!canWrite || isAlready}
          onChange={() => onToggle(item.uuid)}
          className="h-4 w-4 shrink-0 accent-orange-500"
          aria-label={`Select ${item.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-600">
              {typeChipLabel(item.item_type)}
            </span>
            <span className="truncate font-medium text-ink-1000">
              {item.name}
            </span>
            {isAlready ? (
              <span className="text-[10px] uppercase text-ink-500">
                already added
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-[11px] text-ink-500">
            {item.code || item.external_sku || "—"}
          </p>
        </div>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Pick from PSP
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Raw materials, semi-finished, and packaging. Multi-select
            then set quantities.
          </p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
          aria-label="Back to inventory"
          title="Back to inventory"
        >
          ×
        </button>
      </div>
      <input
        type="text"
        placeholder="Search by name or code…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
      />
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onPickerTypeChange(c.key)}
            className={
              pickerType === c.key
                ? "rounded-full bg-orange-500 px-3 py-1 text-xs font-medium text-white"
                : "rounded-full bg-ink-100 px-3 py-1 text-xs font-medium text-ink-700 hover:bg-ink-200"
            }
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="max-h-[520px] overflow-y-auto">
        {pinnedResults.length > 0 ? (
          <div className="mb-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-orange-700">
              Stage outputs
            </p>
            <ul className="flex flex-col gap-1">
              {pinnedResults.map(renderRow)}
            </ul>
          </div>
        ) : null}
        {isLoading && otherResults.length === 0 ? (
          <p className="text-center text-xs text-ink-500">Loading…</p>
        ) : otherResults.length === 0 && pinnedResults.length === 0 ? (
          <p className="rounded-lg bg-ink-50 px-3 py-6 text-center text-xs text-ink-500">
            {search
              ? "No matches."
              : "Start typing to search PSP items."}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {otherResults.map(renderRow)}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-ink-100 pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-100"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={selection.size === 0 || pickBusy || !canWrite}
          className="rounded-lg bg-orange-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {selection.size === 0
            ? "Select items to add"
            : `Add ${selection.size} selected →`}
        </button>
      </div>
    </div>
  );
}


const BomCard = memo(function BomCard({
  totals,
  lines,
  gummyBaseItems,
  flavouringItems,
  colourItems,
  glazingItems,
  gellingItems,
  premixSweetenerItems,
  acidityItems,
  mccCarrierItemIds,
  dcpCarrierItemIds,
  antiCakingItemIds,
  mccCarrierNames,
  antiCakingNames,
  mccCarrierCodes,
  antiCakingCodes,
  mccCarrierItems,
  dcpCarrierItems,
  antiCakingItems,
  excipientOverrides,
  formulationCode,
  formulationName,
  tFormulations,
}: {
  totals: FormulationTotals;
  lines: readonly BuilderLine[];
  gummyBaseItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  flavouringItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  colourItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  glazingItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  gellingItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  premixSweetenerItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  acidityItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly ingredient_list_name: string;
  }[];
  // Excipient-band picks — feed the capsule/tablet BOM rows so
  // "Silicon Dioxide", "MCC", "DCP" show the actual picked
  // SKUs + codes instead of blank placeholders. Live names come
  // off the picker-toggled cache; server echos supply codes
  // (post-save; pre-save the code column stays empty for
  // freshly-toggled picks, which is still an upgrade over the
  // previous always-empty state).
  mccCarrierItemIds: readonly string[];
  dcpCarrierItemIds: readonly string[];
  antiCakingItemIds: readonly string[];
  mccCarrierNames: Record<string, string>;
  antiCakingNames: Record<string, string>;
  mccCarrierCodes: Record<string, string>;
  antiCakingCodes: Record<string, string>;
  mccCarrierItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
  }[];
  dcpCarrierItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
  }[];
  antiCakingItems: readonly {
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
  }[];
  /** Per-item mg overrides (``excipient_mg:<uuid>`` keys) — feed the
   *  same allocator the Ingredients tab uses, so the BOM's per-pick
   *  split matches what the scientist typed on the totals panel. */
  excipientOverrides: Readonly<Record<string, number>>;
  formulationCode: string;
  formulationName: string;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const totalWeight = totals.totalWeightMg;
  // For gummies we split the actives into their own pre-blend BOM
  // ("Active Powder") because that's how procurement actually orders
  // and how production weighs out the gummy mix — the actives are
  // pre-blended into a single powder, then dropped into the pectin
  // matrix as one ingredient. Same model as Pectin Premix (gelling +
  // premix sweetener collapsing into one BOM line).
  const isGummy = totals.dosageForm === "gummy";

  // BOM rows scaled to per-1kg. Empty / unsupported state surfaces
  // as a hint instead of an empty table.
  const rows = useMemo(() => {
    if (!totalWeight || totalWeight <= 0) return [];

    const scale = (mg: number) => (mg / totalWeight) * 1000; // → grams per kg
    const out: {
      slug: string;
      label: string;
      code: string;
      gramsPerKg: number;
      pct: number;
      // True for placeholder rows (band has no item picked) — the
      // BOM table dyes the code cell so the user sees what still
      // needs a SKU before exporting to procurement.
      missing?: boolean;
    }[] = [];

    // Build a quick lookup so we can resolve item codes for the
    // gummy excipient pick rows (slug ``flavouring:<id>`` →
    // catalogue internal_code).
    const itemLookup = new Map<
      string,
      { name: string; internal_code: string; ingredient_list_name: string }
    >();
    for (const list of [
      gummyBaseItems,
      flavouringItems,
      colourItems,
      glazingItems,
      gellingItems,
      premixSweetenerItems,
      acidityItems,
    ]) {
      for (const item of list) {
        itemLookup.set(item.id, item);
      }
    }

    // Resolve picks for the capsule/tablet excipient bands (MCC
    // carrier, DCP carrier, anti-caking). The compute layer emits
    // these as synthetic category rows ("Microcrystalline
    // Cellulose", "Silicon Dioxide", etc.) with blank codes; when
    // the scientist has actually picked SKUs we swap in the picked
    // names + concatenated codes so the BOM reads like a
    // procurement doc, not a functional summary.
    //
    // Live picks live in the ``*Names`` caches (id → name) so a
    // toggle reflects instantly. Codes come off the server echo
    // (``formulation.*_items[]``) since the picker's callback
    // doesn't currently plumb ``internal_code`` — a freshly-picked
    // pre-save row therefore shows the picked NAME with an empty
    // code, which is still a big win over the generic placeholder.
    const resolvePickedBand = (
      ids: readonly string[] | undefined,
      liveNames: Record<string, string>,
      liveCodes: Record<string, string>,
      serverItems:
        | ReadonlyArray<{
            readonly id: string;
            readonly name: string;
            readonly internal_code: string;
          }>
        | undefined,
    ): { ids: string[]; names: string[]; codes: string[] } => {
      const outIds: string[] = [];
      const names: string[] = [];
      const codes: string[] = [];
      // Legacy formulations that predate a given ``*_items`` echo
      // may hand us ``undefined`` — treat it as "no server-side
      // knowledge of these picks" and lean on the live caches.
      const items = serverItems ?? [];
      const pickedIds = ids ?? [];
      for (const id of pickedIds) {
        const server = items.find((i) => i.id === id);
        const name = liveNames[id] ?? server?.name;
        if (!name) continue;
        outIds.push(id);
        names.push(name);
        // Always push the code (or an empty string) so the arrays
        // stay index-aligned. Downstream ``emitBandRows`` iterates
        // by index; skipping empties here shifts every subsequent
        // pick's code onto the wrong row — a scientist ticks
        // Beeswax (blank code) + Brown Rice (MA201141) and Brown
        // Rice's code lands on Beeswax's row.
        const code = liveCodes[id] ?? server?.internal_code ?? "";
        codes.push(code);
      }
      return { ids: outIds, names, codes };
    };

    // 1) Actives — straight from the line list. Per-kg scaling
    //    uses each line's cached mg/serving. For gummies we collapse
    //    every active into a single "Active Powder" row (the sub-BOM
    //    rendered below breaks it back down ingredient-by-ingredient).
    if (isGummy) {
      let totalActivesMg = 0;
      for (const line of lines) {
        const mg = totals.lineValues.get(line.key);
        if (!mg || mg <= 0) continue;
        totalActivesMg += mg;
      }
      if (totalActivesMg > 0) {
        out.push({
          slug: "active_powder",
          label: "Active Powder",
          code: "",
          gramsPerKg: scale(totalActivesMg),
          pct: (totalActivesMg / totalWeight) * 100,
        });
      }
    } else {
      for (const line of lines) {
        const mg = totals.lineValues.get(line.key);
        if (!mg || mg <= 0) continue;
        out.push({
          slug: `active:${line.key}`,
          label: line.item_name,
          code: line.item_internal_code || "",
          gramsPerKg: scale(mg),
          pct: (mg / totalWeight) * 100,
        });
      }
    }

    // 2) Excipient breakdown rows (powder + gummy share this list).
    const excipients = totals.excipients;
    if (excipients) {
      // Water — gummy-only, fixed %.
      if (excipients.waterMg && excipients.waterMg > 0) {
        out.push({
          slug: "water",
          label: "Water",
          code: "",
          gramsPerKg: scale(excipients.waterMg),
          pct: (excipients.waterMg / totalWeight) * 100,
        });
      }

      // Gummy base picks — one row per pick at its share of the
      // base total. Empty pick list → a single placeholder row.
      if (excipients.gummyBaseRows.length > 0) {
        for (const r of excipients.gummyBaseRows) {
          const item = itemLookup.get(r.itemId);
          out.push({
            slug: `gummy_base:${r.itemId}`,
            label: r.label,
            code: item?.internal_code ?? "",
            gramsPerKg: scale(r.mg),
            pct: (r.mg / totalWeight) * 100,
          });
        }
      } else if (excipients.gummyBaseMg && excipients.gummyBaseMg > 0) {
        out.push({
          slug: "gummy_base",
          label: "Gummy Base",
          code: "",
          gramsPerKg: scale(excipients.gummyBaseMg),
          pct: (excipients.gummyBaseMg / totalWeight) * 100,
        });
      }

      // Per-row excipients — flavouring picks, colour picks,
      // glazing picks, gelling picks, premix sweetener picks,
      // acidity picks.
      //
      // Gelling + premix sweetener get **collapsed** into a single
      // "Pectin Premix" row before emission.
      //
      // Placeholder rows (slug without a ``<band>:<id>`` suffix)
      // still appear in the BOM so the total stays at 1 kg even
      // when picks haven't been made — they render with a
      // ``missing: true`` flag so procurement can see at a glance
      // which bands still need a SKU assigned. The user picks
      // explicit items in the builder to clear the flag.
      let pectinPremixMg = 0;
      for (const r of excipients.rows) {
        if (
          r.slug.startsWith("gelling:") ||
          r.slug === "gelling" ||
          r.slug.startsWith("premix_sweetener:") ||
          r.slug === "premix_sweetener"
        ) {
          pectinPremixMg += r.mg;
          continue;
        }
        // Resolve internal_code via the lookup when the row is
        // a per-pick entry (slug ``flavouring:<id>``). Placeholder
        // rows (no colon in slug) carry an empty code + missing flag.
        const colon = r.slug.indexOf(":");
        const idPart = colon >= 0 ? r.slug.slice(colon + 1) : "";
        const item = idPart ? itemLookup.get(idPart) : undefined;
        out.push({
          slug: r.slug,
          label: r.label,
          code: item?.internal_code ?? "",
          gramsPerKg: scale(r.mg),
          pct: (r.mg / totalWeight) * 100,
          missing: colon < 0,
        });
      }

      // Pectin Premix — combined gelling + premix sweetener line.
      // In-house blend so the BOM emits a single procurement code
      // (the recipe to mix the premix lives off-system).
      if (pectinPremixMg > 0) {
        out.push({
          slug: "pectin_premix",
          label: "Pectin Premix",
          code: "",
          gramsPerKg: scale(pectinPremixMg),
          pct: (pectinPremixMg / totalWeight) * 100,
        });
      }

      // Capsule / tablet excipients — synthetic category rows
      // enriched with the picker's actual SKU picks when present.
      // Anti-caking splits mg-stearate vs silica because the maths
      // meter them separately, but each half gets the FULL anti-
      // caking pick list attached — the operator's checkbox
      // effectively says "these are the SKUs procurement should
      // source for the anti-caking band," and both halves draw
      // from the same shopping list. The code column concatenates
      // multiple picks with " + " so a pack that runs Silicon
      // Dioxide + Magnesium Stearate reads as
      // ``MA200150 + MA200960`` in the SKU cell.
      const antiCakingPicks = resolvePickedBand(
        antiCakingItemIds,
        antiCakingNames,
        antiCakingCodes,
        antiCakingItems,
      );
      const mccCarrierPicks = resolvePickedBand(
        mccCarrierItemIds,
        mccCarrierNames,
        mccCarrierCodes,
        mccCarrierItems,
      );
      const dcpCarrierPicks = resolvePickedBand(
        dcpCarrierItemIds,
        // No live cache for DCP carrier — server echo carries
        // everything after save, and a save re-hydrates the
        // ``formulation`` prop so there's no post-save gap.
        {},
        {},
        dcpCarrierItems,
      );

      // One BOM row per pick, equal split of the band mass. Fall
      // back to the canonical placeholder row when the band has
      // no picks — procurement still sees the mass, just no SKU.
      //
      // ``pickedNames.length`` drives the divisor: 3 picks =>
      // each row gets 1/3 of the band's total mg. Codes come off
      // the parallel array so a pick with a blank ``internal_code``
      // (PSP-mirrored row lacking ``external_sku``) still gets a
      // dedicated row with an empty CODE cell.
      const emitBandRows = (opts: {
        slugPrefix: string;
        totalMg: number;
        picks: { ids: string[]; names: string[]; codes: string[] };
        placeholderLabel: string;
      }) => {
        const { slugPrefix, totalMg, picks, placeholderLabel } = opts;
        // Route through the shared allocator so per-item mg overrides
        // (``excipient_mg:<uuid>``) render the same split here as they
        // do in the Ingredients panel and stage BOM.
        const bandPicks: BandPick[] = picks.ids.map((id, i) => ({
          id,
          name: picks.names[i] ?? "",
          internal_code: picks.codes[i] ?? "",
        }));
        const shares = allocateBandShares({
          totalMg,
          picks: bandPicks,
          overrides: excipientOverrides,
          placeholderName: placeholderLabel,
        });
        for (const share of shares) {
          out.push({
            slug: share.itemId
              ? `${slugPrefix}:${share.itemId}`
              : slugPrefix,
            label: share.name,
            code: share.code,
            gramsPerKg: scale(share.mg),
            pct: (share.mg / totalWeight) * 100,
          });
        }
      };

      // Anti-caking splits stearate + silica into two math bands
      // but shares one pick list — emit the combined mass then
      // split across picks rather than keeping separate rows for
      // stearate vs silica. That collapses the "picked two items"
      // case into two clean rows instead of four confusing halves.
      const antiCakingTotalMg =
        (excipients.mgStearateMg || 0) + (excipients.silicaMg || 0);
      emitBandRows({
        slugPrefix: "anticaking",
        totalMg: antiCakingTotalMg,
        picks: antiCakingPicks,
        // With no picks, keep the historical two-row placeholder
        // (Magnesium Stearate + Silicon Dioxide) so procurement
        // sees both defaults spelled out.
        placeholderLabel:
          excipients.mgStearateMg && excipients.silicaMg
            ? "Magnesium Stearate + Silicon Dioxide"
            : excipients.mgStearateMg
              ? "Magnesium Stearate"
              : "Silicon Dioxide",
      });
      emitBandRows({
        slugPrefix: "dcp",
        totalMg: excipients.dcpMg || 0,
        picks: dcpCarrierPicks,
        placeholderLabel: "Dicalcium Phosphate",
      });
      emitBandRows({
        slugPrefix: "mcc",
        totalMg: excipients.mccMg || 0,
        picks: mccCarrierPicks,
        placeholderLabel: "Microcrystalline Cellulose",
      });
    }

    // Sort by quantity ascending — procurement reads the BOM bottom-
    // up against the in-house weigh sheet, and ramping smallest-to-
    // largest means the heaviest line (typically MCC / gummy base /
    // pectin premix) anchors the bottom of the print where it doubles
    // as a sanity check against the total.
    out.sort((a, b) => a.gramsPerKg - b.gramsPerKg);

    return out;
  }, [
    totalWeight,
    totals.excipients,
    totals.lineValues,
    lines,
    isGummy,
    gummyBaseItems,
    flavouringItems,
    colourItems,
    glazingItems,
    gellingItems,
    premixSweetenerItems,
    acidityItems,
    // Excipient-band picks — MCC carrier / DCP carrier / anti-
    // caking. Live names + ids reflect the freshly-toggled state;
    // the server echo carries the codes.
    mccCarrierItemIds,
    dcpCarrierItemIds,
    antiCakingItemIds,
    mccCarrierNames,
    antiCakingNames,
    mccCarrierCodes,
    antiCakingCodes,
    mccCarrierItems,
    dcpCarrierItems,
    antiCakingItems,
    // Per-item mg overrides — a scientist bumping one MCC pick's mg
    // needs the BOM to recompute the split.
    excipientOverrides,
  ]);

  // Sub-BOM for the Active Powder pre-blend. Only emitted on gummy
  // formulations — for capsule / tablet / powder the actives are
  // already broken down ingredient-by-ingredient in the main BOM
  // above so a separate sub-BOM would be noise.
  //
  // Scaled per-1 kg of the Active Powder blend (NOT per-1 kg of the
  // finished gummy) so production weighs the pre-blend against its
  // own total. Sum of ``kg per kg`` rows equals 1.0000 / 100 %.
  const activePowderRows = useMemo(() => {
    if (!isGummy) return [];
    let totalActivesMg = 0;
    const entries: { key: string; mg: number; name: string; code: string }[] =
      [];
    for (const line of lines) {
      const mg = totals.lineValues.get(line.key);
      if (!mg || mg <= 0) continue;
      totalActivesMg += mg;
      entries.push({
        key: line.key,
        mg,
        name: line.item_name,
        code: line.item_internal_code || "",
      });
    }
    if (totalActivesMg <= 0) return [];
    const scaleActives = (mg: number) => (mg / totalActivesMg) * 1000;
    const out = entries.map((entry) => ({
      slug: `active:${entry.key}`,
      label: entry.name,
      code: entry.code,
      gramsPerKg: scaleActives(entry.mg),
      pct: (entry.mg / totalActivesMg) * 100,
    }));
    // Same smallest-first ordering as the main BOM so the heaviest
    // active anchors the bottom of the print.
    out.sort((a, b) => a.gramsPerKg - b.gramsPerKg);
    return out;
  }, [isGummy, lines, totals.lineValues]);

  const totalGrams = rows.reduce((acc, r) => acc + r.gramsPerKg, 0);
  // Display in kilograms — procurement reads quantities for whole
  // batches in kg; grams turn into awkward four-digit numbers for
  // higher-volume excipients. Conversion is just a /1000 — the
  // underlying math stays in grams per kg of finished product.
  //
  // Trace ingredients (e.g. Chromium Picolinate dosed at micrograms
  // per kg) would round to "0.0000" at the standard four-decimal
  // precision and hide the magnitude from the procurement print.
  // When that happens we expand the precision until two significant
  // digits are visible, capped so the column never grows wider than
  // the print template tolerates.
  const formatKg = (g: number): string => {
    const kg = g / 1000;
    if (!Number.isFinite(kg) || kg === 0) return "0.0000";
    const standard = kg.toFixed(4);
    if (Number.parseFloat(standard) !== 0) return standard;
    const magnitude = Math.floor(Math.log10(Math.abs(kg)));
    const decimals = Math.min(10, Math.max(4, -magnitude + 1));
    return kg.toFixed(decimals);
  };
  const totalKg = totalGrams / 1000;

  // Localised "DD Mon YYYY" used in the print header. Deterministic
  // across server / client because we hand ``Intl.DateTimeFormat``
  // an explicit locale rather than relying on the platform default —
  // SSR / hydration would otherwise diverge.
  const printedOn = useMemo(
    () =>
      new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }).format(new Date()),
    [],
  );

  return (
    // Nested inside the terminal stage's card on the Preview tab —
    // no outer card chrome (padding/shadow/ring) so we don't stack
    // three boxes on top of each other. The ``bom-print-card`` hook
    // is preserved because the print stylesheet targets it.
    <section className="bom-print-card print:break-before-page">
      {/* Print-scoped stylesheet — hides every other DOM node so a
          Cmd+P emits ONLY the BOM card. The "visibility: hidden"
          trick keeps React's ancestor tree rendered (so descendants
          still mount) but suppresses the ink; we re-enable visibility
          on the card itself + its descendants and yank it to the
          top-left of the page so the now-invisible chrome doesn't
          leave a blank first page. */}
      <style>{`
        @media screen {
          .bom-print-card .bom-print-only { display: none !important; }
        }
        @media print {
          /* Landscape A4 by default — BOM tables read better wide,
             especially with the new Actual handwrite column on the
             right edge. Scientists can override in the browser
             dialog if they want portrait. */
          @page { size: A4 landscape; margin: 12mm 14mm; }
          html, body { background: #fff !important; color: #111 !important; }
          body * { visibility: hidden !important; }
          .bom-print-card, .bom-print-card * { visibility: visible !important; }
          .bom-print-card {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            box-shadow: none !important;
            border: none !important;
            padding: 0 !important;
            margin: 0 !important;
            font-family: "Helvetica Neue", Helvetica, Arial, sans-serif !important;
            color: #111 !important;
          }
          .bom-print-card .bom-print-hide { display: none !important; }
          .bom-print-card table { font-size: 10pt; page-break-inside: auto; }
          .bom-print-card thead { display: table-header-group; }
          .bom-print-card tr { page-break-inside: avoid; }
          .bom-print-card .bom-print-handwrite {
            border-bottom: 1px solid #555;
            height: 1.2em;
            min-width: 4em;
            display: block;
          }
          .bom-print-card .bom-print-signature {
            margin-top: 24pt;
            page-break-inside: avoid;
          }
        }
      `}</style>

      {/* Header row — just the Print button now. The parent Stage
          BOM card owns the "Bill of materials — CODE · NAME" title
          block, so repeating it here would double-print. */}
      <div className="flex items-center justify-end gap-3 bom-print-hide">
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          {tFormulations("bom.print")}
        </button>
      </div>

      {/* Print-only header. Reads as a standalone document on paper:
          formulation code + name as the title, scale basis and date
          underneath. */}
      <div className="bom-print-only border-b border-ink-300 pb-3">
        <h1 className="text-[14pt] font-semibold text-ink-1000">
          {formulationCode ? `${formulationCode} — ` : ""}
          {formulationName}
        </h1>
        <p className="mt-1 text-[10pt] text-ink-700">
          {tFormulations("bom.print_subtitle")}
        </p>
        <p className="text-[9pt] text-ink-500">
          {tFormulations("bom.print_printed_on", { date: printedOn })}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">
          {tFormulations("bom.empty_hint")}
        </p>
      ) : (
        <>
          {/* Active Powder pre-blend sub-BOM (gummies only).
              Rendered ABOVE the main BOM because pre-blends are
              what production weighs out first; the main BOM then
              consumes the finished Active Powder as a single line.
              Wrapped in an orange-tinted card so it reads visually
              as a distinct sub-document, with a matching highlight
              on the "Active Powder" row in the main BOM below so
              the connection is obvious at a glance. */}
          {activePowderRows.length > 0 ? (
            <section className="mt-6 rounded-2xl bg-orange-50/60 p-4 ring-1 ring-inset ring-orange-200 print:mt-0 print:rounded-none print:ring-0">
              <div className="bom-print-hide flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-col">
                  <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-700">
                    {tFormulations("bom.pre_blend_badge")}
                  </span>
                  <p className="mt-1 text-sm font-semibold text-ink-1000">
                    {tFormulations("bom.active_powder.title")}
                  </p>
                </div>
                <p className="max-w-md text-[11px] leading-snug text-ink-500">
                  {tFormulations("bom.active_powder.hint")}
                </p>
              </div>
              <div className="bom-print-only border-b border-ink-300 pb-3">
                <h2 className="text-[12pt] font-semibold text-ink-1000">
                  {tFormulations("bom.active_powder.title")}
                </h2>
                <p className="mt-1 text-[10pt] text-ink-700">
                  {tFormulations("bom.active_powder.print_subtitle")}
                </p>
              </div>
              <table className="mt-4 w-full text-xs">
                <thead className="border-b border-orange-200 text-ink-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                      {tFormulations("bom.col_code")}
                    </th>
                    <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                      {tFormulations("bom.col_name")}
                    </th>
                    <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                      {tFormulations("bom.col_grams")}
                    </th>
                    <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                      {tFormulations("bom.col_pct")}
                    </th>
                    <th className="bom-print-only px-2 py-2 text-right font-medium uppercase tracking-wide">
                      {tFormulations("bom.col_actual")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {activePowderRows.map((row) => (
                    <tr
                      key={row.slug}
                      className="border-b border-orange-100/70"
                    >
                      <td className="px-2 py-1.5 text-ink-700 tabular-nums">
                        {row.code || "—"}
                      </td>
                      <td className="px-2 py-1.5 text-ink-1000">{row.label}</td>
                      <td className="px-2 py-1.5 text-right text-ink-1000 tabular-nums">
                        {formatKg(row.gramsPerKg)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-ink-700 tabular-nums">
                        {row.pct.toFixed(2)}
                      </td>
                      <td className="bom-print-only px-2 py-2.5">
                        <span className="bom-print-handwrite block" />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-orange-300 font-medium">
                    <td className="px-2 py-2 text-ink-700"></td>
                    <td className="px-2 py-2 text-ink-1000">
                      {tFormulations("bom.active_powder.total")}
                    </td>
                    <td className="px-2 py-2 text-right text-ink-1000 tabular-nums">
                      {(
                        activePowderRows.reduce(
                          (acc, r) => acc + r.gramsPerKg,
                          0,
                        ) / 1000
                      ).toFixed(4)}
                    </td>
                    <td className="px-2 py-2 text-right text-ink-700 tabular-nums">
                      100.00
                    </td>
                    <td className="bom-print-only px-2 py-2">
                      <span className="bom-print-handwrite block" />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </section>
          ) : null}

          {/* Main BOM — the finished product. Always rendered last
              so the order tracks how production actually builds the
              gummy: pre-blends first (Active Powder above), final
              assembly here. Print-break before the main table keeps
              each BOM on its own page when scientists Cmd+P. */}
          <section
            className={`${
              activePowderRows.length > 0
                ? "mt-6 print:break-before-page"
                : "mt-4"
            }`}
          >
            {activePowderRows.length > 0 ? (
              <div className="bom-print-hide mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex flex-col">
                  <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-700">
                    {tFormulations("bom.main_badge")}
                  </span>
                  <p className="mt-1 text-sm font-semibold text-ink-1000">
                    {tFormulations("bom.main_title")}
                  </p>
                </div>
                <p className="max-w-md text-[11px] leading-snug text-ink-500">
                  {tFormulations("bom.main_hint")}
                </p>
              </div>
            ) : null}
            <table className="w-full text-xs">
              <thead className="border-b border-ink-200 text-ink-500">
                <tr>
                  <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                    {tFormulations("bom.col_code")}
                  </th>
                  <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                    {tFormulations("bom.col_name")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                    {tFormulations("bom.col_grams")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                    {tFormulations("bom.col_pct")}
                  </th>
                  {/* Print-only Actual column — empty cell with a
                      horizontal rule so the technician writes the
                      actual measured kg next to each line in pen. */}
                  <th className="bom-print-only px-2 py-2 text-right font-medium uppercase tracking-wide">
                    {tFormulations("bom.col_actual")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  // Highlight rows that are themselves the
                  // collapsed output of a sub-BOM (Active Powder
                  // today; Pectin Premix would fit the same model
                  // when it grows its own sub-BOM). Orange tint +
                  // pill badge anchor the visual link back to the
                  // pre-blend card above so the reader knows where
                  // the breakdown lives.
                  const fromSubBom = row.slug === "active_powder";
                  return (
                    <tr
                      key={row.slug}
                      className={`border-b border-ink-100 ${
                        fromSubBom
                          ? "bg-orange-50/70"
                          : row.missing
                            ? "bg-amber-50"
                            : ""
                      }`}
                    >
                      <td className="px-2 py-1.5 text-ink-700 tabular-nums">
                        {row.code ? (
                          row.code
                        ) : row.missing ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900">
                            {tFormulations("bom.missing")}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-ink-1000">
                        <span className="inline-flex items-center gap-2">
                          {row.label}
                          {fromSubBom ? (
                            <span className="inline-flex items-center rounded-full bg-orange-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-orange-700">
                              {tFormulations("bom.pre_blend_badge")}
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-right text-ink-1000 tabular-nums">
                        {formatKg(row.gramsPerKg)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-ink-700 tabular-nums">
                        {row.pct.toFixed(2)}
                      </td>
                      <td className="bom-print-only px-2 py-2.5">
                        <span className="bom-print-handwrite block" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ink-300 font-medium">
                  <td className="px-2 py-2 text-ink-700"></td>
                  <td className="px-2 py-2 text-ink-1000">
                    {tFormulations("bom.total")}
                  </td>
                  <td className="px-2 py-2 text-right text-ink-1000 tabular-nums">
                    {totalKg.toFixed(4)}
                  </td>
                  <td className="px-2 py-2 text-right text-ink-700 tabular-nums">
                    {totalWeight ? "100.00" : "—"}
                  </td>
                  <td className="bom-print-only px-2 py-2">
                    <span className="bom-print-handwrite block" />
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>
        </>
      )}

      {/* Print-only signature footer — three short lines at the
          bottom of the printout so the BOM can be signed and dated
          before it goes into the lab book. */}
      {rows.length > 0 ? (
        <div className="bom-print-only bom-print-signature mt-6 grid grid-cols-3 gap-6 text-[10pt] text-ink-1000">
          <div>
            <div className="text-[9pt] uppercase tracking-wide text-ink-500">
              {tFormulations("bom.print_signature_technician")}
            </div>
            <div className="mt-2 border-b border-ink-700">&nbsp;</div>
          </div>
          <div>
            <div className="text-[9pt] uppercase tracking-wide text-ink-500">
              {tFormulations("bom.print_signature_supervisor")}
            </div>
            <div className="mt-2 border-b border-ink-700">&nbsp;</div>
          </div>
          <div>
            <div className="text-[9pt] uppercase tracking-wide text-ink-500">
              {tFormulations("bom.print_signature_date")}
            </div>
            <div className="mt-2 border-b border-ink-700">&nbsp;</div>
          </div>
        </div>
      ) : null}
    </section>
  );
});


function CategoryBadge({
  category,
  tFormulations,
}: {
  category: "active" | "excipient" | "shell";
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const cls =
    category === "active"
      ? "bg-ink-100 text-ink-700 ring-ink-200"
      : "bg-ink-0 text-ink-500 ring-ink-200";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ring-1 ring-inset ${cls}`}
    >
      {tFormulations(
        `declaration.category.${category}` as `declaration.category.active`,
      )}
    </span>
  );
}


// Per-item override key prefix — ``excipient_mg:<itemId>``. Value is
// the mg that pick should carry inside its band; remaining band mass
// splits equally across un-overridden picks. Stored on
// ``metadata.excipient_overrides`` alongside band-level percentages;
// server-side ``_validate_excipient_overrides`` accepts the prefix,
// the compute layer ignores it (band totals stay computed).
const EXCIPIENT_ITEM_MG_PREFIX = "excipient_mg:";

type BandPick = {
  readonly id: string;
  readonly name: string;
  readonly internal_code: string;
};

type BandShare = {
  itemId: string | null;
  name: string;
  code: string;
  mg: number;
  overridden: boolean;
};

/**
 * Split a band total into per-item shares. Any pick with an
 * ``excipient_mg:<id>`` override in ``overrides`` takes its overridden
 * mg verbatim; the remaining mass is split equally across the picks
 * without an override. If overrides sum to more than the band total,
 * the remainder is clamped to zero (honest display — the sum reads
 * higher than the band, so the scientist sees the mismatch).
 */
function allocateBandShares(args: {
  totalMg: number;
  picks: readonly BandPick[];
  overrides: Readonly<Record<string, number>>;
  placeholderName?: string;
  placeholderCode?: string;
  /** When true, still emit one row per pick even if the band total
   *  is 0 mg. Every share.mg is 0 and every share.overridden is
   *  false. Used by the fine-tune panel where the operator needs to
   *  see the picks stay put during a temporary overflow instead of
   *  the rows vanishing. BOM / stage BOM keep the default (skip
   *  zero-mg bands so procurement doesn't print carrier rows at
   *  0 kg/kg). */
  keepZeroRows?: boolean;
}): BandShare[] {
  const {
    totalMg,
    picks,
    overrides,
    placeholderName,
    placeholderCode,
    keepZeroRows,
  } = args;
  if (totalMg <= 0 && !keepZeroRows) return [];
  if (picks.length === 0) {
    return [
      {
        itemId: null,
        name: placeholderName ?? "",
        code: placeholderCode ?? "",
        mg: totalMg,
        overridden: false,
      },
    ];
  }
  let overriddenSum = 0;
  const overrideMg = new Map<string, number>();
  for (const p of picks) {
    const raw = overrides[`${EXCIPIENT_ITEM_MG_PREFIX}${p.id}`];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      overrideMg.set(p.id, raw);
      overriddenSum += raw;
    }
  }
  const remaining = Math.max(0, totalMg - overriddenSum);
  const nonOverriddenCount = picks.length - overrideMg.size;
  const perOther = nonOverriddenCount > 0 ? remaining / nonOverriddenCount : 0;
  return picks.map((p) => {
    const ov = overrideMg.get(p.id);
    return {
      itemId: p.id,
      name: p.name,
      code: p.internal_code || "",
      mg: ov !== undefined ? ov : perOther,
      overridden: ov !== undefined,
    };
  });
}

// Renders one excipient band (anti-caking / DCP / MCC) as a compact
// read-only summary in the right-hand totals column: a small group
// header (label + band total) with one row per picked SKU showing
// mg + %. Editing lives in the wider ``ExcipientFineTunePanel`` below
// the builder — the sidebar column is too narrow (~180 px) to fit
// two inputs next to a wrapping ingredient name.
function renderExcipientBand(args: {
  totalMg: number;
  picks: readonly BandPick[];
  groupLabel: string;
  totalWeightMg: number | null;
  overrides: Readonly<Record<string, number>>;
  format: (value: number | null | undefined) => string;
  percentOf: (part: number, whole: number) => string;
}) {
  const {
    totalMg,
    picks,
    groupLabel,
    totalWeightMg,
    overrides,
    format,
    percentOf,
  } = args;
  const showPct = totalWeightMg !== null && totalWeightMg > 0;
  if (picks.length === 0) {
    return (
      <li className="flex items-baseline justify-between gap-3">
        <span className="break-words">{groupLabel}</span>
        <span className="shrink-0 whitespace-nowrap tabular-nums">
          {format(totalMg)} mg
          {showPct ? (
            <span className="ml-1 text-ink-500">
              ({percentOf(totalMg, totalWeightMg!)}%)
            </span>
          ) : null}
        </span>
      </li>
    );
  }
  const shares = allocateBandShares({ totalMg, picks, overrides });
  return (
    <>
      <li className="flex items-baseline justify-between gap-3 text-ink-500">
        <span className="break-words text-[11px] font-medium uppercase tracking-wide">
          {groupLabel}
        </span>
        <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums">
          {format(totalMg)} mg
          {showPct ? (
            <span className="ml-1">
              ({percentOf(totalMg, totalWeightMg!)}%)
            </span>
          ) : null}
        </span>
      </li>
      {shares.map((share, idx) => (
        <li
          key={`${groupLabel}-${share.itemId ?? `placeholder-${idx}`}`}
          className={`flex items-baseline justify-between gap-3 pl-3 ${
            share.overridden ? "text-brand-700" : ""
          }`}
        >
          <span className="min-w-0 break-words">{share.name}</span>
          <span className="shrink-0 whitespace-nowrap tabular-nums">
            {format(share.mg)} mg
            {showPct ? (
              <span className="ml-1 text-ink-500">
                ({percentOf(share.mg, totalWeightMg!)}%)
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </>
  );
}

/**
 * Wide surface for editing per-SKU excipient shares. Sits below the
 * ingredient builder on the Ingredients tab, before Compliance. Each
 * band (Anti-caking / Carrier / DCP) renders as a group of rows with
 * mg + % inputs. Editing either input persists as
 * ``excipient_mg:<uuid>`` on the formulation's ``excipient_overrides``
 * dict; the shared ``allocateBandShares`` allocator reads it back
 * everywhere else (sidebar summary, per-stage BOM, spec sheet).
 *
 * Only mounts when at least one band has both a positive total mg
 * AND picks — otherwise there's nothing meaningful to tune and
 * showing an empty card is just noise.
 */
type FineTuneBand = {
  key: string;
  label: string;
  totalMg: number;
  picks: readonly BandPick[];
};

type FineTuneActiveRow = {
  key: string;
  name: string;
  /** Local catalogue SKU / PSP system code (``MAxxxxxx``). Rendered
   *  as a muted chip next to the name so the operator can spot the
   *  ingredient by procurement code as well as its label copy. */
  code: string;
  /** PSP UUID for the mirrored SKU driving the "Open on PSP" deep
   *  link on the ingredient name. ``null`` for local-only lines. */
  pspSourceUuid: string | null;
  nominalMg: number;
  /** Last-saved ``label_claim_mg`` for this line. When the current
   *  ``nominalMg`` differs, the row shows a per-row ↺ that writes
   *  ``savedMg`` back through ``onActiveMgChange``. ``null`` when
   *  the line is brand-new (has no server-side baseline yet). */
  savedMg: number | null;
};

/**
 * Ingredient-name cell shared by every fine-tune row. Renders the SKU
 * name as an "Open on PSP" link when a ``pspSourceUuid`` + base URL
 * are both available, and surfaces the catalogue ``code`` (``MA00295``)
 * as a muted chip next to it so operators can spot the row by
 * procurement code as well as by label copy.
 *
 * The whole cell is deliberately in a single wrapper so hover +
 * click-through behave predictably: hovering the name shows the link
 * affordance without expanding the row, and mid-word click on the
 * code chip drops the operator on the PSP item page too.
 */
function IngredientNameCell({
  name,
  code,
  pspSourceUuid,
  pspBaseUrl,
  extra,
}: {
  name: string;
  code?: string;
  pspSourceUuid?: string | null;
  pspBaseUrl?: string | null;
  /** Optional trailing chip content — e.g. the fine-tune extra row's
   *  "NOT DOSED / MISSING PSP RATE" warning. Rendered below the name
   *  row so it flows regardless of link vs plain text state. */
  extra?: React.ReactNode;
}) {
  const canLink = Boolean(pspBaseUrl && pspSourceUuid);
  const href = canLink
    ? `${pspBaseUrl}/production/items/${pspSourceUuid}`
    : null;
  const nameCls =
    "min-w-0 break-words text-ink-800 hover:text-brand-700 hover:underline underline-offset-2";
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-1.5">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className={nameCls}
            title={`Open ${name} on PSP`}
          >
            {name}
          </a>
        ) : (
          <span className="min-w-0 break-words text-ink-800" title={name}>
            {name}
          </span>
        )}
        {code ? (
          <span
            className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-tight text-ink-600"
            title={`Catalogue code: ${code}`}
          >
            {code}
          </span>
        ) : null}
      </span>
      {extra ? <div>{extra}</div> : null}
    </div>
  );
}


const ExcipientFineTunePanel = memo(function ExcipientFineTunePanel({
  totalWeightMg,
  activeLines,
  onActiveMgChange,
  bands,
  overrides,
  onChange,
  canEdit,
  dirty,
  onRevertAllUnsaved,
  extraRows,
  pspBaseUrl,
  productName,
  productCode,
  numberFormatter,
  tFormulations,
}: {
  totalWeightMg: number | null;
  /** Actives — each line as its own row, showing the scientist's
   *  ``label_claim_mg`` (nominal target). Editing this row edits the
   *  same field the main line editor drives. */
  activeLines: readonly FineTuneActiveRow[];
  onActiveMgChange: ((lineKey: string, mg: string) => void) | null;
  bands: readonly FineTuneBand[];
  overrides: Readonly<Record<string, number>>;
  onChange: ((next: Record<string, number>) => void) | null;
  canEdit: boolean;
  /** Any un-saved metadata or line edits exist. Drives the visibility
   *  of the header-level "Revert unsaved changes" button. */
  dirty: boolean;
  onRevertAllUnsaved: (() => void) | null;
  /** Extra rows appended below the active + band rows so items
   *  that aren't part of the editable ``bands`` list still show up
   *  as part of the "BOM view" the scientist reads here. When
   *  ``itemId`` is set the row becomes editable — the scientist can
   *  type an mg value that lands in ``overrides`` under
   *  ``excipient_mg:<itemId>`` (same key the capsule bands use),
   *  which the compute honours as an absolute mg override. When
   *  ``itemId`` is missing (e.g. auto-picked capsule shell) the
   *  row stays read-only. */
  extraRows?: readonly {
    readonly key: string;
    readonly label: string;
    /** Local catalogue SKU / PSP system code (``MAxxxxxx``). Rendered
     *  as a muted chip next to the name. Empty string = row has no
     *  catalogue code (compute-only placeholder). */
    readonly code?: string;
    readonly mg: number;
    readonly hint?: string;
    readonly itemId?: string;
    /** PSP UUID for the mirrored SKU. When set, the name becomes a
     *  link to ``${pspBaseUrl}/production/items/${uuid}``. */
    readonly pspSourceUuid?: string | null;
    /** Compute couldn't dose this pick (missing rate attribute on
     *  the PSP item) — surface an inline warning pill so the
     *  scientist notices the SKU needs attention. */
    readonly notDosed?: boolean;
    /** Band placeholder — compute dosed the band but no SKU is
     *  picked. Row renders an amber "PICK A SKU" call-to-action so
     *  a half-finished formula doesn't read as "done". */
    readonly needsPick?: boolean;
  }[];
  /** PSP integration base URL — drives the "Open on PSP" deep link
   *  on rows carrying a ``pspSourceUuid``. ``null`` when the org
   *  has no live integration; rows render as plain text. */
  pspBaseUrl: string | null;
  /** Product identity — printed at the top of the print sheet. */
  productName: string;
  productCode: string;
  numberFormatter: Intl.NumberFormat;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  // Show every band that has at least one picked SKU, regardless of
  // whether the compute currently allocates mg to it. When actives
  // overshoot the target/max weight the compute crushes every
  // excipient band to 0 mg — if we filtered those out the rows would
  // vanish and the scientist would think their picks were deleted.
  // Keeping them visible at ``0.00 mg`` (with a warning strip below)
  // is the honest read: "your picks are still here, but the compute
  // couldn't fit them because actives are too heavy — lower an active
  // to bring the excipient mass back".
  const activeBands = bands.filter((band) => band.picks.length > 0);
  const hasActives = activeLines.length > 0;
  const activesTotalMg = activeLines.reduce(
    (acc, r) => acc + r.nominalMg,
    0,
  );
  // Overflow detector — if we have picks but every band collapsed to
  // 0 mg, the compute couldn't fit them. Bad but recoverable.
  const overflowed =
    activeBands.length > 0 &&
    activeBands.every((band) => band.totalMg <= 0);
  if (activeBands.length === 0 && !hasActives && (!extraRows || extraRows.length === 0)) return null;

  const canConvertPct = totalWeightMg !== null && totalWeightMg > 0;
  const editable = canEdit && !!onChange;

  const format = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : numberFormatter.format(value);
  const percentOf = (part: number, whole: number): string => {
    if (!whole || whole <= 0) return "0.0";
    return ((part / whole) * 100).toFixed(1);
  };

  // Any per-item overrides in effect? Drives visibility of the "Reset
  // all overrides" affordance in the header.
  const hasAnyOverride = Object.keys(overrides).some((k) =>
    k.startsWith(EXCIPIENT_ITEM_MG_PREFIX),
  );
  const resetAll = () => {
    if (!editable || !onChange) return;
    const next: Record<string, number> = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (!k.startsWith(EXCIPIENT_ITEM_MG_PREFIX)) next[k] = v;
    }
    onChange(next);
  };

  const printedOn = new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const handlePrint = () => {
    document.body.classList.add("fine-tune-print-active");
    const cleanup = () => {
      document.body.classList.remove("fine-tune-print-active");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  };

  return (
    <section
      data-print-target="true"
      className="fine-tune-panel rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200"
    >
      <style
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: `
.fine-tune-print-only { display: none; }
@media print {
  @page { size: A4 landscape; margin: 12mm 14mm; }
  body.fine-tune-print-active > * { visibility: hidden !important; }
  body.fine-tune-print-active [data-print-target="true"].fine-tune-panel,
  body.fine-tune-print-active [data-print-target="true"].fine-tune-panel * {
    visibility: visible !important;
  }
  body.fine-tune-print-active [data-print-target="true"].fine-tune-panel {
    position: absolute !important;
    left: 0 !important;
    top: 0 !important;
    width: 100% !important;
    box-shadow: none !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif !important;
    color: #111 !important;
  }
  body.fine-tune-print-active .fine-tune-hide-on-print { display: none !important; }
  body.fine-tune-print-active .fine-tune-print-only { display: block !important; }
  body.fine-tune-print-active input,
  body.fine-tune-print-active [data-print-target="true"] button {
    border: none !important;
    background: transparent !important;
    padding: 0 !important;
    color: #111 !important;
  }
  body.fine-tune-print-active .fine-tune-actual-slot {
    border-bottom: 1px solid #555;
    height: 1.2em;
    min-width: 4em;
    display: block;
  }
}
          `,
        }}
      />

      {/* Print-only header — product name + code + printed date. */}
      <div className="fine-tune-print-only mb-3 border-b border-ink-300 pb-2">
        <div className="text-base font-semibold text-ink-1000">
          {productName || "Untitled product"}
        </div>
        <div className="text-xs text-ink-700">
          {productCode ? <>Code: {productCode} · </> : null}
          Printed: {printedOn}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("builder.fine_tune.title")}
          </p>
          <p className="mt-1 text-xs leading-snug text-ink-500 fine-tune-hide-on-print">
            {tFormulations("builder.fine_tune.hint")}
          </p>
        </div>
        <div className="fine-tune-hide-on-print flex shrink-0 items-center gap-3">
          {hasAnyOverride && editable ? (
            <button
              type="button"
              onClick={resetAll}
              className="text-[11px] font-medium uppercase tracking-wide text-ink-500 underline-offset-2 hover:text-ink-1000 hover:underline"
            >
              {tFormulations("builder.fine_tune.reset_all")}
            </button>
          ) : null}
          {dirty && onRevertAllUnsaved ? (
            <button
              type="button"
              onClick={onRevertAllUnsaved}
              className="text-[11px] font-medium uppercase tracking-wide text-amber-700 underline-offset-2 hover:text-amber-900 hover:underline"
              title={tFormulations("builder.fine_tune.revert_unsaved_hint")}
            >
              ↺ {tFormulations("builder.fine_tune.revert_unsaved")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={handlePrint}
            className="inline-flex items-center gap-1.5 rounded-md bg-ink-50 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100"
            title="Print the fine-tune formula in landscape"
          >
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
        </div>
      </div>

      {overflowed ? (
        <div className="mt-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900">
          {tFormulations("builder.fine_tune.overflow_warning", {
            actives: format(activesTotalMg),
          })}
        </div>
      ) : null}

      {/* Incomplete-band banner — sum of ``extraRows`` where compute
          emitted a placeholder (no picked SKU). Surfaced at the top
          of the panel so a scientist who skims down without reading
          per-row pills still notices the recipe isn't finished. */}
      {(() => {
        const missing = (extraRows ?? []).filter((r) => r.needsPick);
        if (missing.length === 0) return null;
        const names = missing.map((r) => r.label).join(", ");
        return (
          <div className="mt-3 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-snug text-amber-900">
            <span className="font-semibold">
              {missing.length === 1
                ? "1 band still needs a SKU"
                : `${missing.length} bands still need a SKU`}
            </span>
            <span className="ml-1">
              — {names}. Pick a raw material on the Formulation tab, or
              tag one with the matching{" "}
              <span className="font-mono">use_as</span> on PSP so it
              shows up in the picker.
            </span>
          </div>
        );
      })()}

      {/* Flex layout with fixed-width numeric columns. Grid columns
          with ``minmax(0,1fr)`` in an arbitrary value fight the
          Tailwind parser and stack the cells vertically; flex + a
          shared column-width contract renders reliably. */}
      <div className="mt-4 overflow-hidden rounded-lg border border-ink-200">
        <div className="flex items-center gap-4 border-b border-ink-200 bg-ink-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          <span className="min-w-0 flex-1">
            {tFormulations("builder.fine_tune.col_ingredient")}
          </span>
          <span className="w-28 text-right">
            {tFormulations("builder.fine_tune.col_mg")}
          </span>
          <span className="w-28 text-right">
            {tFormulations("builder.fine_tune.col_pct")}
          </span>
          <span className="fine-tune-print-only w-28 text-right">
            Actual (mg)
          </span>
          <span className="fine-tune-print-only w-28 text-right">
            Signed
          </span>
          <span className="w-6 shrink-0 fine-tune-hide-on-print" aria-hidden />
        </div>
        {/* Flat rows — no grouping. Sorted mg ascending to match the
            BOM's ordering so the scan pattern between the two surfaces
            is the same (smallest weights on top, heaviest carriers at
            the bottom). Row kind (``active`` vs ``excipient``) only
            changes the edit callback — the visual is identical. */}
        <div className="divide-y divide-ink-100">
          {(() => {
            type FlatRow =
              | { kind: "active"; mg: number; row: FineTuneActiveRow }
              | {
                  kind: "excipient";
                  mg: number;
                  bandKey: string;
                  share: BandShare;
                };
            const rows: FlatRow[] = [];
            for (const row of activeLines) {
              rows.push({ kind: "active", mg: row.nominalMg, row });
            }
            for (const band of activeBands) {
              const shares = allocateBandShares({
                totalMg: band.totalMg,
                picks: band.picks,
                overrides,
                // Keep picks visible during a temporary overflow —
                // the operator needs to see the SKUs are still there
                // so they can lower an active without believing the
                // rows were deleted.
                keepZeroRows: true,
              });
              for (const share of shares) {
                rows.push({
                  kind: "excipient",
                  mg: share.mg,
                  bandKey: band.key,
                  share,
                });
              }
            }
            rows.sort((a, b) => a.mg - b.mg);
            return rows.map((r, idx) =>
              r.kind === "active" ? (
                <FineTuneActiveLineRow
                  key={`active:${r.row.key}`}
                  row={r.row}
                  totalWeightMg={totalWeightMg}
                  onMgChange={onActiveMgChange}
                  editable={canEdit && !!onActiveMgChange}
                  pspBaseUrl={pspBaseUrl}
                  tFormulations={tFormulations}
                />
              ) : (
                <FineTuneRow
                  key={`${r.bandKey}:${r.share.itemId ?? `placeholder-${idx}`}`}
                  share={r.share}
                  totalWeightMg={totalWeightMg}
                  overrides={overrides}
                  onChange={onChange}
                  editable={editable}
                  tFormulations={tFormulations}
                />
              ),
            );
          })()}
          {/* Extra rows — per-item excipients that aren't part of a
              capsule-style band-total split, plus read-only rows like
              the auto-picked capsule shell. Rows carrying an
              ``itemId`` become editable via the per-item mg override
              (``excipient_mg:<itemId>``) that both the capsule-band
              and powder per-item compute branches honour. */}
          {extraRows && extraRows.length > 0
            ? [...extraRows]
                .sort((a, b) => a.mg - b.mg)
                .map((row) => (
                  <FineTuneExtraRow
                    key={row.key}
                    row={row}
                    totalWeightMg={totalWeightMg}
                    overrides={overrides}
                    onChange={onChange}
                    editable={editable}
                    pspBaseUrl={pspBaseUrl}
                    numberFormatter={numberFormatter}
                    percentOf={percentOf}
                    tFormulations={tFormulations}
                  />
                ))
            : null}
        </div>
      </div>

      {/* Print-only signature footer — technician / supervisor / date. */}
      <div className="fine-tune-print-only mt-6 grid grid-cols-3 gap-6 text-[10pt] text-ink-1000">
        <div>
          <div className="text-[9pt] uppercase tracking-wide text-ink-500">
            Technician (name + signature)
          </div>
          <div className="mt-6 border-b border-ink-700">&nbsp;</div>
        </div>
        <div>
          <div className="text-[9pt] uppercase tracking-wide text-ink-500">
            Supervisor (name + signature)
          </div>
          <div className="mt-6 border-b border-ink-700">&nbsp;</div>
        </div>
        <div>
          <div className="text-[9pt] uppercase tracking-wide text-ink-500">
            Date
          </div>
          <div className="mt-6 border-b border-ink-700">&nbsp;</div>
        </div>
      </div>
    </section>
  );
});

/**
 * Active-line row inside the fine-tune panel. Two inputs — mg + % —
 * kept in sync via the underlying ``label_claim_mg`` on the line. mg
 * writes ``label_claim_mg`` directly; % converts to mg via
 * ``totalWeightMg`` and writes the same field. Local draft state so
 * keystrokes don't churn the parent's ``lines`` array; commits on
 * blur / Enter, reverts on Escape.
 */
function FineTuneActiveLineRow({
  row,
  totalWeightMg,
  onMgChange,
  editable,
  pspBaseUrl,
  tFormulations,
}: {
  row: FineTuneActiveRow;
  totalWeightMg: number | null;
  onMgChange: ((lineKey: string, mg: string) => void) | null;
  editable: boolean;
  pspBaseUrl?: string | null;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const canConvertPct = totalWeightMg !== null && totalWeightMg > 0;
  // Per-row revert affordance: the row is "dirty" when its current
  // mg differs from the last-saved value on the ``formulation`` prop
  // (delta > 0.005 mg absorbs float noise from the decimal <-> string
  // round-trip). Clicking ↺ writes the saved value back through the
  // normal ``onMgChange`` path, so the parent's dirty-tracking updates
  // consistently. ``savedMg === null`` = the line was picked but not
  // saved yet (no baseline to revert to).
  const isDirtyRow =
    row.savedMg !== null && Math.abs(row.nominalMg - row.savedMg) > 0.005;
  const revert = useCallback(() => {
    if (!editable || !onMgChange || row.savedMg === null) return;
    onMgChange(row.key, row.savedMg.toString());
  }, [editable, onMgChange, row.key, row.savedMg]);
  const [mgDraft, setMgDraft] = useState<string>(() => row.nominalMg.toFixed(2));
  const [pctDraft, setPctDraft] = useState<string>(() =>
    canConvertPct ? ((row.nominalMg / totalWeightMg!) * 100).toFixed(2) : "",
  );
  const [focused, setFocused] = useState<"mg" | "pct" | null>(null);
  useEffect(() => {
    if (focused === "mg") return;
    setMgDraft(row.nominalMg.toFixed(2));
  }, [row.nominalMg, focused]);
  useEffect(() => {
    if (focused === "pct") return;
    setPctDraft(
      canConvertPct ? ((row.nominalMg / totalWeightMg!) * 100).toFixed(2) : "",
    );
  }, [row.nominalMg, canConvertPct, totalWeightMg, focused]);

  const commitMg = useCallback(() => {
    setFocused(null);
    if (!editable || !onMgChange) return;
    const parsed = Number.parseFloat(mgDraft);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onMgChange(row.key, parsed.toString());
  }, [mgDraft, editable, onMgChange, row.key]);

  const commitPct = useCallback(() => {
    setFocused(null);
    if (!editable || !onMgChange || !canConvertPct) return;
    const parsed = Number.parseFloat(pctDraft);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const mg = (parsed / 100) * totalWeightMg!;
    onMgChange(row.key, mg.toString());
  }, [pctDraft, editable, onMgChange, canConvertPct, totalWeightMg, row.key]);

  const inputBase =
    "w-full rounded border border-ink-200 bg-white px-2 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:cursor-not-allowed disabled:bg-ink-50";

  return (
    <div
      className={`flex items-center gap-4 px-4 py-2 text-sm ${
        isDirtyRow ? "bg-amber-50/40" : ""
      }`}
    >
      <IngredientNameCell
        name={row.name}
        code={row.code}
        pspSourceUuid={row.pspSourceUuid}
        pspBaseUrl={pspBaseUrl}
      />
      {editable ? (
        <>
          <span className="flex w-28 shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={mgDraft}
              onFocus={() => setFocused("mg")}
              onChange={(e) => setMgDraft(e.target.value)}
              onBlur={commitMg}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setMgDraft(row.nominalMg.toFixed(2));
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={`${inputBase} ${
                isDirtyRow ? "border-amber-300" : ""
              }`}
              aria-label={`${row.name} milligrams`}
            />
            <span className="text-[10px] text-ink-500">mg</span>
          </span>
          <span className="flex w-28 shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              disabled={!canConvertPct}
              value={pctDraft}
              onFocus={() => setFocused("pct")}
              onChange={(e) => setPctDraft(e.target.value)}
              onBlur={commitPct}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setPctDraft(
                    canConvertPct
                      ? ((row.nominalMg / totalWeightMg!) * 100).toFixed(2)
                      : "",
                  );
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={`${inputBase} ${
                isDirtyRow ? "border-amber-300" : ""
              }`}
              aria-label={`${row.name} percent`}
            />
            <span className="text-[10px] text-ink-500">%</span>
          </span>
          {isDirtyRow ? (
            <button
              type="button"
              onClick={revert}
              className="w-6 shrink-0 rounded p-1 text-center text-amber-700 hover:bg-amber-100 hover:text-amber-900"
              title={tFormulations("builder.fine_tune.revert_row", {
                mg: row.savedMg?.toFixed(2) ?? "0",
              })}
              aria-label={tFormulations("builder.fine_tune.revert_row", {
                mg: row.savedMg?.toFixed(2) ?? "0",
              })}
            >
              ↺
            </button>
          ) : (
            <span className="w-6 shrink-0" aria-hidden />
          )}
        </>
      ) : (
        <>
          <span className="w-28 shrink-0 text-right tabular-nums text-ink-700">
            {row.nominalMg.toFixed(2)} mg
          </span>
          <span className="w-28 shrink-0 text-right tabular-nums text-ink-500">
            {canConvertPct
              ? `${((row.nominalMg / totalWeightMg!) * 100).toFixed(2)}%`
              : "—"}
          </span>
          <span className="w-6 shrink-0 fine-tune-hide-on-print" aria-hidden />
        </>
      )}
      <span className="fine-tune-print-only w-28">
        <span className="fine-tune-actual-slot" />
      </span>
      <span className="fine-tune-print-only w-28">
        <span className="fine-tune-actual-slot" />
      </span>
    </div>
  );
}

/**
 * One row inside the fine-tune panel. Two inputs — mg and % — kept
 * in sync via the same underlying override (stored as mg). Local
 * draft state lets the scientist type freely; commits on blur / Enter,
 * reverts on Escape.
 */
function FineTuneRow({
  share,
  totalWeightMg,
  overrides,
  onChange,
  editable,
  tFormulations,
}: {
  share: BandShare;
  totalWeightMg: number | null;
  overrides: Readonly<Record<string, number>>;
  onChange: ((next: Record<string, number>) => void) | null;
  editable: boolean;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const canConvertPct = totalWeightMg !== null && totalWeightMg > 0;
  const overrideKey = share.itemId
    ? `${EXCIPIENT_ITEM_MG_PREFIX}${share.itemId}`
    : null;
  const canEditRow = editable && !!overrideKey && !!onChange;

  const [mgDraft, setMgDraft] = useState<string>(() => share.mg.toFixed(2));
  const [pctDraft, setPctDraft] = useState<string>(() =>
    canConvertPct ? ((share.mg / totalWeightMg!) * 100).toFixed(2) : "",
  );
  const [focused, setFocused] = useState<"mg" | "pct" | null>(null);
  useEffect(() => {
    if (focused === "mg") return;
    setMgDraft(share.mg.toFixed(2));
  }, [share.mg, focused]);
  useEffect(() => {
    if (focused === "pct") return;
    setPctDraft(
      canConvertPct ? ((share.mg / totalWeightMg!) * 100).toFixed(2) : "",
    );
  }, [share.mg, canConvertPct, totalWeightMg, focused]);

  const persistMg = useCallback(
    (mgValue: number | null) => {
      if (!canEditRow || !overrideKey || !onChange) return;
      const next: Record<string, number> = { ...overrides };
      if (mgValue === null || !Number.isFinite(mgValue) || mgValue < 0) {
        delete next[overrideKey];
      } else {
        const capped = Math.min(mgValue, 100_000);
        if (overrides[overrideKey] === capped) return;
        next[overrideKey] = capped;
      }
      onChange(next);
    },
    [canEditRow, onChange, overrideKey, overrides],
  );

  const commitMg = useCallback(() => {
    setFocused(null);
    const parsed = Number.parseFloat(mgDraft);
    persistMg(Number.isFinite(parsed) ? parsed : null);
  }, [mgDraft, persistMg]);

  const commitPct = useCallback(() => {
    setFocused(null);
    if (!canConvertPct) return;
    const parsed = Number.parseFloat(pctDraft);
    persistMg(
      Number.isFinite(parsed) ? (parsed / 100) * totalWeightMg! : null,
    );
  }, [pctDraft, persistMg, canConvertPct, totalWeightMg]);

  const reset = useCallback(() => {
    if (!canEditRow || !overrideKey || !onChange) return;
    if (!(overrideKey in overrides)) return;
    const next: Record<string, number> = { ...overrides };
    delete next[overrideKey];
    onChange(next);
  }, [canEditRow, onChange, overrideKey, overrides]);

  const inputBase =
    "w-full rounded border px-2 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-brand-500";
  const inputTone = share.overridden
    ? "border-brand-300 bg-brand-50/40"
    : "border-ink-200 bg-white";

  return (
    <div
      className={`flex items-center gap-4 px-4 py-2 text-sm ${
        share.overridden ? "bg-brand-50/20" : ""
      }`}
    >
      <span
        className="min-w-0 flex-1 break-words text-ink-800"
        title={share.name}
      >
        {share.name}
      </span>
      {canEditRow ? (
        <>
          <span className="flex w-28 shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={mgDraft}
              onFocus={() => setFocused("mg")}
              onChange={(e) => setMgDraft(e.target.value)}
              onBlur={commitMg}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setMgDraft(share.mg.toFixed(2));
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={`${inputBase} ${inputTone}`}
              aria-label={`${share.name} milligrams`}
            />
            <span className="text-[10px] text-ink-500">mg</span>
          </span>
          <span className="flex w-28 shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              disabled={!canConvertPct}
              value={pctDraft}
              onFocus={() => setFocused("pct")}
              onChange={(e) => setPctDraft(e.target.value)}
              onBlur={commitPct}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setPctDraft(
                    canConvertPct
                      ? ((share.mg / totalWeightMg!) * 100).toFixed(2)
                      : "",
                  );
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={`${inputBase} ${inputTone} disabled:cursor-not-allowed disabled:bg-ink-50`}
              aria-label={`${share.name} percent`}
            />
            <span className="text-[10px] text-ink-500">%</span>
          </span>
          {share.overridden ? (
            <button
              type="button"
              onClick={reset}
              className="w-6 shrink-0 rounded p-1 text-center text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
              title={tFormulations("builder.fine_tune.reset_row")}
              aria-label={tFormulations("builder.fine_tune.reset_row")}
            >
              ↺
            </button>
          ) : (
            <span className="w-6 shrink-0" aria-hidden />
          )}
        </>
      ) : (
        <>
          <span className="w-28 shrink-0 text-right tabular-nums text-ink-700">
            {share.mg.toFixed(2)} mg
          </span>
          <span className="w-28 shrink-0 text-right tabular-nums text-ink-500">
            {canConvertPct
              ? `${((share.mg / totalWeightMg!) * 100).toFixed(2)}%`
              : "—"}
          </span>
          <span className="w-6 shrink-0 fine-tune-hide-on-print" aria-hidden />
        </>
      )}
      <span className="fine-tune-print-only w-28">
        <span className="fine-tune-actual-slot" />
      </span>
      <span className="fine-tune-print-only w-28">
        <span className="fine-tune-actual-slot" />
      </span>
    </div>
  );
}

/**
 * Per-item row in the Fine-tune panel's "everything else" section.
 * Editable when the row carries an ``itemId`` (writes an mg override
 * under ``excipient_mg:<itemId>``); read-only otherwise. Surfaces a
 * visible amber pill when the compute couldn't dose the pick (missing
 * rate on the PSP item) — the scientist can either type an mg here or
 * fix the SKU on PSP.
 */
function FineTuneExtraRow({
  row,
  totalWeightMg,
  overrides,
  onChange,
  editable,
  pspBaseUrl,
  numberFormatter,
  percentOf,
  tFormulations,
}: {
  row: {
    readonly key: string;
    readonly label: string;
    readonly code?: string;
    readonly mg: number;
    readonly hint?: string;
    readonly itemId?: string;
    readonly pspSourceUuid?: string | null;
    readonly notDosed?: boolean;
    readonly needsPick?: boolean;
  };
  totalWeightMg: number | null;
  overrides: Readonly<Record<string, number>>;
  onChange: ((next: Record<string, number>) => void) | null;
  editable: boolean;
  pspBaseUrl?: string | null;
  numberFormatter: Intl.NumberFormat;
  percentOf: (part: number, whole: number) => string;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const canConvertPct = totalWeightMg !== null && totalWeightMg > 0;
  const overrideKey = row.itemId
    ? `${EXCIPIENT_ITEM_MG_PREFIX}${row.itemId}`
    : null;
  const canEditRow = editable && !!overrideKey && !!onChange;
  const overridden = overrideKey ? overrideKey in overrides : false;

  const [mgDraft, setMgDraft] = useState<string>(() => row.mg.toFixed(2));
  const [pctDraft, setPctDraft] = useState<string>(() =>
    canConvertPct ? ((row.mg / totalWeightMg!) * 100).toFixed(2) : "",
  );
  const [focused, setFocused] = useState<"mg" | "pct" | null>(null);
  useEffect(() => {
    if (focused === "mg") return;
    setMgDraft(row.mg.toFixed(2));
  }, [row.mg, focused]);
  useEffect(() => {
    if (focused === "pct") return;
    setPctDraft(
      canConvertPct ? ((row.mg / totalWeightMg!) * 100).toFixed(2) : "",
    );
  }, [row.mg, canConvertPct, totalWeightMg, focused]);

  const persistMg = useCallback(
    (mgValue: number | null) => {
      if (!canEditRow || !overrideKey || !onChange) return;
      const next: Record<string, number> = { ...overrides };
      if (mgValue === null || !Number.isFinite(mgValue) || mgValue < 0) {
        delete next[overrideKey];
      } else {
        const capped = Math.min(mgValue, 100_000);
        if (overrides[overrideKey] === capped) return;
        next[overrideKey] = capped;
      }
      onChange(next);
    },
    [canEditRow, onChange, overrideKey, overrides],
  );

  const commitMg = useCallback(() => {
    setFocused(null);
    const parsed = Number.parseFloat(mgDraft);
    persistMg(Number.isFinite(parsed) ? parsed : null);
  }, [mgDraft, persistMg]);

  const commitPct = useCallback(() => {
    setFocused(null);
    if (!canConvertPct) return;
    const parsed = Number.parseFloat(pctDraft);
    persistMg(
      Number.isFinite(parsed) ? (parsed / 100) * totalWeightMg! : null,
    );
  }, [pctDraft, persistMg, canConvertPct, totalWeightMg]);

  const reset = useCallback(() => {
    if (!canEditRow || !overrideKey || !onChange) return;
    if (!overridden) return;
    const next: Record<string, number> = { ...overrides };
    delete next[overrideKey];
    onChange(next);
  }, [canEditRow, onChange, overrideKey, overrides, overridden]);

  const inputBase =
    "w-full rounded border px-2 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-brand-500";
  const inputTone = overridden
    ? "border-brand-300 bg-brand-50/40"
    : row.notDosed && !overridden
      ? "border-amber-300 bg-amber-50/40"
      : "border-ink-200 bg-white";

  return (
    <div
      className={`flex items-center gap-4 border-t border-ink-100 px-4 py-2 text-sm ${
        overridden
          ? "bg-brand-50/20"
          : row.needsPick
            ? "bg-amber-50/40"
            : row.notDosed
              ? "bg-amber-50/30"
              : ""
      }`}
    >
      <IngredientNameCell
        name={row.label}
        code={row.code}
        pspSourceUuid={row.pspSourceUuid}
        pspBaseUrl={pspBaseUrl}
        extra={
          row.needsPick ? (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
              <span aria-hidden>⚠</span>
              Pick a {row.label.toLowerCase()} SKU on the Formulation
              tab
            </span>
          ) : row.notDosed && !overridden ? (
            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
              <span aria-hidden>⚠</span>
              {tFormulations("builder.fine_tune.not_dosed")}
            </span>
          ) : row.hint ? (
            <span className="text-[11px] text-ink-500">{row.hint}</span>
          ) : null
        }
      />
      {canEditRow ? (
        <>
          <span className="flex w-28 shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={mgDraft}
              onFocus={() => setFocused("mg")}
              onChange={(e) => setMgDraft(e.target.value)}
              onBlur={commitMg}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setMgDraft(row.mg.toFixed(2));
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={`${inputBase} ${inputTone}`}
              aria-label={`${row.label} milligrams`}
            />
            <span className="text-[10px] text-ink-500">mg</span>
          </span>
          <span className="flex w-28 shrink-0 items-center gap-1">
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              disabled={!canConvertPct}
              value={pctDraft}
              onFocus={() => setFocused("pct")}
              onChange={(e) => setPctDraft(e.target.value)}
              onBlur={commitPct}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setPctDraft(
                    canConvertPct
                      ? ((row.mg / totalWeightMg!) * 100).toFixed(2)
                      : "",
                  );
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className={`${inputBase} ${inputTone} disabled:cursor-not-allowed disabled:bg-ink-50`}
              aria-label={`${row.label} percent`}
            />
            <span className="text-[10px] text-ink-500">%</span>
          </span>
          {overridden ? (
            <button
              type="button"
              onClick={reset}
              className="w-6 shrink-0 rounded p-1 text-center text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
              title={tFormulations("builder.fine_tune.reset_row")}
              aria-label={tFormulations("builder.fine_tune.reset_row")}
            >
              ↺
            </button>
          ) : (
            <span className="w-6 shrink-0" aria-hidden />
          )}
        </>
      ) : (
        <>
          <span className="w-28 shrink-0 text-right tabular-nums text-ink-700">
            {numberFormatter.format(row.mg)} mg
          </span>
          <span className="w-28 shrink-0 text-right tabular-nums text-ink-500">
            {totalWeightMg && totalWeightMg > 0
              ? `${percentOf(row.mg, totalWeightMg)}%`
              : "—"}
          </span>
          <span className="w-6 shrink-0 fine-tune-hide-on-print" aria-hidden />
        </>
      )}
      <span className="fine-tune-print-only w-28">
        <span className="fine-tune-actual-slot" />
      </span>
      <span className="fine-tune-print-only w-28">
        <span className="fine-tune-actual-slot" />
      </span>
    </div>
  );
}


// Memoised so that keystrokes in unrelated state (search input,
// metadata fields, etc.) don't trigger a full re-render of the
// excipients table + viability + warnings + override panel tree.
// React's shallow equality on props is enough here because every
// expensive prop (``totals``, ``mccCarrierLabels``, ``antiCakingLabels``)
// is already a stable reference from useMemo in the parent.
const TotalsBlock = memo(function TotalsBlock({
  totals,
  servingSize,
  dosageForm,
  numberFormatter,
  tFormulations,
  mccCarrierPicks = [],
  antiCakingPicks = [],
  dcpCarrierPicks = [],
  excipientOverrides,
}: {
  totals: FormulationTotals;
  servingSize: number;
  dosageForm: DosageForm;
  numberFormatter: Intl.NumberFormat;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
  /** Picked MCC-carrier items ({id, name, internal_code}) so the MCC
   *  band can render one row per pick showing the current split. */
  mccCarrierPicks?: readonly BandPick[];
  /** Picked anti-caking items — same shape as ``mccCarrierPicks``.
   *  Anti-caking splits stearate + silica math but shares one pick
   *  list, so we combine before splitting across picks. */
  antiCakingPicks?: readonly BandPick[];
  /** Picked DCP-carrier items — parallels MCC / anti-caking. */
  dcpCarrierPicks?: readonly BandPick[];
  /** Full override dict from ``metadata.excipient_overrides``. Per-item
   *  mg entries live under ``excipient_mg:<uuid>`` keys — read-only
   *  here; edits happen in ``ExcipientFineTunePanel`` below the
   *  builder where the wider surface can host proper inputs. */
  excipientOverrides: Readonly<Record<string, number>>;
}) {
  const format = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : numberFormatter.format(value);
  // Gram formatter — the builder's primary numberFormatter keeps 4
  // fraction digits so mg rounding stays exact. Grams read better
  // with 2 fraction digits (``10.00g`` not ``10.0000g``).
  // Percentage-of-total helper for the gummy excipient rows. Keeps
  // one decimal so a 5.5% water row doesn't read as 6%. Guards against
  // a zero denominator by returning "0.0" — the row hides itself
  // anyway when the scientist hasn't typed a target.
  const percentOf = (part: number, whole: number): string => {
    if (!whole || whole <= 0) return "0.0";
    return ((part / whole) * 100).toFixed(1);
  };
  const formatGrams = (mg: number | null | undefined) =>
    mg === null || mg === undefined
      ? "—"
      : (mg / 1000).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 3,
        });

  const excipients = totals.excipients;
  const servings = Math.max(1, servingSize);
  const perServingMg =
    totals.totalWeightMg !== null ? totals.totalWeightMg * servings : null;
  // Leftover = max - total. Positive ⇒ headroom (can add more);
  // negative ⇒ overshoot (won't fit). Only meaningful when there's
  // both a total and a ceiling to measure against.
  //
  // ``LEFTOVER_TOLERANCE_MG`` collapses sub-microgram float noise to a
  // clean zero. ``computeCapsule`` derives the MCC fill as
  // ``max - active - stearate - silica`` and the total weight then
  // sums those four numbers back up. In pure math the total equals
  // ``max`` exactly, but IEEE-754 addition leaves a -1e-13-ish drift
  // depending on the operand order — without a tolerance band the UI
  // flips between "Compliant" and "Overshoot" for a formula that
  // already fills the capsule to its target. 0.005 mg is five orders
  // of magnitude below what a manufacturing scale can measure, so
  // collapsing the band has zero downside.
  const LEFTOVER_TOLERANCE_MG = 0.005;
  const rawLeftover =
    totals.totalWeightMg !== null && totals.maxWeightMg !== null
      ? totals.maxWeightMg - totals.totalWeightMg
      : null;
  const leftoverMg =
    rawLeftover === null
      ? null
      : Math.abs(rawLeftover) < LEFTOVER_TOLERANCE_MG
        ? 0
        : rawLeftover;
  // Per-unit vocabulary: scientists think "per scoop" for powder,
  // "per capsule" for capsule, etc. Keeps the per-serving math legible
  // at a glance — "10g/scoop × 2 scoops = 20g/serving".
  const perUnitKey: "per_scoop" | "per_capsule" | "per_tablet" | "per_gummy" | "per_unit" =
    dosageForm === "powder"
      ? "per_scoop"
      : dosageForm === "capsule"
        ? "per_capsule"
        : dosageForm === "tablet"
          ? "per_tablet"
          : dosageForm === "gummy"
            ? "per_gummy"
            : "per_unit";

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("builder.excipients.total_active")}
        </p>
        <div className="mt-1">
          <CopyableValue
            mg={totals.totalActiveMg}
            display={
              <span className="text-xl font-semibold tracking-tight text-ink-1000">
                {format(totals.totalActiveMg)}{" "}
                <span className="text-sm text-ink-600">mg</span>
              </span>
            }
            copyLabel={tFormulations("builder.copy.tooltip")}
            copiedLabel={tFormulations("builder.copy.copied")}
          />
        </div>
        <p className="mt-0.5 text-xs text-ink-500">
          {formatGrams(totals.totalActiveMg)} g
        </p>
      </div>

      {excipients ? (
        <div className="border-t border-ink-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("builder.excipients.title")}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-700">
            {/*
              Gummy base lines lead the list because they're the
              absorber-rows — scientists check the combined percentage
              to confirm the base is above the 65% floor before
              tweaking flavours. A multi-item blend renders one row
              per pick (each with its equal share); an un-picked
              gummy renders a single generic "Gummy Base" row.
            */}
            {/*
              Gummy base — when the scientist picked multiple items,
              collapse them into one EU-label-style entry per
              ``use_as`` category ("Sweeteners (Xylitol, Maltitol)").
              The per-item breakdown still exists underneath on the
              wire (procurement BOM, ingredient declaration); the
              totals panel just groups it for the scientist's eye.
            */}
            {excipients.gummyBaseRows.length > 0
              ? groupRowsByUseAs(excipients.gummyBaseRows).map((group) => (
                  <li
                    key={group.useAs || "gummy_base"}
                    className="flex justify-between gap-2 font-medium text-orange-700"
                  >
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span>{group.label}</span>
                    </span>
                    <span className="tabular-nums">
                      {format(group.mg)} mg
                      {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                        <span className="ml-1 text-ink-500">
                          ({percentOf(group.mg, totals.totalWeightMg)}%)
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))
              : excipients.gummyBaseMg !== null
                ? (
                    <li
                      className={`flex justify-between gap-2 font-medium ${
                        excipients.gummyBaseMg > 0
                          ? "text-orange-700"
                          : "text-danger"
                      }`}
                    >
                      <span>
                        {tFormulations("builder.excipients.gummy_base")}
                      </span>
                      <span className="tabular-nums">
                        {format(excipients.gummyBaseMg)} mg
                        {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                          <span className="ml-1 text-ink-500">
                            ({percentOf(excipients.gummyBaseMg, totals.totalWeightMg)}%)
                          </span>
                        ) : null}
                      </span>
                    </li>
                  )
                : null}
            {excipients.waterMg !== null ? (
              <li className="flex justify-between gap-2">
                <span>{tFormulations("builder.excipients.water")}</span>
                <span className="tabular-nums">
                  {format(excipients.waterMg)} mg
                  {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                    <span className="ml-1 text-ink-500">
                      ({percentOf(excipients.waterMg, totals.totalWeightMg)}%)
                    </span>
                  ) : null}
                </span>
              </li>
            ) : null}
            {excipients.rows.length > 0 ? (
              // Flexible list used by powder + gummy. ``is_remainder``
              // rows (carrier / gummy base) get a subtle orange accent
              // so scientists can see which value is "whatever's left"
              // at a glance. For powders the concentration (mg/ml of
              // water) is shown inline so the scientist can see the
              // formula behind the computed mg — changing water volume
              // rescales every row with this rate.
              //
              // Flavouring (slug prefix ``flavouring:``) and Colour
              // (``colour:``) items collapse into "Flavouring (Natural
              // Strawberry, Lemon Extract)" / "Colour (Beetroot,
              // Turmeric)" rows — EU label convention. Glazing
              // similarly groups under ``glazing:``. Everything else
              // (acidity, powder flavour rows) stays standalone.
              groupGummyFlavourRows(excipients.rows, dosageForm).map((row) => (
                <li
                  key={row.slug}
                  className={`flex items-baseline justify-between gap-3 ${
                    row.isRemainder ? "font-medium text-orange-700" : ""
                  }`}
                >
                  {/* Stack the label + inline rate vertically so a long
                      bracket list doesn't push the mg value off-line. */}
                  <span className="flex min-w-0 flex-col">
                    <span className="break-words">{row.label}</span>
                    {row.concentrationMgPerGPowder !== null &&
                    row.concentrationMgPerGPowder !== undefined ? (
                      <span className="text-[10px] text-ink-500">
                        {row.concentrationMgPerGPowder} mg/g
                      </span>
                    ) : null}
                    {row.concentrationMgPerMlWater !== null &&
                    row.concentrationMgPerMlWater !== undefined ? (
                      <span className="text-[10px] text-ink-500">
                        {row.concentrationMgPerMlWater} mg/ml
                      </span>
                    ) : null}
                  </span>
                  {/* Right column: mg + (%). ``whitespace-nowrap`` keeps
                      them on a single line even on narrow viewports
                      where the label has wrapped beneath. */}
                  <span className="shrink-0 whitespace-nowrap tabular-nums">
                    {format(row.mg)} mg
                    {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                      <span className="ml-1 text-ink-500">
                        ({percentOf(row.mg, totals.totalWeightMg)}%)
                      </span>
                    ) : null}
                  </span>
                </li>
              ))
            ) : null}
            {excipients.rows.length === 0 &&
            excipients.gummyBaseMg === null &&
            excipients.waterMg === null &&
            excipients.gummyBaseRows.length === 0 ? (
              <>
                {/* Capsule + tablet excipient rows are gated on whether
                    the corresponding picker has any items. Empty
                    picker -> the row drops out entirely (matches the
                    server gating + the spec sheet snapshot). Each
                    surviving row shows its mg AND its share of the
                    total fill weight as a percentage. */}
                {/* Anti-caking collapses into one combined row that
                    reflects exactly what was picked. The math splits
                    the 1.4% combined into a 1% Stearate + 0.4% Silica
                    pair on the breakdown so the spec sheet's two-
                    field shape keeps working, but on the builder we
                    surface the band as a single line so picking only
                    Silicon Dioxide doesn't look like it conjured
                    Magnesium Stearate too. The total mg = stearate +
                    silica (1.4% of active). */}
                {/* Excipient bands render one row per picked SKU so
                    scientists can see each ingredient's mg + %
                    contribution independently (mirrors the BOM layout).
                    Total mg = server-computed band total; per-item mg
                    = equal split across picks. When no picks exist we
                    fall back to a single generic label row so the band
                    is still visible while the scientist is mid-build. */}
                {excipients.mgStearateMg + excipients.silicaMg > 0
                  ? renderExcipientBand({
                      totalMg: excipients.mgStearateMg + excipients.silicaMg,
                      picks: antiCakingPicks,
                      groupLabel: tFormulations(
                        "builder.excipients.anti_caking",
                      ),
                      totalWeightMg: totals.totalWeightMg,
                      overrides: excipientOverrides,
                      format,
                      percentOf,
                    })
                  : null}
                {excipients.dcpMg !== null && excipients.dcpMg > 0
                  ? renderExcipientBand({
                      totalMg: excipients.dcpMg,
                      picks: dcpCarrierPicks,
                      groupLabel: tFormulations("builder.excipients.dcp"),
                      totalWeightMg: totals.totalWeightMg,
                      overrides: excipientOverrides,
                      format,
                      percentOf,
                    })
                  : null}
                {excipients.mccMg > 0
                  ? renderExcipientBand({
                      totalMg: excipients.mccMg,
                      picks: mccCarrierPicks,
                      groupLabel: tFormulations("builder.excipients.mcc"),
                      totalWeightMg: totals.totalWeightMg,
                      overrides: excipientOverrides,
                      format,
                      percentOf,
                    })
                  : null}
              </>
            ) : null}
          </ul>
        </div>
      ) : null}

      {totals.totalWeightMg !== null ? (
        <div className="border-t border-ink-100 pt-4 text-xs text-ink-700">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 break-words">
              {tFormulations(
                `builder.excipients.total_weight_${perUnitKey}` as "builder.excipients.total_weight_per_scoop",
              )}
            </span>
            <CopyableValue
              mg={totals.totalWeightMg}
              display={
                <span className="tabular-nums">
                  {format(totals.totalWeightMg)} mg
                  <span className="ml-1 text-ink-500">
                    ({formatGrams(totals.totalWeightMg)} g)
                  </span>
                </span>
              }
              copyLabel={tFormulations("builder.copy.tooltip")}
              copiedLabel={tFormulations("builder.copy.copied")}
            />
          </div>
          {totals.maxWeightMg !== null ? (
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <span className="min-w-0 break-words">
                {tFormulations("builder.excipients.max_weight")}
              </span>
              <CopyableValue
                mg={totals.maxWeightMg}
                display={
                  <span className="tabular-nums">
                    {format(totals.maxWeightMg)} mg
                    <span className="ml-1 text-ink-500">
                      ({formatGrams(totals.maxWeightMg)} g)
                    </span>
                  </span>
                }
                copyLabel={tFormulations("builder.copy.tooltip")}
                copiedLabel={tFormulations("builder.copy.copied")}
              />
            </div>
          ) : null}
          {/* Leftover / overshoot — guides the scientist toward an
              optimal fill. Negative ``leftover`` is shown as
              overshoot so they know the formula won't press. The mg
              value is copied raw so the scientist can paste it
              straight into a new ingredient line or into Excel. */}
          {leftoverMg !== null ? (
            <div
              className={`mt-1 flex items-baseline justify-between gap-3 ${
                leftoverMg < 0
                  ? "font-medium text-danger"
                  : leftoverMg === 0
                    ? "font-medium text-success"
                    : "text-orange-700"
              }`}
            >
              <span className="min-w-0 break-words">
                {leftoverMg < 0
                  ? tFormulations("builder.excipients.overshoot")
                  : leftoverMg === 0
                    ? tFormulations("builder.excipients.compliant")
                    : tFormulations("builder.excipients.leftover")}
              </span>
              <CopyableValue
                mg={Math.abs(leftoverMg)}
                display={
                  <span className="tabular-nums">
                    {format(Math.abs(leftoverMg))} mg
                    <span className="ml-1 opacity-70">
                      ({formatGrams(Math.abs(leftoverMg))} g)
                    </span>
                  </span>
                }
                copyLabel={tFormulations("builder.copy.tooltip")}
                copiedLabel={tFormulations("builder.copy.copied")}
              />
            </div>
          ) : null}
          {/* Per-serving roll-up. For powder that's "2 scoops × X mg
              per scoop". Displayed in grams because at the serving
              level scientists think in g, not mg. */}
          {perServingMg !== null && servings > 1 ? (
            <div className="mt-2 flex items-baseline justify-between border-t border-ink-100 pt-2 font-medium text-ink-1000">
              <span>
                {tFormulations("builder.excipients.per_serving", {
                  count: servings,
                })}
              </span>
              <CopyableValue
                mg={perServingMg}
                display={
                  <span className="tabular-nums">
                    {formatGrams(perServingMg)} g
                    <span className="ml-1 text-ink-500">
                      ({format(perServingMg)} mg)
                    </span>
                  </span>
                }
                copyLabel={tFormulations("builder.copy.tooltip")}
                copiedLabel={tFormulations("builder.copy.copied")}
              />
            </div>
          ) : null}
          {totals.sizeLabel ? (
            <div className="mt-1 text-xs text-ink-500">
              {totals.sizeLabel}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-ink-100 pt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("builder.viability.title")}
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {totals.viability.codes.map((code) => {
            const isBad =
              code === "cannot_make" ||
              code === "more_challenging_to_make" ||
              code === "consult_r_and_d" ||
              code === "capsule_too_large";
            const isWarn = code === "more_challenging_to_make";
            const chipBase =
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
            return (
              <li
                key={code}
                className={
                  isBad
                    ? isWarn
                      ? `${chipBase} bg-warning/10 text-warning ring-warning/20`
                      : `${chipBase} bg-danger/10 text-danger ring-danger/20`
                    : `${chipBase} bg-success/10 text-success ring-success/20`
                }
              >
                {tFormulations(
                  `builder.viability.codes.${code}` as `builder.viability.codes.can_make`,
                )}
              </li>
            );
          })}
        </ul>
        {totals.warnings.length > 0 ? (
          // Soft warnings the math accumulated alongside the viability
          // codes (acidity dose / water-volume gaps for powders). We
          // render them under their own header rather than mixing into
          // the codes list so the scientist sees a single can_make
          // chip without it being swallowed by ambient warnings.
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {tFormulations("builder.viability.warnings_title")}
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {totals.warnings.map((raw) => {
                // Warnings may carry a colon-separated payload
                // (``powder_acidity_dose_missing:<item label>``) for
                // per-item attribution. Split once and feed the tail
                // into the translator's ``name`` interpolation slot.
                const colonAt = raw.indexOf(":");
                const code = colonAt === -1 ? raw : raw.slice(0, colonAt);
                const payload =
                  colonAt === -1 ? "" : raw.slice(colonAt + 1).trim();
                const message = tFormulations(
                  `builder.viability.warnings.${code}` as `builder.viability.warnings.powder_acidity_water_volume_missing`,
                  { name: payload },
                );
                return (
                  <li
                    key={raw}
                    className="inline-flex items-start gap-2 rounded-md bg-warning/10 px-2 py-1 text-xs text-warning ring-1 ring-inset ring-warning/20"
                  >
                    <span
                      aria-hidden
                      className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                    />
                    <span>{message}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
});


// ---------------------------------------------------------------------------
// Tiny field primitives — enough for the builder, not a library
// ---------------------------------------------------------------------------


/**
 * Click-to-copy wrapper for a numeric value in the Totals panel.
 *
 * The scientist frequently copies a computed number (headroom,
 * total weight, per-serving) and pastes it into Excel, a new
 * ingredient line, or a message. Rendering each number as a plain
 * span forces them to manually select the digits between the unit
 * suffix and the grams annotation, which is fiddly on the first
 * try. This button wraps the visible display and copies the *raw*
 * mg number — no ``mg`` suffix, no grouping — so a paste lands as
 * a clean numeric value in any downstream tool.
 *
 * Feedback flashes for 1.2s after a successful copy; on failure the
 * button silently swallows the error because the browser already
 * surfaces clipboard permission issues in its own UI.
 */
function CopyableValue({
  mg,
  display,
  copyLabel,
  copiedLabel,
}: {
  mg: number;
  display: ReactNode;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      // Plain, un-grouped number string. ``513.2285`` pastes as one
      // cell, never broken into pieces by thousands separators.
      const payload = Number.isFinite(mg) ? String(mg) : "";
      if (!payload) return;
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard permission errors surface in the browser's own UI */
    }
  }, [mg]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? copiedLabel : copyLabel}
      aria-label={copied ? copiedLabel : copyLabel}
      className="group inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 text-left transition-colors hover:bg-ink-100/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
    >
      {display}
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-success" aria-hidden />
      ) : (
        <Copy
          className="h-3 w-3 shrink-0 text-ink-400 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          aria-hidden
        />
      )}
    </button>
  );
}



function TextField({
  label,
  value,
  onChange,
  disabled,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
      />
      {hint ? (
        <span className="text-[10px] text-ink-500">{hint}</span>
      ) : null}
    </label>
  );
}


function NumberField({
  label,
  value,
  onChange,
  disabled,
  placeholder,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <input
        type="number"
        min={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
      />
      {hint ? (
        <span className="text-[10px] text-ink-500">{hint}</span>
      ) : null}
    </label>
  );
}


/**
 * Catalogue-backed multi-select for a filtered slice of
 * ``raw_materials`` items (filtered by ``use_as``). Used by both
 * the gummy-base picker (``use_as ∈ (Sweeteners, Bulking Agent)``)
 * and the Flavouring and Colour picker (``use_as = 'Flavouring
 * and Colour'``). Callers pass their own labels + hints so the
 * surface reads natively for each picker's context.
 *
 * ``preselected`` items are merged into the option list even when
 * outside the paginated window (e.g. a legacy pick that's since
 * been archived or renamed), so the checkbox keeps showing as
 * active and the scientist can opt out explicitly.
 */
function CatalogueMultiPicker({
  orgId,
  value,
  preselected,
  disabled,
  useAsIn,
  itemTypesIn,
  label,
  placeholderText,
  hint,
  loadingText,
  emptyText,
  onChange,
  onPickedItemsChange,
  onMirrorError,
}: {
  orgId: string;
  value: readonly string[];
  preselected: readonly GummyBaseItemDto[];
  disabled?: boolean;
  useAsIn: readonly string[];
  /** PSP-side item_type filter. Defaults to ``["raw_material"]``
   *  since most excipient pickers (carrier / anti-caking / flavour
   *  / colour / …) source from that catalogue. The capsule shell
   *  picker overrides to ``["packaging"]`` because empty shells
   *  are packaging by industry convention. Local-only mode is
   *  unaffected — the ``useInfiniteItems`` query is already
   *  scoped to the ``raw_materials`` catalogue by slug. */
  itemTypesIn?: readonly string[];
  label: string;
  placeholderText: string;
  hint: string;
  loadingText: string;
  emptyText: string;
  onChange: (ids: readonly string[]) => void;
  /** Optional error surface for PSP mirror failures. Called with
   *  the raw ``ApiError`` so the host can pipe it into whatever
   *  banner / toast it already renders. Falls back to
   *  ``console.error`` inside the picker when unset — silent
   *  failures are the worst possible UX here. */
  onMirrorError?: (err: unknown) => void;
  /** Optional side-channel that emits ``{id, name, attributes?}`` for
   *  the items currently checked, sourced from the picker's own
   *  merged list (fetched + preselected). Lets the parent render
   *  picked-name brackets in the totals panel without waiting for a
   *  save round-trip to refresh the server-side ``formulation.*_items``
   *  echo. ``attributes`` is the catalogue item's full dynamic-field
   *  map and is populated for picks resolved against the fetched
   *  page; preselected-only picks (which the picker keeps visible by
   *  id only when they're outside the search page) emit without
   *  attributes -- callers can fall back to the server echo for those. */
  onPickedItemsChange?: (
    items: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      /** Catalogue SKU. Empty when the underlying item carries
       *  no code (PSP-mirrored rows that lack an ``external_sku``).
       *  Consumers that display procurement codes fall back to
       *  ``""`` — the BOM shows a ``—`` in the CODE column. */
      readonly internal_code: string;
      /** PSP UUID this local id mirrors, when known — either from the
       *  preselected ``GummyBaseItemDto.psp_source_uuid`` (saved
       *  picks) or from the ``pspToLocal`` reverse lookup on a
       *  freshly-clicked PSP row. ``null`` on legacy local-only
       *  picks that were never mirrored. */
      readonly psp_source_uuid: string | null;
      readonly attributes?: Readonly<Record<string, unknown>>;
    }>,
  ) => void;
}) {
  // Same "PSP powers the picker" pattern as the main active-
  // ingredient picker: when the integration is live, source
  // options from PSP instead of the local catalogue. Each check-
  // click mirrors the PSP row into the org's local
  // ``psp_mirror`` catalogue and pushes the returned local id
  // into ``value`` — the parent form stays local-id-only, and
  // legacy formulations that already have local ids in
  // ``preselected`` keep rendering exactly as before.
  const organization = useOrganization(orgId);
  const pspLive = Boolean(organization?.psp_live);

  const localQuery = useInfiniteItems(orgId, RAW_MATERIALS_SLUG, {
    includeArchived: false,
    ordering: "name",
    pageSize: 50,
    useAsIn,
  });

  const pspQuery = usePspItems(orgId, {
    enabled: pspLive,
    itemTypes: itemTypesIn ?? ["raw_material"],
    // PSP's ``use_as`` filter accepts a comma-separated list
    // (``feat(integration): accept comma-separated use_as on
    // /items`` on PSP side). Sorted for stable cache keys.
    useAs: [...useAsIn].sort().join(","),
  });

  const mirrorPsp = useMirrorPspItem(orgId);

  // Local cache of PSP UUID → mirrored local Item so a check-
  // click reconciles the option row's ``id`` with the local
  // ``value`` array on subsequent renders. Without this, a
  // freshly-mirrored row would flicker unchecked because the
  // PSP row's synthetic ``psp:<uuid>`` id doesn't match the
  // local id that ``onChange`` just pushed into ``value``.
  const [pspToLocal, setPspToLocal] = useState<
    Record<string, {
      readonly id: string;
      readonly name: string;
      readonly internal_code: string;
      readonly attributes: Readonly<Record<string, unknown>>;
    }>
  >(() => {
    // Prime from ``preselected`` on mount so refreshing the page
    // doesn't lose the checked state on PSP-mirrored picks. Each
    // preselected item carries ``psp_source_uuid`` (populated on
    // the server for rows that came from the mirror); we key the
    // cache by that PSP UUID so when the PSP fetch later returns
    // options as ``psp:<uuid>``, the merged list swaps in the
    // known local id and ``selected.has(local-id)`` fires.
    const seed: Record<
      string,
      {
        id: string;
        name: string;
        internal_code: string;
        attributes: Readonly<Record<string, unknown>>;
      }
    > = {};
    for (const p of preselected) {
      const pspUuid = (p as { psp_source_uuid?: string | null }).psp_source_uuid;
      if (!pspUuid) continue;
      seed[pspUuid] = {
        id: p.id,
        name: p.name,
        internal_code: p.internal_code,
        // No attributes on the echo shape; leave empty. The
        // ``attributesFromItem`` fallback used elsewhere reads
        // from a wider source; picker rendering doesn't need it.
        attributes: {},
      };
    }
    return seed;
  });

  const fetched: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly internal_code: string;
    readonly attributes?: Readonly<Record<string, unknown>>;
  }> = pspLive
    ? (pspQuery.data?.items ?? []).map((row) => {
        const cached = pspToLocal[row.uuid];
        // Once we've mirrored a PSP row, render its option with
        // the local id so ``selected.has(item.id)`` picks it up.
        if (cached) {
          return {
            id: cached.id,
            name: cached.name,
            internal_code: cached.internal_code,
            attributes: cached.attributes,
          };
        }
        return {
          id: `psp:${row.uuid}`,
          name: row.name,
          internal_code: row.code || row.external_sku,
          attributes: row.attributes,
        };
      })
    : (localQuery.data?.pages.flatMap((p) => p.results) ?? []);

  const knownIds = new Set(fetched.map((i) => i.id));
  const merged = [
    ...fetched,
    ...preselected
      .filter((p) => !knownIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.name,
        internal_code: p.internal_code,
      })),
  ];

  const selected = new Set(value);
  // Ref that always reflects the *current* ``value`` array. The
  // mirror mutation's ``onSuccess`` fires asynchronously — if the
  // scientist rapid-clicks multiple PSP options, each success
  // callback captures the ``value`` snapshot from its click
  // moment, so the second success overwrites the first's write
  // (stale-closure race). Reading through the ref inside the
  // callback picks up the latest ``value`` including any peer
  // toggles that landed in the meantime, so all picks accumulate.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  });
  // Pin the latest callback in a ref so the sync effect's dep list
  // depends only on the data, not on the callback's identity. Parent
  // components typically pass an inline arrow that gets a fresh
  // identity on every render -- including the identity in the deps
  // would re-fire the effect, which calls ``setState`` on the parent,
  // which re-renders, which produces a new arrow, ad infinitum.
  const onPickedRef = useRef<typeof onPickedItemsChange>(onPickedItemsChange);
  useEffect(() => {
    onPickedRef.current = onPickedItemsChange;
  }, [onPickedItemsChange]);
  // Keep the parent's picked-name cache in sync with what the picker
  // shows. Fires whenever ``value`` or ``merged`` changes so the
  // first paint after the catalogue page resolves still backfills the
  // bracket copy for already-checked rows.
  const valueKey = value.join(",");
  const mergedKey = merged.map((i) => `${i.id}:${i.name}`).join("|");
  useEffect(() => {
    const cb = onPickedRef.current;
    if (!cb) return;
    // Build a lookup that carries the full item shape (including the
    // dynamic ``attributes`` map for items resolved off the fetched
    // page). Preselected-only entries lack attributes -- consumers
    // that rely on attribute values for live math fall back to the
    // server echo for those ids.
    const lookup = new Map<
      string,
      {
        name: string;
        internal_code: string;
        attributes?: Readonly<Record<string, unknown>>;
      }
    >(
      merged.map((i) => [
        i.id,
        {
          name: i.name,
          internal_code: i.internal_code ?? "",
          attributes: (i as { attributes?: Readonly<Record<string, unknown>> })
            .attributes,
        },
      ]),
    );
    // Reverse lookup: local-id → PSP UUID. Preselected picks carry
    // their PSP identity on ``psp_source_uuid``; freshly-clicked PSP
    // rows populate ``pspToLocal[psp-uuid] = { id: local-id, ... }``
    // on mirror success — invert it so the emit callback can hand
    // the parent the PSP uuid without a second round-trip.
    const localIdToPspUuid = new Map<string, string>();
    for (const p of preselected) {
      const uuid = (p as { psp_source_uuid?: string | null }).psp_source_uuid;
      if (uuid && p.id) localIdToPspUuid.set(p.id, uuid);
    }
    for (const [pspUuid, cached] of Object.entries(pspToLocal)) {
      if (cached?.id) localIdToPspUuid.set(cached.id, pspUuid);
    }
    const picked = value
      .map((id) => {
        const hit = lookup.get(id);
        const pspUuid = localIdToPspUuid.get(id) ?? null;
        return hit
          ? {
              id,
              name: hit.name,
              internal_code: hit.internal_code,
              psp_source_uuid: pspUuid,
              attributes: hit.attributes,
            }
          : {
              id,
              name: "",
              internal_code: "",
              psp_source_uuid: pspUuid,
            };
      })
      .filter((entry) => entry.name !== "");
    cb(picked);
    // We intentionally depend on the stringified value + merged
    // shapes so structural changes drive the effect, not the array
    // identities (which churn on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey, mergedKey]);

  const toggle = (id: string) => {
    // PSP option that hasn't mirrored yet — mirror first, then
    // push the returned local id into ``value``. Uncheck of a
    // pre-mirrored PSP option lands in the ``next.has(id)`` /
    // ``next.delete(id)`` branch below because by then the row's
    // ``id`` is already the local id (via ``pspToLocal``).
    if (id.startsWith("psp:")) {
      const pspUuid = id.slice("psp:".length);
      mirrorPsp.mutate(pspUuid, {
        onError: (err) => {
          // Surface via the parent-owned error banner if the host
          // wired one in — otherwise fall back to ``console.error``
          // so at least the browser devtools show the failure and
          // it doesn't disappear into silence.
          if (onMirrorError) {
            onMirrorError(err);
          } else if (typeof console !== "undefined") {
            console.error("PSP mirror failed", err);
          }
        },
        onSuccess: (dto) => {
          setPspToLocal((prev) => ({
            ...prev,
            [pspUuid]: {
              id: dto.id,
              name: dto.name,
              internal_code: dto.internal_code,
              attributes: dto.attributes,
            },
          }));
          // Read the latest ``value`` via ref — a peer toggle
          // that landed while this mirror was in flight already
          // committed its id, and we must merge with that not
          // overwrite it.
          const next = new Set(valueRef.current);
          next.add(dto.id);
          onChange([...next]);
        },
      });
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onChange([...next]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {/* Viewport-covering loader while any mirror round-trip is in
          flight. Mirrors the main ingredient-picker overlay so every
          excipient / carrier / shell picker gets the same blocking
          feedback — clicks can't queue up while PSP resolves. */}
      {mirrorPsp.isPending ? (
        <div
          className="pointer-events-auto fixed inset-0 z-[999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="status"
          aria-live="assertive"
          style={{ position: "fixed" }}
        >
          <div className="flex min-w-[320px] flex-col items-center gap-4 rounded-2xl bg-white px-8 py-6 shadow-2xl ring-1 ring-black/10">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-orange-100">
              <Loader2 className="h-10 w-10 animate-spin text-orange-500" />
            </div>
            <div className="text-center">
              <p className="text-base font-semibold text-ink-1000">
                Adding {label.toLowerCase()}…
              </p>
              <p className="mt-1 text-xs text-ink-600">
                Waiting for PSP so this pick lands cleanly.
              </p>
            </div>
          </div>
        </div>
      ) : null}
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <div
        className={`flex max-h-56 flex-col overflow-y-auto rounded-xl bg-ink-0 ring-1 ring-inset ring-ink-200 ${
          disabled ||
          mirrorPsp.isPending ||
          (pspLive ? pspQuery.isLoading : localQuery.isLoading)
            ? "opacity-60"
            : ""
        }`}
      >
        {merged.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-500">
            {(pspLive ? pspQuery.isLoading : localQuery.isLoading)
              ? loadingText
              : emptyText}
          </p>
        ) : (
          merged.map((item) => {
            const checked = selected.has(item.id);
            const mirroring =
              item.id.startsWith("psp:") &&
              mirrorPsp.isPending &&
              mirrorPsp.variables === item.id.slice("psp:".length);
            // Lock EVERY checkbox in the list while any mirror is
            // in flight — belt-and-braces with the fixed overlay
            // above, so a fast operator can't fire a second pick
            // in the ms before the modal paints and traps clicks.
            const rowLocked = mirrorPsp.isPending;
            return (
              <label
                key={item.id}
                className={`flex items-center gap-2 border-b border-ink-100 px-3 py-2 text-sm last:border-b-0 ${
                  checked
                    ? "bg-orange-50 text-ink-1000"
                    : "text-ink-700 hover:bg-ink-50"
                } ${rowLocked ? "cursor-not-allowed" : "cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || mirroring || rowLocked}
                  onChange={() => toggle(item.id)}
                  className="h-4 w-4 cursor-pointer accent-orange-500 disabled:cursor-not-allowed"
                />
                <span className="flex-1">
                  {item.internal_code
                    ? `${item.name} (${item.internal_code})`
                    : item.name}
                </span>
              </label>
            );
          })
        )}
      </div>
      <span className="text-[11px] text-ink-500">{hint}</span>
    </div>
  );
}


// Canonical defaults for each gummy excipient band, decimal
// fractions (0.02 = 2%). Mirrors ``GUMMY_BAND_DEFAULT_PCT`` on
// the server. Used by the override panel to show the default next
// to each editable input. Each band carries its unit (decimal pct in
// 0..1 or mg-per-gram-of-powder) so the renderer knows how to format
// the input/suffix without a parallel lookup.
// ``pct`` is a plain fraction (0..1); the row displays/inputs it as
// a percentage (0.02 -> "2%"). ``pct_of_powder_weight`` is a special
// case for the powder flavour-system bands: the math stores the
// value as mg-per-gram-of-powder (62.5 mg/g), but the UI shows it
// to scientists as a percent of the total powder weight (6.25%) so
// every row in the panel reads in the same unit. Conversion factor:
// ``1 mg/g = 0.1%`` (since 1 g = 1000 mg).
type BandUnit =
  | "pct"
  | "pct_of_powder_weight"
  | "mg_per_ml_water"
  | "pct_of_total_weight_via_water";
const EXCIPIENT_BAND_DEFAULTS_UI = {
  // Gummy
  water: { default: 0.055, unit: "pct" as BandUnit },
  acidity: { default: 0.02, unit: "pct" as BandUnit },
  flavouring: { default: 0.004, unit: "pct" as BandUnit },
  colour: { default: 0.02, unit: "pct" as BandUnit },
  glazing: { default: 0.001, unit: "pct" as BandUnit },
  gelling: { default: 0.03, unit: "pct" as BandUnit },
  premix_sweetener: { default: 0.06, unit: "pct" as BandUnit },
  // Anti-caking (capsule + tablet + powder)
  mg_stearate: { default: 0.01, unit: "pct" as BandUnit },
  silica: { default: 0.004, unit: "pct" as BandUnit },
  // Tablet carriers
  dcp: { default: 0.10, unit: "pct" as BandUnit },
  mcc: { default: 0.20, unit: "pct" as BandUnit },
  // Powder flavour-system bands. ``default`` is the mg-per-gram-of-
  // Powder Flavouring / Sweetener / Colour are no longer band-level
  // overrides. Each picked item carries its own per-gram-of-powder
  // rate on the catalogue (``powder_<band>_mg_per_g``) so the math
  // doses per pick. Acidity has always been per-item.
} as const;
type ExcipientBandKey = keyof typeof EXCIPIENT_BAND_DEFAULTS_UI;

/** Gummy-only band keys retained for the legacy GummyOverridesPanel
 *  call sites that still reference the type. Same shape, narrower. */
const GUMMY_BAND_DEFAULTS = {
  water: EXCIPIENT_BAND_DEFAULTS_UI.water.default,
  acidity: EXCIPIENT_BAND_DEFAULTS_UI.acidity.default,
  flavouring: EXCIPIENT_BAND_DEFAULTS_UI.flavouring.default,
  colour: EXCIPIENT_BAND_DEFAULTS_UI.colour.default,
  glazing: EXCIPIENT_BAND_DEFAULTS_UI.glazing.default,
  gelling: EXCIPIENT_BAND_DEFAULTS_UI.gelling.default,
  premix_sweetener: EXCIPIENT_BAND_DEFAULTS_UI.premix_sweetener.default,
} as const;
type GummyBandKey = keyof typeof GUMMY_BAND_DEFAULTS;


/** Inline panel under each picked active that exposes the three
 *  per-line override inputs. Catalogue values are shown as the
 *  placeholder; an empty input means "use the catalogue value".
 *
 *  Stays inline (no submit step) — typing into any field updates the
 *  builder's live math immediately and is persisted on the next
 *  Save / Save Version. */
function LineOverridesPanel({
  line,
  disabled,
  onChange,
  tFormulations,
}: {
  line: BuilderLine;
  disabled: boolean;
  onChange: (
    field: "purity_override" | "overage_override" | "extract_ratio_override",
    value: string,
  ) => void;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const formatPlaceholder = (
    value: string | number | null | undefined,
  ): string =>
    value === null || value === undefined || value === ""
      ? tFormulations("line_overrides.catalogue_blank")
      : String(value);
  const cataloguePurity = line.item_attributes.purity;
  const catalogueOverage = line.item_attributes.overage;
  const catalogueExtract = line.item_attributes.extract_ratio;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("line_overrides.title")}
        </p>
        <button
          type="button"
          disabled={
            disabled ||
            (line.purity_override === "" &&
              line.overage_override === "" &&
              line.extract_ratio_override === "")
          }
          onClick={() => {
            onChange("purity_override", "");
            onChange("overage_override", "");
            onChange("extract_ratio_override", "");
          }}
          className="text-[10px] font-medium uppercase tracking-wide text-ink-500 underline-offset-2 hover:text-ink-1000 hover:underline disabled:opacity-40 disabled:hover:no-underline"
        >
          {tFormulations("line_overrides.reset")}
        </button>
      </div>
      <p className="text-[11px] leading-snug text-ink-500">
        {tFormulations("line_overrides.hint")}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-[11px] text-ink-700">
          <span>{tFormulations("line_overrides.purity_label")}</span>
          <input
            type="text"
            inputMode="decimal"
            value={line.purity_override}
            disabled={disabled}
            placeholder={formatPlaceholder(cataloguePurity)}
            onChange={(e) => onChange("purity_override", e.target.value)}
            className="w-full rounded-xl bg-ink-0 px-3 py-1.5 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-ink-700">
          <span>{tFormulations("line_overrides.overage_label")}</span>
          <input
            type="text"
            inputMode="decimal"
            value={line.overage_override}
            disabled={disabled}
            placeholder={formatPlaceholder(catalogueOverage)}
            onChange={(e) => onChange("overage_override", e.target.value)}
            className="w-full rounded-xl bg-ink-0 px-3 py-1.5 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-ink-700">
          <span>{tFormulations("line_overrides.extract_label")}</span>
          <input
            type="text"
            inputMode="decimal"
            value={line.extract_ratio_override}
            disabled={disabled}
            placeholder={formatPlaceholder(catalogueExtract)}
            onChange={(e) =>
              onChange("extract_ratio_override", e.target.value)
            }
            className="w-full rounded-xl bg-ink-0 px-3 py-1.5 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50"
          />
        </label>
      </div>
    </div>
  );
}


/** Cross-dosage-form excipient overrides editor. Sits below the
 *  totals block and exposes one editable row per band that's
 *  applicable to the current dosage form + picker state. Persists
 *  via ``metadata.excipient_overrides`` so saving the formulation
 *  freezes the overrides into the next version snapshot.
 *
 *  Memoised so unrelated keystrokes don't redraw the 7-row panel. */
/** Per-item rate row presented to the override panel. ``defaultRate``
 *  is the catalogue value (what the math falls back to when there's
 *  no per-formulation override); ``band`` drives the row's heading
 *  copy. The panel resolves the effective value by merging the
 *  override map -- under the ``powder_rate:<id>`` key -- with this
 *  catalogue baseline. */
interface PerItemRateOverrideRow {
  readonly id: string;
  readonly label: string;
  readonly band: "acidity" | "flavouring" | "sweetener" | "colour";
  readonly defaultRate: number | null;
  /** Per-serving reconstitution water volume. Used (together with
   *  ``totalWeightMg``) to translate the stored mg/ml rate into the
   *  "% of finished powder mass" the override input displays. */
  readonly waterMl: number;
  /** Per-serving finished powder mass. Same role as ``waterMl`` --
   *  drives the percent / mg/ml conversion in the row. */
  readonly totalWeightMg: number;
}

const ExcipientOverridesPanel = memo(function ExcipientOverridesPanel({
  overrides,
  dosageForm,
  hasAntiCaking,
  hasDcpCarrier,
  hasMccCarrier,
  hasFlavouring,
  hasSweetener,
  hasColour,
  hasGelling,
  perItemRates = [],
  disabled,
  onChange,
  tFormulations,
}: {
  overrides: Readonly<Record<string, number>>;
  dosageForm: DosageForm;
  hasAntiCaking: boolean;
  hasDcpCarrier: boolean;
  hasMccCarrier: boolean;
  hasFlavouring: boolean;
  hasSweetener: boolean;
  hasColour: boolean;
  hasGelling: boolean;
  /** Per-item rate rows to render alongside the band-level overrides.
   *  Populated for powder formulations from the live picker caches +
   *  formulation echoes; empty for other dosage forms. */
  perItemRates?: readonly PerItemRateOverrideRow[];
  disabled: boolean;
  onChange: (next: Record<string, number>) => void;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  // Each entry pairs a band key with the picker-state predicate that
  // gates its visibility AND the basis copy that prints under the
  // label. The basis text explains WHAT the percentage / rate is
  // applied to so a scientist scanning a row knows whether "1%" means
  // "of actives", "of total weight", or "per gram of powder" without
  // having to memorise dosage-form conventions.
  const BAND_VISIBILITY: ReadonlyArray<{
    readonly key: ExcipientBandKey;
    readonly labelKey: string;
    readonly basisKey: string;
    readonly forms: ReadonlyArray<DosageForm>;
    readonly visible: boolean;
  }> = [
    // Anti-caking. On capsule/tablet the % is taken against total
    // actives; on powder it's % of total finished powder weight.
    {
      key: "mg_stearate",
      labelKey: "overrides.mg_stearate",
      basisKey:
        dosageForm === "powder"
          ? "overrides.basis.of_powder_weight"
          : "overrides.basis.of_actives",
      forms: ["capsule", "tablet", "powder"],
      visible: hasAntiCaking,
    },
    {
      key: "silica",
      labelKey: "overrides.silica",
      basisKey:
        dosageForm === "powder"
          ? "overrides.basis.of_powder_weight"
          : "overrides.basis.of_actives",
      forms: ["capsule", "tablet", "powder"],
      visible: hasAntiCaking,
    },
    // Tablet-only carrier ratios (% of total actives).
    {
      key: "dcp",
      labelKey: "overrides.dcp",
      basisKey: "overrides.basis.of_actives",
      forms: ["tablet"],
      visible: hasDcpCarrier,
    },
    {
      key: "mcc",
      labelKey: "overrides.mcc",
      basisKey: "overrides.basis.of_actives",
      forms: ["tablet"],
      visible: hasMccCarrier,
    },
    // Powder Flavouring / Sweetener / Colour no longer surface
    // here -- their rates moved to per-item catalogue attributes
    // (``powder_<band>_mg_per_g``) and a per-formulation band
    // override no longer makes sense when each pick carries its
    // own loading. Scientists edit the rate on the raw material
    // row in the Raw Materials catalogue instead.

    // Gummy bands (% of target gummy weight).
    {
      key: "water",
      labelKey: "overrides.water",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: true,
    },
    {
      key: "acidity",
      labelKey: "overrides.acidity",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: true,
    },
    {
      key: "flavouring",
      labelKey: "overrides.flavouring",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: true,
    },
    {
      key: "colour",
      labelKey: "overrides.colour",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: true,
    },
    {
      key: "glazing",
      labelKey: "overrides.glazing",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: true,
    },
    {
      key: "gelling",
      labelKey: "overrides.gelling",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: hasGelling,
    },
    {
      key: "premix_sweetener",
      labelKey: "overrides.premix_sweetener",
      basisKey: "overrides.basis.of_target",
      forms: ["gummy"],
      visible: hasGelling,
    },
  ];

  const visible = BAND_VISIBILITY.filter(
    (b) => b.forms.includes(dosageForm) && b.visible,
  );
  // Whether this dosage form has ANY override-eligible bands at all.
  // Liquid / other_solid currently have none -- on those forms the
  // panel still hides entirely. Solid forms always render even when
  // every picker is empty so the scientist sees the surface exists.
  const formHasAnyBands = BAND_VISIBILITY.some((b) =>
    b.forms.includes(dosageForm),
  );
  if (!formHasAnyBands) return null;

  const hasAny = Object.keys(overrides).length > 0;

  return (
    <div className="mt-4 rounded-2xl border border-dashed border-ink-200 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("overrides.title")}
        </p>
        {hasAny && !disabled ? (
          <button
            type="button"
            onClick={() => onChange({})}
            className="text-[10px] font-medium uppercase tracking-wide text-ink-500 underline-offset-2 hover:text-ink-1000 hover:underline"
          >
            {tFormulations("overrides.reset_all")}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-ink-500">
        {tFormulations("overrides.hint")}
      </p>
      {visible.length === 0 && perItemRates.length === 0 ? (
        <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[11px] leading-snug text-ink-500">
          {tFormulations("overrides.empty_hint")}
        </p>
      ) : null}
      <ul className="mt-3 flex flex-col gap-2">
        {visible.map((band) => {
          const spec = EXCIPIENT_BAND_DEFAULTS_UI[band.key];
          return (
            <BandOverrideRow
              key={band.key}
              label={tFormulations(band.labelKey as "overrides.water")}
              basis={tFormulations(
                band.basisKey as "overrides.basis.of_target",
              )}
              defaultValue={spec.default}
              unit={spec.unit}
              override={overrides[band.key]}
              disabled={disabled}
              onChange={(value) => {
                const next = { ...overrides };
                if (value === null) {
                  delete next[band.key];
                } else {
                  next[band.key] = value;
                }
                onChange(next);
              }}
            />
          );
        })}
      </ul>
      {perItemRates.length > 0 ? (
        // Per-pick rate rows live under their own section so the
        // band-level percentages above stay visually grouped. Each
        // row stores its override in mg/ml under
        // ``powder_rate:<id>`` BUT the input is rendered as a
        // percent of the finished powder mass so it matches the
        // "(X%)" column in the Excipients panel. The conversion
        // context (water_ml + total_weight_mg) is supplied per row
        // by the parent and threaded through to ``BandOverrideRow``.
        <div className="mt-4 border-t border-dashed border-ink-200 pt-3">
          <p className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("overrides.per_item_title")}
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {perItemRates.map((row) => {
              const overrideKey = `powder_rate:${row.id}`;
              return (
                <BandOverrideRow
                  key={overrideKey}
                  label={row.label}
                  basis={tFormulations(
                    `overrides.per_item_basis.${row.band}` as "overrides.per_item_basis.acidity",
                  )}
                  defaultValue={row.defaultRate ?? 0}
                  unit="pct_of_total_weight_via_water"
                  conversion={
                    row.waterMl > 0 && row.totalWeightMg > 0
                      ? {
                          waterMl: row.waterMl,
                          totalWeightMg: row.totalWeightMg,
                        }
                      : undefined
                  }
                  override={overrides[overrideKey]}
                  disabled={disabled}
                  onChange={(value) => {
                    const next = { ...overrides };
                    if (value === null) {
                      delete next[overrideKey];
                    } else {
                      next[overrideKey] = value;
                    }
                    onChange(next);
                  }}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
});


/** Legacy wrapper kept so any in-flight reference still resolves.
 *  New callers should use :func:`ExcipientOverridesPanel`. */
function GummyOverridesPanel({
  overrides,
  gellingPicked,
  disabled,
  onChange,
  tFormulations,
}: {
  overrides: Readonly<Record<string, number>>;
  gellingPicked: boolean;
  disabled: boolean;
  onChange: (next: Record<string, number>) => void;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  // Bands the panel surfaces, in display order. Gelling and Premix
  // Sweetener only show up when the scientist has actually picked a
  // gelling agent — empty pick means a non-gelling gummy and the
  // bands are skipped throughout the math, so the editor follows.
  const BANDS: ReadonlyArray<{
    readonly key: GummyBandKey;
    readonly labelKey: string;
    readonly gellingDependent: boolean;
  }> = [
    { key: "water", labelKey: "overrides.water", gellingDependent: false },
    { key: "acidity", labelKey: "overrides.acidity", gellingDependent: false },
    {
      key: "flavouring",
      labelKey: "overrides.flavouring",
      gellingDependent: false,
    },
    { key: "colour", labelKey: "overrides.colour", gellingDependent: false },
    { key: "glazing", labelKey: "overrides.glazing", gellingDependent: false },
    { key: "gelling", labelKey: "overrides.gelling", gellingDependent: true },
    {
      key: "premix_sweetener",
      labelKey: "overrides.premix_sweetener",
      gellingDependent: true,
    },
  ];

  const visible = BANDS.filter(
    (b) => !b.gellingDependent || gellingPicked,
  );
  const hasAny = Object.keys(overrides).length > 0;

  return (
    <div className="mt-4 rounded-2xl border border-dashed border-ink-200 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("overrides.title")}
        </p>
        {hasAny && !disabled ? (
          <button
            type="button"
            onClick={() => onChange({})}
            className="text-[10px] font-medium uppercase tracking-wide text-ink-500 underline-offset-2 hover:text-ink-1000 hover:underline"
          >
            {tFormulations("overrides.reset_all")}
          </button>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-ink-500">
        {tFormulations("overrides.hint")}
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {visible.map((band) => (
          <BandOverrideRow
            key={band.key}
            label={tFormulations(
              band.labelKey as "overrides.water",
            )}
            defaultValue={GUMMY_BAND_DEFAULTS[band.key]}
            unit="pct"
            override={overrides[band.key]}
            disabled={disabled}
            onChange={(value) => {
              const next = { ...overrides };
              if (value === null) {
                delete next[band.key];
              } else {
                next[band.key] = value;
              }
              onChange(next);
            }}
          />
        ))}
      </ul>
    </div>
  );
}


function BandOverrideRow({
  label,
  basis,
  defaultValue,
  unit = "pct",
  override,
  disabled,
  onChange,
  conversion,
}: {
  label: string;
  /** Short subtitle clarifying what the value is applied to
   *  ("of total active mg", "for every gram of finished powder",
   *  etc.). Rendered as a small caption under the label so the
   *  numeric unit on the right of the input ("%" or "mg/g") is
   *  unambiguous. Optional -- legacy gummy callers may omit it. */
  basis?: string;
  /** Default value in the band's native unit (decimal pct for ``pct``,
   *  mg/g of powder for ``mg_per_g``). */
  defaultValue: number;
  unit?: BandUnit;
  override: number | undefined;
  disabled: boolean;
  onChange: (value: number | null) => void;
  /** Conversion context required for units that depend on
   *  formulation-level numbers (currently only
   *  ``pct_of_total_weight_via_water``, which translates between
   *  stored mg/ml and the % of finished powder weight the
   *  Excipients column shows). When the context is missing or zero
   *  the row falls back to mg/ml mode so the scientist can still
   *  edit the raw rate. */
  conversion?: {
    readonly waterMl: number;
    readonly totalWeightMg: number;
  };
}) {
  // Resolve the effective unit: ``pct_of_total_weight_via_water``
  // requires the conversion context; without it we silently fall
  // back to mg/ml so the input is never frozen on a formulation
  // missing water volume / target weight.
  const conversionUsable =
    unit === "pct_of_total_weight_via_water" &&
    !!conversion &&
    conversion.waterMl > 0 &&
    conversion.totalWeightMg > 0;
  const effectiveUnit: BandUnit =
    unit === "pct_of_total_weight_via_water" && !conversionUsable
      ? "mg_per_ml_water"
      : unit;
  // Display / storage unit conversion. Four shapes:
  //
  // * ``pct``                              : storage is a fraction in 0..1;
  //                                          display is the percentage.
  // * ``pct_of_powder_weight``             : storage is mg-per-gram-of-powder;
  //                                          display is % of total powder
  //                                          weight (1 mg/g = 0.1%).
  // * ``mg_per_ml_water``                  : storage = display (mg/ml).
  // * ``pct_of_total_weight_via_water``    : storage is mg/ml of water;
  //                                          display is % of finished powder
  //                                          mass per serving. Conversion:
  //                                          ``pct = (mg_per_ml × water_ml /
  //                                          total_weight_mg) × 100``.
  const toDisplay = (value: number): string => {
    if (effectiveUnit === "pct") return (value * 100).toString();
    if (effectiveUnit === "mg_per_ml_water") return String(value);
    if (effectiveUnit === "pct_of_total_weight_via_water" && conversion) {
      const pct =
        (value * conversion.waterMl) / conversion.totalWeightMg;
      return (pct * 100).toString();
    }
    return (value / 10).toString();
  };
  const fromDisplay = (typed: number): number => {
    if (effectiveUnit === "pct") return typed / 100;
    if (effectiveUnit === "mg_per_ml_water") return typed;
    if (effectiveUnit === "pct_of_total_weight_via_water" && conversion) {
      // Inverse: stored mg/ml = (% / 100) × total_weight / water_ml.
      return (
        ((typed / 100) * conversion.totalWeightMg) / conversion.waterMl
      );
    }
    return typed * 10;
  };
  const effective = override ?? defaultValue;
  const [draft, setDraft] = useState<string>(toDisplay(effective));
  // Keep ``draft`` synced when ``override`` changes externally
  // (parent reset, version load, etc.). Avoids stale text after
  // ``Reset all``.
  useEffect(() => {
    setDraft(toDisplay(effective));
    // ``conversion`` is folded into the dep list as its numeric
    // members so a water-volume edit on the formulation flushes the
    // displayed percent through the new ratio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    effective,
    effectiveUnit,
    conversion?.waterMl,
    conversion?.totalWeightMg,
  ]);

  // Upper bound (in display units). Percentages cap at 100% across
  // the board. mg-per-ml rates cap at 1000 -- way above any
  // chemically sensible loading; lets a typo surface as a hard
  // rejection rather than a silent truncation.
  const upperBound = effectiveUnit === "mg_per_ml_water" ? 1000 : 100;

  const commit = (raw: string) => {
    const trimmed = raw.replace(",", ".").trim();
    if (!trimmed) {
      onChange(null);
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > upperBound) {
      setDraft(toDisplay(effective));
      return;
    }
    const asStorage = fromDisplay(parsed);
    // No-op when the typed value matches the default — clear the
    // override so the field falls back instead of locking in the
    // baseline value.
    const tolerance = effectiveUnit === "pct" ? 1e-6 : 1e-4;
    if (Math.abs(asStorage - defaultValue) < tolerance) {
      onChange(null);
    } else {
      onChange(asStorage);
    }
  };

  const isOverridden = override !== undefined;
  return (
    <li className="flex items-center justify-between gap-3 text-xs">
      <span className="flex min-w-0 flex-col text-ink-700">
        <span className="flex items-center gap-1.5">
          <span>{label}</span>
          {isOverridden ? (
            <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-orange-700">
              ●
            </span>
          ) : null}
        </span>
        {basis ? (
          <span className="text-[10px] text-ink-500">{basis}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-16 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
        />
        <span className="text-ink-500">
          {effectiveUnit === "mg_per_ml_water" ? "mg/ml" : "%"}
        </span>
        {isOverridden && !disabled ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[10px] font-medium text-ink-500 hover:text-ink-1000"
            title="Reset to default"
          >
            ↺
          </button>
        ) : null}
      </span>
    </li>
  );
}


// Canonical categories the two pickers filter on. Kept in sync with
// their server-side counterparts on ``apps.formulations.constants``
// — short enough to hardcode without a per-request round-trip to an
// enum endpoint.
const GUMMY_BASE_USE_CATEGORIES = ["Sweeteners", "Bulking Agent"] as const;
const FLAVOURING_USE_CATEGORIES = ["Flavouring"] as const;
// Colour picker also surfaces ``Flavouring`` items because most
// flavour SKUs in the reference catalogue double as colourants
// (beetroot, turmeric, spirulina) — scientists pick them under
// whichever band they want the mg allocated to. Mirrors
// ``COLOUR_USE_CATEGORIES`` on the server.
const COLOUR_USE_CATEGORIES = ["Colour", "Flavouring"] as const;
// Powder sweetener picker pulls from pure ``Sweeteners`` only —
// bulking agents are deliberately excluded (the powder sweetener row
// is a flavour-facing pick, not the structural bulk a gummy base
// provides). Mirrors ``SWEETENER_USE_CATEGORIES`` on the server.
const SWEETENER_USE_CATEGORIES = ["Sweeteners"] as const;
const GLAZING_USE_CATEGORIES = ["Glazing Agent"] as const;
const GELLING_USE_CATEGORIES = ["Gelling Agent"] as const;
const ACIDITY_USE_CATEGORIES = ["Acidity Regulator"] as const;
// Capsule + tablet carrier picker (originally MCC-branded; the picker
// is generic now). Accepts both ``Carrier`` (canonical EU 1169/2011)
// and ``Bulking Agent`` (the historical tag scientists used for MCC)
// so legacy catalogue rows keep flowing through without retagging.
const CAPSULE_SHELL_USE_CATEGORIES = ["Capsule Shell"] as const;
const MCC_CARRIER_USE_CATEGORIES = ["Carrier", "Bulking Agent"] as const;
// Tablet DCP carrier picker. Mirrors the carrier picker on the server
// today (``DCP_CARRIER_USE_CATEGORIES``); kept as a separate constant
// so a future split (e.g. a dedicated DCP ``use_as``) lands here too.
const DCP_CARRIER_USE_CATEGORIES = ["Carrier", "Bulking Agent"] as const;
// Anti-caking picker for capsules + tablets. Optional: empty picker
// drops the Stearate + Silica band from the formulation entirely.
const ANTI_CAKING_USE_CATEGORIES = ["Anti-caking Agent"] as const;


function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { readonly value: string; readonly label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}


function TextAreaField({
  label,
  value,
  onChange,
  disabled,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 md:col-span-2">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <textarea
        rows={2}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
      />
      {hint ? (
        <span className="text-[10px] text-ink-500">{hint}</span>
      ) : null}
    </label>
  );
}


/**
 * Collapse gummy-base rows into one grouped entry per ``useAs``
 * category. Given three rows with ``useAs == "Sweeteners"`` it
 * produces a single ``{label: "Sweeteners (Xylitol, Maltitol,
 * Erythritol)", mg: <sum>}`` entry — EU 1169/2011 label convention,
 * matching the ingredient declaration builder on the backend. Rows
 * without a ``useAs`` land on a fallback group under their own
 * label so un-tagged picks still render.
 */
function groupRowsByUseAs(
  rows: readonly {
    readonly itemId: string;
    readonly label: string;
    readonly useAs: string;
    readonly mg: number;
  }[],
): readonly { readonly useAs: string; readonly label: string; readonly mg: number }[] {
  const groups = new Map<
    string,
    { useAs: string; labels: string[]; mg: number }
  >();
  for (const row of rows) {
    const key = row.useAs || row.label;
    const existing = groups.get(key);
    if (existing) {
      existing.labels.push(row.label);
      existing.mg += row.mg;
    } else {
      groups.set(key, {
        useAs: row.useAs,
        labels: [row.label],
        mg: row.mg,
      });
    }
  }
  return Array.from(groups.values()).map((g) => ({
    useAs: g.useAs,
    label: g.useAs ? `${g.useAs} (${g.labels.join(", ")})` : g.labels.join(", "),
    mg: g.mg,
  }));
}


/**
 * Collapse gummy flavouring / colour / glazing rows in the generic
 * ``excipients.rows`` list into one grouped entry per category,
 * leaving every other row (acidity, powder flavour rows) untouched.
 * Slugs prefixed with ``flavouring:``, ``colour:`` and ``glazing:``
 * get recognised and combined; each combined label reads as e.g.
 * ``"Flavouring (Natural Strawberry, Lemon Extract)"`` — the EU
 * label convention mirrored on both totals panel and spec sheet.
 */
function groupGummyFlavourRows(
  rows: readonly {
    readonly slug: string;
    readonly label: string;
    readonly mg: number;
    readonly isRemainder: boolean;
    readonly concentrationMgPerGPowder?: number | null;
    readonly concentrationMgPerMlWater?: number | null;
  }[],
  dosageForm: DosageForm,
): readonly {
  readonly slug: string;
  readonly label: string;
  readonly mg: number;
  readonly isRemainder: boolean;
  readonly concentrationMgPerGPowder?: number | null;
  readonly concentrationMgPerMlWater?: number | null;
}[] {
  // Each entry collapses every row whose slug starts with one of
  // ``prefixes`` into a single grouped entry. ``gelling:`` and
  // ``premix_sweetener:`` share one entry — the "Pectin Premix" —
  // so the totals panel matches the procurement BOM (where the
  // premix is one in-house SKU).
  //
  // ``hideComponents`` suppresses the bracketed component list on
  // a group. Set on Pectin Premix because its components are sweet
  // -ners typically shared with the gummy base — listing them
  // inside the brackets would render the same sweetener twice on
  // screen (once under Gummy Base and once inside Pectin Premix
  // (Maltitol)). The premix stays one atomic in-house line.
  // Powder acidity rows dose per item — Trisodium Citrate at one
  // rate, Citric / Malic Acid at another — driven by each catalogue
  // item's ``powder_water_dose_mg_per_ml`` attribute. Collapsing them
  // into a single "Acidity Regulator" line would hide the per-item
  // rates from the scientist, so we leave powder acidity rows
  // ungrouped and only collapse the gummy variant (which still
  // splits a single mg total across picks).
  const isPowder = dosageForm === "powder";
  const GROUPINGS: readonly {
    readonly prefixes: readonly string[];
    readonly combinedSlug: string;
    readonly heading: string;
    readonly hideComponents?: boolean;
  }[] = [
    ...(isPowder
      ? []
      : [
          {
            prefixes: ["acidity:"] as readonly string[],
            combinedSlug: "acidity:__combined",
            heading: "Acidity Regulator",
          },
        ]),
    {
      prefixes: ["flavouring:"],
      combinedSlug: "flavouring:__combined",
      heading: "Flavouring",
    },
    {
      prefixes: ["sweetener:"],
      combinedSlug: "sweetener:__combined",
      heading: "Sweeteners",
    },
    {
      prefixes: ["colour:"],
      combinedSlug: "colour:__combined",
      heading: "Colour",
    },
    {
      prefixes: ["glazing:"],
      combinedSlug: "glazing:__combined",
      heading: "Glazing Agent",
    },
    {
      prefixes: ["gelling:", "premix_sweetener:"],
      combinedSlug: "pectin_premix:__combined",
      heading: "Pectin Premix",
      hideComponents: true,
    },
    {
      prefixes: ["anti_caking:"],
      combinedSlug: "anti_caking:__combined",
      heading: "Anti-caking Agents",
    },
    {
      prefixes: ["carrier:"],
      combinedSlug: "carrier:__combined",
      heading: "Carrier",
    },
  ];

  const output: typeof rows[number][] = [];
  const remaining = [...rows];

  for (const group of GROUPINGS) {
    const members = remaining.filter((r) =>
      group.prefixes.some((prefix) => r.slug.startsWith(prefix)),
    );
    // Strip matched rows in-place so the leftover pass below only
    // sees the rows we haven't claimed yet.
    for (const m of members) {
      const idx = remaining.indexOf(m);
      if (idx >= 0) remaining.splice(idx, 1);
    }
    if (members.length === 0) continue;
    const combinedMg = members.reduce((acc, r) => acc + r.mg, 0);
    if (group.hideComponents) {
      output.push({
        slug: group.combinedSlug,
        label: group.heading,
        mg: combinedMg,
        isRemainder: false,
        concentrationMgPerGPowder: null,
      });
      continue;
    }
    // Dedupe by label so an item picked under multiple slugs in
    // the same band renders once with the summed mg — mirrors the
    // EU 1169 declaration.
    const labelOrder: string[] = [];
    const seen = new Set<string>();
    for (const m of members) {
      if (!seen.has(m.label)) {
        seen.add(m.label);
        labelOrder.push(m.label);
      }
    }
    output.push({
      slug: group.combinedSlug,
      label:
        labelOrder.length === 1
          ? `${group.heading} (${labelOrder[0]})`
          : `${group.heading} (${labelOrder.join(", ")})`,
      mg: combinedMg,
      isRemainder: false,
      concentrationMgPerGPowder: null,
    });
  }
  // Untouched rows (powder flavour entries, etc.) pass through
  // first so the visual order stays predictable on a gummy panel.
  return [...remaining, ...output];
}


function sanitizeDecimalInput(raw: string): string {
  let value = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const firstDot = value.indexOf(".");
  if (firstDot !== -1) {
    value =
      value.slice(0, firstDot + 1) +
      value.slice(firstDot + 1).replace(/\./g, "");
  }
  // Backend DecimalField stores 4 decimal places (matches the
  // workbook's mg/serving precision), so the UI lets the scientist
  // type up to 4. Anything beyond is silently truncated rather than
  // rounded so a half-typed ``0.12345`` doesn't snap to ``0.1235``
  // mid-keystroke.
  const dot = value.indexOf(".");
  if (dot !== -1 && value.length - dot - 1 > 4) {
    value = value.slice(0, dot + 5);
  }
  return value;
}
