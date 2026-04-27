"use client";

import { Button } from "@heroui/react";
import { Check, Copy, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { clientUuid } from "@/lib/utils";
import { useInfiniteItems } from "@/services/catalogues";
import type { ItemDto } from "@/services/catalogues/types";

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
  //: Picked colour raw-material ids. Empty list = the 2%-of-target
  //: colour block renders as a generic "Colour" row; any picks →
  //: split equally and listed under "Colour (Beetroot Extract,
  //: Turmeric)" on the spec sheet.
  colour_item_ids: readonly string[];
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
    glazing_item_ids: formulation.glazing_item_ids ?? [],
    gelling_item_ids: formulation.gelling_item_ids ?? [],
    premix_sweetener_item_ids:
      formulation.premix_sweetener_item_ids ?? [],
    acidity_item_ids: formulation.acidity_item_ids ?? [],
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
    display_order: line.display_order ?? index,
  }));
}

export function FormulationBuilder({
  orgId,
  initialFormulation,
  canWrite,
}: {
  orgId: string;
  initialFormulation: FormulationDto;
  canWrite: boolean;
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
    const computeInputs: ComputeLineInput[] = lines.map((line) => ({
      externalId: line.key,
      attributes: line.item_attributes,
      labelClaimMg: Number.parseFloat(line.label_claim_mg || "0"),
      servingSizeOverride: null,
      fallbackName: line.item_name,
    }));
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
    const flavouringForMath =
      metadata.dosage_form === "gummy"
        ? formulation.flavouring_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
        : [];
    const colourForMath =
      metadata.dosage_form === "gummy"
        ? formulation.colour_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
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
    const acidityForMath =
      metadata.dosage_form === "gummy"
        ? formulation.acidity_items.map((pick) => ({
            id: pick.id,
            label: pick.ingredient_list_name || pick.name,
            useAs: pick.use_as || "",
          }))
        : [];
    return computeTotals({
      lines: computeInputs,
      dosageForm: metadata.dosage_form,
      capsuleSizeKey: metadata.capsule_size || null,
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
      excipientOverrides: metadata.excipient_overrides,
    });
  }, [
    lines,
    metadata.dosage_form,
    metadata.capsule_size,
    metadata.tablet_size,
    metadata.serving_size,
    metadata.target_fill_weight_mg,
    metadata.powder_type,
    metadata.water_volume_ml,
    metadata.excipient_overrides,
    formulation.gummy_base_items,
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

  const declaration: IngredientDeclaration = useMemo(
    () =>
      buildIngredientDeclaration({
        lines: lines.map((line) => ({
          externalId: line.key,
          attributes: line.item_attributes,
          fallbackName: line.item_name,
        })),
        totals: liveTotals,
      }),
    [lines, liveTotals],
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

  const pickerQuery = useInfiniteItems(orgId, RAW_MATERIALS_SLUG, {
    includeArchived: false,
    ordering: "name",
    pageSize: 50,
    search: debouncedSearch || undefined,
  });

  const pickerItems: readonly ItemDto[] = useMemo(
    () => pickerQuery.data?.pages.flatMap((page) => [...page.results]) ?? [],
    [pickerQuery.data],
  );

  const pickerScrollRef = useRef<HTMLUListElement>(null);
  const pickerSentinelRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
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
  }, [pickerQuery, pickerItems.length]);

  // ---------------------------------------------------------------------
  // Line edits
  // ---------------------------------------------------------------------
  const addIngredient = useCallback(
    (item: ItemDto) => {
      if (lines.some((line) => line.item_id === item.id)) {
        return;
      }
      const key = `new-${clientUuid()}`;
      setLines((prev) => [
        ...prev,
        {
          key,
          item_id: item.id,
          item_name: item.name,
          item_internal_code: item.internal_code,
          item_attributes: attributesFromItem(item),
          label_claim_mg: "0",
          display_order: prev.length,
        },
      ]);
    },
    [lines],
  );

  const updateLineClaim = useCallback((key: string, value: string) => {
    const sanitized = sanitizeDecimalInput(value);
    setLines((prev) =>
      prev.map((line) =>
        line.key === key ? { ...line, label_claim_mg: sanitized } : line,
      ),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) =>
      prev
        .filter((line) => line.key !== key)
        .map((line, index) => ({ ...line, display_order: index })),
    );
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
        capsule_size: metadata.capsule_size,
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
        // ``use_as`` on every id.
        gummy_base_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.gummy_base_item_ids
            : [],
        flavouring_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.flavouring_item_ids
            : [],
        colour_item_ids:
          metadata.dosage_form === "gummy"
            ? metadata.colour_item_ids
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
          metadata.dosage_form === "gummy"
            ? metadata.acidity_item_ids
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
      setErrorMessage(extractErrorMessage(err, tErrors));
    }
  }, [metadata, updateMutation, router, tErrors]);

  const handleSaveLines = useCallback(async () => {
    setErrorMessage(null);
    try {
      const updated = await replaceLinesMutation.mutateAsync({
        lines: lines.map((line, index) => ({
          item_id: line.item_id,
          label_claim_mg: line.label_claim_mg || "0",
          display_order: index,
        })),
      });
      setFormulation(updated);
      setLines(linesFrom(updated));
    } catch (err) {
      setErrorMessage(extractErrorMessage(err, tErrors));
    }
  }, [lines, replaceLinesMutation, tErrors]);

  const handleSaveVersion = useCallback(async () => {
    setErrorMessage(null);
    try {
      await handleSaveMetadata();
      await handleSaveLines();
      await saveVersionMutation.mutateAsync({ label: "" });
    } catch (err) {
      setErrorMessage(extractErrorMessage(err, tErrors));
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
        setErrorMessage(extractErrorMessage(err, tErrors));
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
        setErrorMessage(extractErrorMessage(err, tErrors));
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
          {metadata.dosage_form === "capsule" ? (
            <SelectField
              label={tFormulations("fields.capsule_size")}
              value={metadata.capsule_size}
              onChange={(v) => setMetadata({ ...metadata, capsule_size: v })}
              disabled={!canWrite}
              options={[
                { value: "", label: tFormulations("placeholders.auto_pick") },
                ...CAPSULE_SIZES.map((s) => ({
                  value: s.key,
                  label: `${s.label} (${s.max_weight_mg} mg)`,
                })),
              ]}
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
            {pickerQuery.isLoading && pickerItems.length === 0 ? (
              <li className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tCommon("states.loading")}
              </li>
            ) : pickerItems.length === 0 ? (
              <li className="text-xs font-medium uppercase tracking-wide text-ink-500">
                {tFormulations("builder.picker_empty")}
              </li>
            ) : (
              pickerItems.map((item) => {
                const already = lines.some((l) => l.item_id === item.id);
                const failure = canComputeMaterial(attributesFromItem(item));
                const disabled = !canWrite || already || failure !== null;
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
            {pickerItems.length > 0 ? (
              <li ref={pickerSentinelRef} aria-hidden className="h-px" />
            ) : null}
            {pickerQuery.isFetchingNextPage ? (
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
                  const explanation = explainLine(
                    line.item_attributes,
                    Number.parseFloat(line.label_claim_mg || "0"),
                  );
                  return (
                    <tr
                      key={line.key}
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
                      </td>
                    </tr>
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
          />
          {metadata.dosage_form === "gummy" ? (
            <GummyOverridesPanel
              overrides={metadata.excipient_overrides}
              gellingPicked={metadata.gelling_item_ids.length > 0}
              disabled={!canWrite}
              onChange={(next) =>
                setMetadata({
                  ...metadata,
                  excipient_overrides: next,
                })
              }
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


function CompliancePanel({
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
}


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


function DeclarationPanel({
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
}


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
function MrpeasyBomCard({
  totals,
  lines,
  gummyBaseItems,
  flavouringItems,
  colourItems,
  glazingItems,
  gellingItems,
  premixSweetenerItems,
  acidityItems,
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
  formulationCode: string;
  formulationName: string;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const totalWeight = totals.totalWeightMg;

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

    // 1) Actives — straight from the line list. Per-kg scaling
    //    uses each line's cached mg/serving.
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

      // Capsule / tablet excipients — synthetic rows, no item code.
      if (excipients.mgStearateMg && excipients.mgStearateMg > 0) {
        out.push({
          slug: "mg_stearate",
          label: "Magnesium Stearate",
          code: "",
          gramsPerKg: scale(excipients.mgStearateMg),
          pct: (excipients.mgStearateMg / totalWeight) * 100,
        });
      }
      if (excipients.silicaMg && excipients.silicaMg > 0) {
        out.push({
          slug: "silica",
          label: "Silicon Dioxide",
          code: "",
          gramsPerKg: scale(excipients.silicaMg),
          pct: (excipients.silicaMg / totalWeight) * 100,
        });
      }
      if (excipients.dcpMg && excipients.dcpMg > 0) {
        out.push({
          slug: "dcp",
          label: "Dicalcium Phosphate",
          code: "",
          gramsPerKg: scale(excipients.dcpMg),
          pct: (excipients.dcpMg / totalWeight) * 100,
        });
      }
      if (excipients.mccMg && excipients.mccMg > 0) {
        out.push({
          slug: "mcc",
          label: "Microcrystalline Cellulose",
          code: "",
          gramsPerKg: scale(excipients.mccMg),
          pct: (excipients.mccMg / totalWeight) * 100,
        });
      }
    }

    return out;
  }, [
    totalWeight,
    totals.excipients,
    totals.lineValues,
    lines,
    gummyBaseItems,
    flavouringItems,
    colourItems,
    glazingItems,
    gellingItems,
    premixSweetenerItems,
    acidityItems,
  ]);

  const totalGrams = rows.reduce((acc, r) => acc + r.gramsPerKg, 0);
  // Display in kilograms — procurement reads quantities for whole
  // batches in kg; grams turn into awkward four-digit numbers for
  // higher-volume excipients. Conversion is just a /1000 — the
  // underlying math stays in grams per kg of finished product.
  const formatKg = (g: number) => (g / 1000).toFixed(4);
  const totalKg = totalGrams / 1000;

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 print:break-before-page">
      <div className="flex items-center justify-between gap-3 print:hidden">
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
      <div className="hidden print:block">
        <h1 className="text-lg font-semibold">
          {formulationCode ? `${formulationCode} — ` : ""}
          {formulationName}
        </h1>
        <p className="text-xs text-ink-700">
          {tFormulations("mrpeasy_bom.print_subtitle")}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-ink-600">
          {tFormulations("mrpeasy_bom.empty_hint")}
        </p>
      ) : (
        <table className="mt-4 w-full text-xs">
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
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.slug}
                className={`border-b border-ink-100 ${
                  row.missing ? "bg-amber-50" : ""
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
                <td className="px-2 py-1.5 text-ink-1000">{row.label}</td>
                <td className="px-2 py-1.5 text-right text-ink-1000 tabular-nums">
                  {formatKg(row.gramsPerKg)}
                </td>
                <td className="px-2 py-1.5 text-right text-ink-700 tabular-nums">
                  {row.pct.toFixed(2)}
                </td>
              </tr>
            ))}
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
            </tr>
          </tfoot>
        </table>
      )}
    </section>
  );
}


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


function TotalsBlock({
  totals,
  servingSize,
  dosageForm,
  numberFormatter,
  tFormulations,
}: {
  totals: FormulationTotals;
  servingSize: number;
  dosageForm: DosageForm;
  numberFormatter: Intl.NumberFormat;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
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
  const leftoverMg =
    totals.totalWeightMg !== null && totals.maxWeightMg !== null
      ? totals.maxWeightMg - totals.totalWeightMg
      : null;
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
              groupGummyFlavourRows(excipients.rows).map((row) => (
                <li
                  key={row.slug}
                  className={`flex justify-between gap-2 ${
                    row.isRemainder ? "font-medium text-orange-700" : ""
                  }`}
                >
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span>{row.label}</span>
                    {row.concentrationMgPerMl !== null &&
                    row.concentrationMgPerMl !== undefined ? (
                      <span className="text-[10px] text-ink-500">
                        ({row.concentrationMgPerMl} mg/ml)
                      </span>
                    ) : null}
                  </span>
                  <span className="tabular-nums">
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
                <li className="flex justify-between">
                  <span>
                    {tFormulations("builder.excipients.mg_stearate")}
                  </span>
                  <span>{format(excipients.mgStearateMg)} mg</span>
                </li>
                <li className="flex justify-between">
                  <span>{tFormulations("builder.excipients.silica")}</span>
                  <span>{format(excipients.silicaMg)} mg</span>
                </li>
                {excipients.dcpMg !== null ? (
                  <li className="flex justify-between">
                    <span>{tFormulations("builder.excipients.dcp")}</span>
                    <span>{format(excipients.dcpMg)} mg</span>
                  </li>
                ) : null}
                <li className="flex justify-between">
                  <span>{tFormulations("builder.excipients.mcc")}</span>
                  <span>{format(excipients.mccMg)} mg</span>
                </li>
              </>
            ) : null}
          </ul>
        </div>
      ) : null}

      {totals.totalWeightMg !== null ? (
        <div className="border-t border-ink-100 pt-4 text-xs text-ink-700">
          <div className="flex items-baseline justify-between">
            <span>
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
            <div className="mt-1 flex items-baseline justify-between">
              <span>{tFormulations("builder.excipients.max_weight")}</span>
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
              className={`mt-1 flex items-baseline justify-between ${
                leftoverMg < 0
                  ? "font-medium text-danger"
                  : leftoverMg === 0
                    ? "text-success"
                    : "text-orange-700"
              }`}
            >
              <span>
                {leftoverMg < 0
                  ? tFormulations("builder.excipients.overshoot")
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
      </div>
    </div>
  );
}


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
      className="group inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 -mx-1.5 -my-0.5 text-left transition-colors hover:bg-ink-100/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
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
  label,
  placeholderText,
  hint,
  loadingText,
  emptyText,
  onChange,
}: {
  orgId: string;
  value: readonly string[];
  preselected: readonly GummyBaseItemDto[];
  disabled?: boolean;
  useAsIn: readonly string[];
  label: string;
  placeholderText: string;
  hint: string;
  loadingText: string;
  emptyText: string;
  onChange: (ids: readonly string[]) => void;
}) {
  const query = useInfiniteItems(orgId, RAW_MATERIALS_SLUG, {
    includeArchived: false,
    ordering: "name",
    pageSize: 50,
    useAsIn,
  });

  const fetched = query.data?.pages.flatMap((p) => p.results) ?? [];
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
  const toggle = (id: string) => {
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
          disabled || query.isLoading ? "opacity-60" : ""
        }`}
      >
        {merged.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink-500">
            {query.isLoading ? loadingText : emptyText}
          </p>
        ) : (
          merged.map((item) => {
            const checked = selected.has(item.id);
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
                  disabled={disabled}
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
// the server. Used by ``GummyOverridesPanel`` to show the default
// next to each editable input.
const GUMMY_BAND_DEFAULTS = {
  water: 0.055,
  acidity: 0.02,
  flavouring: 0.004,
  colour: 0.02,
  glazing: 0.001,
  gelling: 0.03,
  premix_sweetener: 0.06,
} as const;
type GummyBandKey = keyof typeof GUMMY_BAND_DEFAULTS;


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
            defaultPct={GUMMY_BAND_DEFAULTS[band.key]}
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
  defaultPct,
  override,
  disabled,
  onChange,
}: {
  label: string;
  defaultPct: number;
  override: number | undefined;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  // Show pct as a human-friendly decimal — 0.02 → "2", 0.055 →
  // "5.5". The scientist types percentages, never decimals.
  const effective = override ?? defaultPct;
  const [draft, setDraft] = useState<string>(
    (effective * 100).toString(),
  );
  // Keep ``draft`` synced when ``override`` changes externally
  // (parent reset, version load, etc.). Avoids stale text after
  // ``Reset all``.
  useEffect(() => {
    setDraft((effective * 100).toString());
  }, [effective]);

  const commit = (raw: string) => {
    const trimmed = raw.replace(",", ".").trim();
    if (!trimmed) {
      onChange(null);
      return;
    }
    const parsed = Number.parseFloat(trimmed);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      // Reject out-of-range — snap back to current effective
      setDraft((effective * 100).toString());
      return;
    }
    const asFraction = parsed / 100;
    // No-op when the typed value matches the default — clear the
    // override so the field falls back instead of locking in the
    // baseline value.
    if (Math.abs(asFraction - defaultPct) < 1e-6) {
      onChange(null);
    } else {
      onChange(asFraction);
    }
  };

  const isOverridden = override !== undefined;
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className="flex items-center gap-1.5 text-ink-700">
        <span>{label}</span>
        {isOverridden ? (
          <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-orange-700">
            ●
          </span>
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
        <span className="text-ink-500">%</span>
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
const GLAZING_USE_CATEGORIES = ["Glazing Agent"] as const;
const GELLING_USE_CATEGORIES = ["Gelling Agent"] as const;
const ACIDITY_USE_CATEGORIES = ["Acidity Regulator"] as const;


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
    readonly concentrationMgPerMl?: number | null;
  }[],
): readonly {
  readonly slug: string;
  readonly label: string;
  readonly mg: number;
  readonly isRemainder: boolean;
  readonly concentrationMgPerMl?: number | null;
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
  const GROUPINGS: readonly {
    readonly prefixes: readonly string[];
    readonly combinedSlug: string;
    readonly heading: string;
    readonly hideComponents?: boolean;
  }[] = [
    {
      prefixes: ["acidity:"],
      combinedSlug: "acidity:__combined",
      heading: "Acidity Regulator",
    },
    {
      prefixes: ["flavouring:"],
      combinedSlug: "flavouring:__combined",
      heading: "Flavouring",
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
        concentrationMgPerMl: null,
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
      concentrationMgPerMl: null,
    });
  }
  // Untouched rows (powder flavour entries, etc.) pass through
  // first so the visual order stays predictable on a gummy panel.
  return [...remaining, ...output];
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


function sanitizeDecimalInput(raw: string): string {
  let value = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
  const firstDot = value.indexOf(".");
  if (firstDot !== -1) {
    value =
      value.slice(0, firstDot + 1) +
      value.slice(firstDot + 1).replace(/\./g, "");
  }
  const dot = value.indexOf(".");
  if (dot !== -1 && value.length - dot - 1 > 2) {
    value = value.slice(0, dot + 3);
  }
  return value;
}
