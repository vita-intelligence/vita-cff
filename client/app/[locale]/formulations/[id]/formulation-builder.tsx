"use client";

import { Button } from "@heroui/react";
import { Save, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useInfiniteItems } from "@/services/catalogues";
import type { ItemDto } from "@/services/catalogues/types";

import { NewSpecSheetButton } from "./new-spec-sheet-button";
import {
  CAPSULE_SIZES,
  DOSAGE_FORMS,
  FULLY_SUPPORTED_DOSAGE_FORMS,
  TABLET_SIZES,
  buildIngredientDeclaration,
  canComputeMaterial,
  computeAllergens,
  computeCompliance,
  computeTotals,
  explainLine,
  useFormulationVersions,
  useReplaceLines,
  useRollbackFormulation,
  useSaveVersion,
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
  directions_of_use: string;
  suggested_dosage: string;
  appearance: string;
  disintegration_spec: string;
}

function metadataFrom(formulation: FormulationDto): MetadataDraft {
  return {
    name: formulation.name,
    code: formulation.code,
    description: formulation.description,
    dosage_form: formulation.dosage_form,
    capsule_size: formulation.capsule_size,
    tablet_size: formulation.tablet_size,
    serving_size: formulation.serving_size,
    servings_per_pack: formulation.servings_per_pack,
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  //: Raw text from the picker input — updates on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  //: Debounced query that drives the picker cache key. Lags by 200ms.
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const updateMutation = useUpdateFormulation(orgId, formulation.id);
  const replaceLinesMutation = useReplaceLines(orgId, formulation.id);
  const saveVersionMutation = useSaveVersion(orgId, formulation.id);
  const rollbackMutation = useRollbackFormulation(orgId, formulation.id);
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
    return computeTotals({
      lines: computeInputs,
      dosageForm: metadata.dosage_form,
      capsuleSizeKey: metadata.capsule_size || null,
      tabletSizeKey: metadata.tablet_size || null,
      defaultServingSize: metadata.serving_size,
    });
  }, [lines, metadata.dosage_form, metadata.capsule_size, metadata.tablet_size, metadata.serving_size]);

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
      const key = `new-${crypto.randomUUID()}`;
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
    setLines((prev) =>
      prev.map((line) =>
        line.key === key ? { ...line, label_claim_mg: value } : line,
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
      const updated = await updateMutation.mutateAsync({
        name: metadata.name,
        code: metadata.code,
        description: metadata.description,
        dosage_form: metadata.dosage_form,
        capsule_size: metadata.capsule_size,
        tablet_size: metadata.tablet_size,
        serving_size: metadata.serving_size,
        servings_per_pack: metadata.servings_per_pack,
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
              <NewSpecSheetButton orgId={orgId} versions={versions} />
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
              })
            }
            disabled={!canWrite}
            options={DOSAGE_FORMS.map((key) => ({
              value: key,
              label: tFormulations(`dosage_forms.${key}`),
            }))}
          />
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
          <NumberField
            label={tFormulations("fields.serving_size")}
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
          {lines.length === 0 ? (
            <p className="mt-6 text-sm text-ink-600">
              {tFormulations("builder.picker_none_added")}
            </p>
          ) : (
            <table className="mt-4 w-full border-collapse">
              <thead>
                <tr className="border-b border-ink-100">
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                    {tFormulations("columns.name")}
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                    {tFormulations("builder.label_claim_column")}
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide text-ink-500">
                    {tFormulations("builder.mg_per_serving_column")}
                  </th>
                  <th className="px-3 py-2" />
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
                      <td className="px-3 py-3 text-right">
                        <input
                          type="number"
                          min={0}
                          step="0.0001"
                          value={line.label_claim_mg}
                          disabled={!canWrite}
                          onChange={(e) =>
                            updateLineClaim(line.key, e.target.value)
                          }
                          className="w-32 rounded-xl bg-ink-0 px-2 py-1 text-right text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </td>
                      <td className="px-3 py-3 text-right text-xs">
                        <div>
                          {computed !== null
                            ? numberFormatter.format(computed)
                            : "—"}
                        </div>
                        {computed !== null && explanation ? (
                          <div
                            className="mt-0.5 text-[10px] text-ink-500"
                            title="How this number was computed"
                          >
                            {explanation}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {canWrite ? (
                          <button
                            type="button"
                            onClick={() => removeLine(line.key)}
                            className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500 hover:text-danger"
                          >
                            <Trash2 className="h-4 w-4" />
                            {tFormulations("builder.remove_line")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex items-center justify-between rounded-lg px-3 py-2 ring-1 ring-inset ring-ink-200"
              >
                <div>
                  <span className="font-semibold">
                    {tFormulations("versions.version_prefix")}
                    {v.version_number}
                  </span>
                  {v.label ? (
                    <span className="ml-3 text-xs text-ink-600">
                      {v.label}
                    </span>
                  ) : null}
                  <span className="ml-3 text-xs text-ink-500">
                    {dateFormatter.format(new Date(v.created_at))}
                  </span>
                </div>
                {canWrite ? (
                  <button
                    type="button"
                    onClick={() => handleRollback(v.version_number)}
                    className="text-xs font-medium uppercase tracking-wide text-ink-500 hover:text-ink-1000"
                  >
                    {tFormulations("versions.rollback")}
                  </button>
                ) : null}
              </li>
            ))}
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
  numberFormatter,
  tFormulations,
}: {
  totals: FormulationTotals;
  numberFormatter: Intl.NumberFormat;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  const format = (value: number | null | undefined) =>
    value === null || value === undefined
      ? "—"
      : numberFormatter.format(value);

  const excipients = totals.excipients;

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tFormulations("builder.excipients.total_active")}
        </p>
        <p className="mt-1 text-xl font-semibold tracking-tight text-ink-1000">
          {format(totals.totalActiveMg)}{" "}
          <span className="text-sm text-ink-600">mg</span>
        </p>
      </div>

      {excipients ? (
        <div className="border-t border-ink-100 pt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tFormulations("builder.excipients.title")}
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-ink-700">
            <li className="flex justify-between">
              <span>{tFormulations("builder.excipients.mg_stearate")}</span>
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
          </ul>
        </div>
      ) : null}

      {totals.totalWeightMg !== null ? (
        <div className="border-t border-ink-100 pt-4 text-xs text-ink-700">
          <div className="flex justify-between">
            <span>{tFormulations("builder.excipients.total_weight")}</span>
            <span>{format(totals.totalWeightMg)} mg</span>
          </div>
          {totals.maxWeightMg !== null ? (
            <div className="flex justify-between">
              <span>{tFormulations("builder.excipients.max_weight")}</span>
              <span>{format(totals.maxWeightMg)} mg</span>
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


function TextField({
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
