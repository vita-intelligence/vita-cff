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
          />
          <NumberField
            label={tFormulations("fields.servings_per_pack")}
            value={metadata.servings_per_pack}
            onChange={(v) => setMetadata({ ...metadata, servings_per_pack: v })}
            disabled={!canWrite}
          />
          <TextField
            label={tFormulations("fields.appearance")}
            value={metadata.appearance}
            onChange={(v) => setMetadata({ ...metadata, appearance: v })}
            disabled={!canWrite}
          />
          <TextField
            label={tFormulations("fields.disintegration_spec")}
            value={metadata.disintegration_spec}
            onChange={(v) =>
              setMetadata({ ...metadata, disintegration_spec: v })
            }
            disabled={!canWrite}
          />
          <TextAreaField
            label={tFormulations("fields.directions_of_use")}
            value={metadata.directions_of_use}
            onChange={(v) =>
              setMetadata({ ...metadata, directions_of_use: v })
            }
            disabled={!canWrite}
          />
          <TextAreaField
            label={tFormulations("fields.suggested_dosage")}
            value={metadata.suggested_dosage}
            onChange={(v) =>
              setMetadata({ ...metadata, suggested_dosage: v })
            }
            disabled={!canWrite}
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
  const copyable = declaration.text;
  const handleCopy = async () => {
    if (!copyable) return;
    // Plain-text copy — when the scientist pastes into an external
    // system, they usually want the comma-joined string without
    // HTML markup. Bold-formatting is a visual convenience for the
    // on-screen preview.
    try {
      await navigator.clipboard.writeText(copyable);
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
          <p className="mt-2 font-serif text-sm leading-relaxed text-ink-1000">
            {declaration.entries.map((entry, idx) => (
              <span
                key={`${entry.category}-${entry.label}-${idx}`}
              >
                {idx > 0 ? ", " : ""}
                {entry.isAllergen ? (
                  <strong>{entry.label}</strong>
                ) : (
                  entry.label
                )}
              </span>
            ))}
          </p>
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
            {excipients.rows.length > 0 ? (
              // Flexible list used by powder + gummy. ``is_remainder``
              // rows (carrier / gummy base) get a subtle orange accent
              // so scientists can see which value is "whatever's left"
              // at a glance. For powders the concentration (mg/ml of
              // water) is shown inline so the scientist can see the
              // formula behind the computed mg — changing water volume
              // rescales every row with this rate.
              excipients.rows.map((row) => (
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
                  <span className="tabular-nums">{format(row.mg)} mg</span>
                </li>
              ))
            ) : (
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
            )}
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
        {label}
      </span>
      <input
        value={value}
        disabled={disabled}
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
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
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
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
      />
    </label>
  );
}


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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
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
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
      />
    </label>
  );
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
