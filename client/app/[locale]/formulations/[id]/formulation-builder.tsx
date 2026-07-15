"use client";

import { Button } from "@heroui/react";
import { Check, Copy, CopyPlus, Save, ShieldCheck, Sliders, Trash2 } from "lucide-react";

import { DuplicateFormulationModal } from "./duplicate-formulation-modal";
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

import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { clientUuid } from "@/lib/utils";
import { useInfiniteItems } from "@/services/catalogues";
import type { ItemDto } from "@/services/catalogues/types";
import { useOrganization } from "@/services/organizations";
import { useMirrorPspItem, usePspItems } from "@/services/psp";
import type { PspItemDto } from "@/services/psp";

import {
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
  useFormulationVersions,
  useReplaceLines,
  useRollbackFormulation,
  useSaveVersion,
  useSetApprovedVersion,
  useUpdateFormulation,
  type AllergensResult,
  type ComplianceFlagResult,
  type ComplianceResult,
  type ComputeLineInput,
  type DosageForm,
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

interface BuilderLine {
  /** Stable local id for rows we just added in the UI. */
  readonly key: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly item_attributes: ItemAttributesForMath;
  label_claim_mg: string;
  /** Per-line override of the catalogue's purity. Empty string means
   *  "use the catalogue value"; any non-empty numeric string wins on
   *  the math cascade and is persisted on save. */
  purity_override: string;
  overage_override: string;
  extract_ratio_override: string;
  display_order: number;
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
    item_attributes: attributesFromLine(line.item_attributes),
    label_claim_mg: line.label_claim_mg,
    purity_override: line.purity_override ?? "",
    overage_override: line.overage_override ?? "",
    extract_ratio_override: line.extract_ratio_override ?? "",
    display_order: line.display_order ?? index,
  }));
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
  //: Raw text from the picker input — updates on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  //: Debounced query that drives the picker cache key. Lags by 200ms.
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const updateMutation = useUpdateFormulation(orgId, formulation.id);
  const replaceLinesMutation = useReplaceLines(orgId, formulation.id);
  const saveVersionMutation = useSaveVersion(orgId, formulation.id);
  const rollbackMutation = useRollbackFormulation(orgId, formulation.id);
  const approveMutation = useSetApprovedVersion(orgId, formulation.id);
  const versionsQuery = useFormulationVersions(orgId, formulation.id);

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
    const gummyBaseForMath =
      metadata.dosage_form === "gummy"
        ? formulation.gummy_base_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
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
              if (!live && !echo) return null;
              return {
                id,
                label: live?.label || echo?.label || "",
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
              if (!live && !echo) return null;
              return {
                id,
                label: live?.label || echo?.label || "",
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
    const glazingForMath =
      metadata.dosage_form === "gummy"
        ? formulation.glazing_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
        : [];
    // Gelling + premix sweetener — coupled bands. Both feed
    // ``computeFillTarget``; gellingForMath being empty means the
    // gummy is non-gelling and the math suppresses both bands.
    const gellingForMath =
      metadata.dosage_form === "gummy"
        ? formulation.gelling_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
        : [];
    const premixSweetenerForMath =
      metadata.dosage_form === "gummy"
        ? formulation.premix_sweetener_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
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
    // Effective capsule size — the picked shell wins over the
    // dropdown so procurement-driven picks stay in sync with
    // compute. Reads the first pick's ``attributes.capsule_size``.
    // Live picker cache takes precedence over the server echo so a
    // freshly-toggled shell drives compute the moment the checkbox
    // fires, not after the save round-trip. Falls back to
    // ``metadata.capsule_size`` when no shell is picked / the pick
    // lacks the attribute, preserving pre-picker behaviour.
    let effectiveCapsuleSize = metadata.capsule_size || null;
    if (
      metadata.dosage_form === "capsule" &&
      metadata.capsule_shell_item_ids.length > 0
    ) {
      const firstId = metadata.capsule_shell_item_ids[0] ?? "";
      const liveAttrs = firstId ? capsuleShellAttrs[firstId] : undefined;
      const echoedAttrs = (formulation.capsule_shell_items ?? []).find(
        (i) => i.id === firstId,
      )?.attributes;
      const fromAttrs =
        liveAttrs?.["capsule_size"] ?? echoedAttrs?.["capsule_size"];
      if (typeof fromAttrs === "string" && fromAttrs.trim()) {
        effectiveCapsuleSize = fromAttrs.trim();
      }
    }
    return computeTotals({
      lines: computeInputs,
      dosageForm: metadata.dosage_form,
      capsuleSizeKey: effectiveCapsuleSize,
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
    mccCarrierNames,
    antiCakingNames,
    powderCarrierNames,
    acidityLive,
    flavouringLive,
    sweetenerLive,
    colourLive,
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
  const appendIngredientLine = useCallback((item: ItemDto) => {
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
          item_attributes: attributesFromItem(item),
          label_claim_mg: "0",
          purity_override: "",
          overage_override: "",
          extract_ratio_override: "",
          display_order: prev.length,
        },
      ];
    });
  }, []);

  const addIngredient = useCallback(
    (item: ItemDto) => {
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
          },
          onError: (err) => {
            // Surface the mirror failure in the same error banner
            // the rest of the builder uses. Without this the click
            // fails silently — the button appears to do nothing
            // and the operator can't tell PSP integration status
            // from a real network / permission issue.
            setErrorMessage(extractApiErrorMessage(err, tErrors));
          },
        });
        return;
      }
      appendIngredientLine(item);
    },
    [appendIngredientLine, mirrorPsp],
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
      const updated = await replaceLinesMutation.mutateAsync({
        lines: lines.map((line, index) => ({
          item_id: line.item_id,
          label_claim_mg: line.label_claim_mg || "0",
          purity_override: overrideOrNull(line.purity_override),
          overage_override: overrideOrNull(line.overage_override),
          extract_ratio_override: overrideOrNull(line.extract_ratio_override),
          display_order: index,
        })),
      });
      setFormulation(updated);
      setLines(linesFrom(updated));
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }, [lines, replaceLinesMutation, tErrors]);

  const handleSaveVersion = useCallback(async () => {
    setErrorMessage(null);
    try {
      await handleSaveMetadata();
      await handleSaveLines();
      await saveVersionMutation.mutateAsync({ label: "" });
    } catch (err) {
      setErrorMessage(extractApiErrorMessage(err, tErrors));
    }
  }, [
    handleSaveMetadata,
    handleSaveLines,
    saveVersionMutation,
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

  const isBusy =
    updateMutation.isPending ||
    replaceLinesMutation.isPending ||
    saveVersionMutation.isPending ||
    rollbackMutation.isPending;

  const versions = versionsQuery.data ?? [];

  const supported = FULLY_SUPPORTED_DOSAGE_FORMS.includes(metadata.dosage_form);

  return (
    <div className="mt-10 flex flex-col gap-10">
      {/* ------------------------------------------------------------ */}
      {/* Header + primary actions                                     */}
      {/* ------------------------------------------------------------ */}
      <section className="flex items-end justify-between gap-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {metadata.code || "—"}
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {metadata.name}
          </h1>
        </div>
        {canWrite ? (
          <div className="flex flex-col items-end gap-2">
            {metadataDirty || linesDirty ? (
              <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tFormulations("builder.unsaved_changes")}
              </span>
            ) : null}
            <div className="flex flex-wrap gap-3">
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
                isDisabled={isBusy || (!metadataDirty && !linesDirty)}
                onClick={async () => {
                  if (metadataDirty) await handleSaveMetadata();
                  if (linesDirty) await handleSaveLines();
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
                isDisabled={isBusy}
                onClick={handleSaveVersion}
              >
                <Save className="h-4 w-4" />
                {tFormulations("builder.save_version")}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      {errorMessage ? (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {errorMessage}
        </p>
      ) : null}

      {/* ------------------------------------------------------------ */}
      {/* Metadata form                                                */}
      {/* ------------------------------------------------------------ */}
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
          {/* Capsule size: no dedicated dropdown any more.
              * Shell picked → drives size via ``attributes.capsule_size``.
              * No shell picked → compute auto-picks the smallest size
                that fits the total active.
              A small hint block replaces the old dropdown so scientists
              know where the size comes from — the picker is the single
              source of truth. */}
          {metadata.dosage_form === "capsule" ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                Capsule size
              </span>
              <div className="flex items-center gap-2 rounded-xl bg-orange-50/60 px-3 py-2 text-sm text-ink-700 ring-1 ring-inset ring-orange-200">
                <ShieldCheck className="h-4 w-4 shrink-0 text-orange-700" />
                <span>
                  {metadata.capsule_shell_item_ids.length > 0
                    ? "Driven by the picked capsule shell — edit the shell's capsule_size attribute on PSP to change."
                    : "Auto-picked from total active weight — tick a capsule shell on the right to lock a specific size."}
                </span>
              </div>
            </div>
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
            />
          ) : null}
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

      {/* ------------------------------------------------------------ */}
      {/* Builder: picker + lines + totals                             */}
      {/* ------------------------------------------------------------ */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
        {/* Picker */}
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
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
            disabled={!canWrite}
            className="mt-3 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
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
              pickerItems.map((item) => {
                // PSP-sourced picker rows haven't mirrored yet, so
                // the "already added" check needs to look for the
                // in-flight synthetic id AND any local id that came
                // from a previous mirror of the same PSP UUID.
                const already = lines.some((l) => {
                  if (l.item_id === item.id) return true;
                  if (item.id.startsWith("psp:")) {
                    // A local line saved from an earlier session may
                    // carry ``psp_source_uuid`` in its item metadata;
                    // reconciling that lives on the follow-up "show
                    // PSP linkage on line rows" PR. For now, the
                    // mutation-side ``appendIngredientLine`` dedupe
                    // covers double-clicks; this is best-effort.
                    return false;
                  }
                  return false;
                });
                const failure = canComputeMaterial(attributesFromItem(item));
                const mirroring =
                  item.id.startsWith("psp:") &&
                  mirrorPsp.isPending &&
                  mirrorPsp.variables === item.id.slice("psp:".length);
                const disabled =
                  !canWrite || already || failure !== null || mirroring;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => addIngredient(item)}
                      title={
                        failure
                          ? tFormulations(
                              `builder.failure_reason.${failure}` as `builder.failure_reason.missing_claim`,
                            )
                          : undefined
                      }
                      className={`flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs text-ink-1000 ring-1 ring-inset hover:bg-ink-100 disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-500 ${
                        failure
                          ? "ring-warning/30"
                          : "ring-ink-200"
                      }`}
                    >
                      <span>
                        <span className="block font-semibold">{item.name}</span>
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
                    </button>
                  </li>
                );
              })
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
          {lines.length === 0 ? (
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
                {lines.map((line) => {
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
          )}
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
            mccCarrierLabels={mccCarrierLabels}
            antiCakingLabels={antiCakingLabels}
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

      {/* ------------------------------------------------------------ */}
      {/* G3 — MRPeasy BOM (per 1 kg of finished product)              */}
      {/* ------------------------------------------------------------ */}
      <MrpeasyBomCard
        totals={liveTotals}
        lines={lines}
        gummyBaseItems={formulation.gummy_base_items}
        flavouringItems={formulation.flavouring_items}
        colourItems={formulation.colour_items}
        glazingItems={formulation.glazing_items}
        gellingItems={formulation.gelling_items}
        premixSweetenerItems={formulation.premix_sweetener_items}
        acidityItems={formulation.acidity_items}
        // Excipient-band picks feed the capsule / tablet BOM rows
        // (Silicon Dioxide, MCC, DCP) with their actual SKUs +
        // codes instead of the generic category placeholders.
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
        formulationCode={formulation.code}
        formulationName={formulation.name}
        tFormulations={tFormulations}
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
// Memoised: BOM rows recompute only when totals / lines / picker
// state change. Keystrokes elsewhere (search input, metadata fields)
// no longer drive a full table re-render.
const MrpeasyBomCard = memo(function MrpeasyBomCard({
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
    ): { names: string[]; codes: string[] } => {
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
      return { names, codes };
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
        picks: { names: string[]; codes: string[] };
        placeholderLabel: string;
      }) => {
        const { slugPrefix, totalMg, picks, placeholderLabel } = opts;
        if (totalMg <= 0) return;
        if (picks.names.length === 0) {
          out.push({
            slug: slugPrefix,
            label: placeholderLabel,
            code: "",
            gramsPerKg: scale(totalMg),
            pct: (totalMg / totalWeight) * 100,
          });
          return;
        }
        const perPickMg = totalMg / picks.names.length;
        for (let i = 0; i < picks.names.length; i++) {
          out.push({
            slug: `${slugPrefix}:${i}`,
            label: picks.names[i]!,
            code: picks.codes[i] ?? "",
            gramsPerKg: scale(perPickMg),
            pct: (perPickMg / totalWeight) * 100,
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
    <section className="bom-print-card rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 print:break-before-page">
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

      <div className="flex items-center justify-between gap-3 bom-print-hide">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("mrpeasy_bom.title")}
          </p>
          <p className="mt-1 text-[11px] leading-snug text-ink-500">
            {tFormulations("mrpeasy_bom.hint")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-xl bg-ink-1000 px-3 py-1.5 text-xs font-medium text-ink-0 hover:bg-ink-900"
        >
          {tFormulations("mrpeasy_bom.print")}
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
          {tFormulations("mrpeasy_bom.print_subtitle")}
        </p>
        <p className="text-[9pt] text-ink-500">
          {tFormulations("mrpeasy_bom.print_printed_on", { date: printedOn })}
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">
          {tFormulations("mrpeasy_bom.empty_hint")}
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
                    {tFormulations("mrpeasy_bom.pre_blend_badge")}
                  </span>
                  <p className="mt-1 text-sm font-semibold text-ink-1000">
                    {tFormulations("mrpeasy_bom.active_powder.title")}
                  </p>
                </div>
                <p className="max-w-md text-[11px] leading-snug text-ink-500">
                  {tFormulations("mrpeasy_bom.active_powder.hint")}
                </p>
              </div>
              <div className="bom-print-only border-b border-ink-300 pb-3">
                <h2 className="text-[12pt] font-semibold text-ink-1000">
                  {tFormulations("mrpeasy_bom.active_powder.title")}
                </h2>
                <p className="mt-1 text-[10pt] text-ink-700">
                  {tFormulations("mrpeasy_bom.active_powder.print_subtitle")}
                </p>
              </div>
              <table className="mt-4 w-full text-xs">
                <thead className="border-b border-orange-200 text-ink-500">
                  <tr>
                    <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                      {tFormulations("mrpeasy_bom.col_code")}
                    </th>
                    <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                      {tFormulations("mrpeasy_bom.col_name")}
                    </th>
                    <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                      {tFormulations("mrpeasy_bom.col_grams")}
                    </th>
                    <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                      {tFormulations("mrpeasy_bom.col_pct")}
                    </th>
                    <th className="bom-print-only px-2 py-2 text-right font-medium uppercase tracking-wide">
                      {tFormulations("mrpeasy_bom.col_actual")}
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
                      {tFormulations("mrpeasy_bom.active_powder.total")}
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
                    {tFormulations("mrpeasy_bom.main_badge")}
                  </span>
                  <p className="mt-1 text-sm font-semibold text-ink-1000">
                    {tFormulations("mrpeasy_bom.main_title")}
                  </p>
                </div>
                <p className="max-w-md text-[11px] leading-snug text-ink-500">
                  {tFormulations("mrpeasy_bom.main_hint")}
                </p>
              </div>
            ) : null}
            <table className="w-full text-xs">
              <thead className="border-b border-ink-200 text-ink-500">
                <tr>
                  <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                    {tFormulations("mrpeasy_bom.col_code")}
                  </th>
                  <th className="px-2 py-2 text-left font-medium uppercase tracking-wide">
                    {tFormulations("mrpeasy_bom.col_name")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                    {tFormulations("mrpeasy_bom.col_grams")}
                  </th>
                  <th className="px-2 py-2 text-right font-medium uppercase tracking-wide">
                    {tFormulations("mrpeasy_bom.col_pct")}
                  </th>
                  {/* Print-only Actual column — empty cell with a
                      horizontal rule so the technician writes the
                      actual measured kg next to each line in pen. */}
                  <th className="bom-print-only px-2 py-2 text-right font-medium uppercase tracking-wide">
                    {tFormulations("mrpeasy_bom.col_actual")}
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
                            {tFormulations("mrpeasy_bom.missing")}
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
                              {tFormulations("mrpeasy_bom.pre_blend_badge")}
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
                    {tFormulations("mrpeasy_bom.total")}
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
              {tFormulations("mrpeasy_bom.print_signature_technician")}
            </div>
            <div className="mt-2 border-b border-ink-700">&nbsp;</div>
          </div>
          <div>
            <div className="text-[9pt] uppercase tracking-wide text-ink-500">
              {tFormulations("mrpeasy_bom.print_signature_supervisor")}
            </div>
            <div className="mt-2 border-b border-ink-700">&nbsp;</div>
          </div>
          <div>
            <div className="text-[9pt] uppercase tracking-wide text-ink-500">
              {tFormulations("mrpeasy_bom.print_signature_date")}
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
  mccCarrierLabels = [],
  antiCakingLabels = [],
}: {
  totals: FormulationTotals;
  servingSize: number;
  dosageForm: DosageForm;
  numberFormatter: Intl.NumberFormat;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
  /** Display labels of the picked MCC-carrier items so the MCC row
   *  can render "MCC (Pregelatinised Starch, Maltodextrin)". Empty
   *  array → the row stays as the bare placeholder label. */
  mccCarrierLabels?: readonly string[];
  /** Display labels of the picked anti-caking items so the Stearate +
   *  Silica rows can echo the same picks (the band is a combined 1.4%
   *  on the new picker, but the two-row display layout preserves the
   *  workbook's mental model). */
  antiCakingLabels?: readonly string[];
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
                {excipients.mgStearateMg + excipients.silicaMg > 0 ? (
                  <li className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words">
                        {tFormulations("builder.excipients.anti_caking")}
                        {antiCakingLabels.length > 0 ? (
                          <span className="ml-1 text-ink-500">
                            ({antiCakingLabels.join(", ")})
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">
                      {format(
                        excipients.mgStearateMg + excipients.silicaMg,
                      )}{" "}
                      mg
                      {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                        <span className="ml-1 text-ink-500">
                          (
                          {percentOf(
                            excipients.mgStearateMg + excipients.silicaMg,
                            totals.totalWeightMg,
                          )}
                          %)
                        </span>
                      ) : null}
                    </span>
                  </li>
                ) : null}
                {excipients.dcpMg !== null && excipients.dcpMg > 0 ? (
                  <li className="flex items-baseline justify-between gap-3">
                    <span className="break-words">
                      {tFormulations("builder.excipients.dcp")}
                    </span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">
                      {format(excipients.dcpMg)} mg
                      {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                        <span className="ml-1 text-ink-500">
                          ({percentOf(excipients.dcpMg, totals.totalWeightMg)}%)
                        </span>
                      ) : null}
                    </span>
                  </li>
                ) : null}
                {excipients.mccMg > 0 ? (
                  <li className="flex items-baseline justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="break-words">
                        {tFormulations("builder.excipients.mcc")}
                        {mccCarrierLabels.length > 0 ? (
                          <span className="ml-1 text-ink-500">
                            ({mccCarrierLabels.join(", ")})
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span className="shrink-0 whitespace-nowrap tabular-nums">
                      {format(excipients.mccMg)} mg
                      {totals.totalWeightMg && totals.totalWeightMg > 0 ? (
                        <span className="ml-1 text-ink-500">
                          ({percentOf(excipients.mccMg, totals.totalWeightMg)}%)
                        </span>
                      ) : null}
                    </span>
                  </li>
                ) : null}
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
    const picked = value
      .map((id) => {
        const hit = lookup.get(id);
        return hit
          ? {
              id,
              name: hit.name,
              internal_code: hit.internal_code,
              attributes: hit.attributes,
            }
          : { id, name: "", internal_code: "" };
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
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <div
        className={`flex max-h-56 flex-col overflow-y-auto rounded-xl bg-ink-0 ring-1 ring-inset ring-ink-200 ${
          disabled || (pspLive ? pspQuery.isLoading : localQuery.isLoading)
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
            return (
              <label
                key={item.id}
                className={`flex cursor-pointer items-center gap-2 border-b border-ink-100 px-3 py-2 text-sm last:border-b-0 ${
                  checked
                    ? "bg-orange-50 text-ink-1000"
                    : "text-ink-700 hover:bg-ink-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled || mirroring}
                  onChange={() => toggle(item.id)}
                  className="h-4 w-4 cursor-pointer accent-orange-500"
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
