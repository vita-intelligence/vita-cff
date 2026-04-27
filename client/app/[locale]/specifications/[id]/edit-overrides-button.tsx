"use client";

import { Button, Modal } from "@heroui/react";
import { Pencil, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useUpdateSpecification,
  type RenderedSheetContext,
  type SnapshotOverrides,
  type SpecificationSheetDto,
} from "@/services/specifications";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100";
const LABEL_CLASS = "text-xs font-medium text-ink-700";
const HINT_CLASS = "text-[11px] text-ink-500";


type ComplianceValue = "yes" | "no" | "unknown" | "";


interface DraftState {
  // Formulation metadata overrides (free-text). Empty string clears
  // the override on save.
  directions_of_use: string;
  suggested_dosage: string;
  appearance: string;
  disintegration_spec: string;
  // Single-string EU 1169 ingredient declaration. Empty string clears
  // the override and falls back to the auto-built declaration.
  declaration_text: string;
  // Comma-separated list typed by the scientist. Split on save into
  // an array. Empty string clears the override.
  allergens_csv: string;
  compliance: {
    vegan: ComplianceValue;
    organic: ComplianceValue;
    halal: ComplianceValue;
    kosher: ComplianceValue;
  };
  // Per-active line keyed by ``item_id``. Empty strings clear that
  // field on save so the snapshot value re-takes effect.
  actives: Record<string, { label_claim_mg: string; nrv_pct: string }>;
  // Per-excipient-row mg override keyed by row slug (``water_mg``,
  // ``gummy_base_mg``, ``acidity``, ``flavouring:<id>``, etc.).
  // Empty strings clear the override on save.
  excipients_mg: Record<string, string>;
}


/**
 * Build the initial draft from the current ``snapshot_overrides``
 * map. Fields that are not currently overridden seed as empty
 * strings so the inputs stay blank instead of filling with the
 * computed value (which would flip every render into an override
 * the moment the user clicks "Save").
 */
function draftFromOverrides(
  overrides: SnapshotOverrides | undefined,
  rendered: RenderedSheetContext,
): DraftState {
  const formulation = overrides?.formulation ?? {};
  const declaration = overrides?.declaration ?? {};
  const allergens = overrides?.allergens?.sources;
  const compliance = overrides?.compliance ?? {};
  const activesOverride = overrides?.actives ?? {};
  const excipientsMgOverride = overrides?.excipients_mg ?? {};

  const actives: DraftState["actives"] = {};
  for (const active of rendered.actives) {
    const id = active.item_id;
    if (!id) continue;
    const o = activesOverride[id];
    actives[id] = {
      label_claim_mg: o?.label_claim_mg ?? "",
      nrv_pct: o?.nrv_pct ?? "",
    };
  }

  // Seed the excipients-mg draft with whatever the user has already
  // overridden — keeps inputs blank otherwise so the placeholder
  // shows the snapshot value.
  const excipients_mg: Record<string, string> = {};
  for (const [key, value] of Object.entries(excipientsMgOverride)) {
    if (typeof value === "string") {
      excipients_mg[key] = value;
    }
  }

  return {
    directions_of_use: formulation.directions_of_use ?? "",
    suggested_dosage: formulation.suggested_dosage ?? "",
    appearance: formulation.appearance ?? "",
    disintegration_spec: formulation.disintegration_spec ?? "",
    declaration_text: declaration.text ?? "",
    allergens_csv: Array.isArray(allergens) ? allergens.join(", ") : "",
    compliance: {
      vegan: (compliance.vegan as ComplianceValue) ?? "",
      organic: (compliance.organic as ComplianceValue) ?? "",
      halal: (compliance.halal as ComplianceValue) ?? "",
      kosher: (compliance.kosher as ComplianceValue) ?? "",
    },
    actives,
    excipients_mg,
  };
}


/**
 * Convert the draft back into the wire-format ``snapshot_overrides``
 * payload. Empty strings are dropped so the validator sees a clean
 * payload — empty = "no override", populated = override.
 */
function draftToPayload(draft: DraftState): SnapshotOverrides {
  const formulation: Record<string, string> = {};
  if (draft.directions_of_use) {
    formulation.directions_of_use = draft.directions_of_use;
  }
  if (draft.suggested_dosage) {
    formulation.suggested_dosage = draft.suggested_dosage;
  }
  if (draft.appearance) formulation.appearance = draft.appearance;
  if (draft.disintegration_spec) {
    formulation.disintegration_spec = draft.disintegration_spec;
  }

  const declaration: Record<string, string> = {};
  if (draft.declaration_text) declaration.text = draft.declaration_text;

  const allergens: { sources?: readonly string[] } = {};
  const csv = draft.allergens_csv.trim();
  if (csv) {
    allergens.sources = csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  const compliance: Record<string, "yes" | "no" | "unknown"> = {};
  for (const key of ["vegan", "organic", "halal", "kosher"] as const) {
    const v = draft.compliance[key];
    if (v === "yes" || v === "no" || v === "unknown") {
      compliance[key] = v;
    }
  }

  const actives: Record<string, { label_claim_mg?: string; nrv_pct?: string }> =
    {};
  for (const [id, vals] of Object.entries(draft.actives)) {
    const cleaned: { label_claim_mg?: string; nrv_pct?: string } = {};
    if (vals.label_claim_mg.trim()) {
      cleaned.label_claim_mg = vals.label_claim_mg.trim();
    }
    if (vals.nrv_pct.trim()) cleaned.nrv_pct = vals.nrv_pct.trim();
    if (Object.keys(cleaned).length > 0) actives[id] = cleaned;
  }

  const excipients_mg: Record<string, string> = {};
  for (const [slug, value] of Object.entries(draft.excipients_mg)) {
    const trimmed = value.trim();
    if (trimmed) excipients_mg[slug] = trimmed;
  }

  const payload: {
    formulation?: typeof formulation;
    declaration?: typeof declaration;
    allergens?: typeof allergens;
    compliance?: typeof compliance;
    actives?: typeof actives;
    excipients_mg?: typeof excipients_mg;
  } = {};
  if (Object.keys(formulation).length > 0) payload.formulation = formulation;
  if (Object.keys(declaration).length > 0) payload.declaration = declaration;
  if (Object.keys(allergens).length > 0) payload.allergens = allergens;
  if (Object.keys(compliance).length > 0) payload.compliance = compliance;
  if (Object.keys(actives).length > 0) payload.actives = actives;
  if (Object.keys(excipients_mg).length > 0) {
    payload.excipients_mg = excipients_mg;
  }
  return payload as SnapshotOverrides;
}


/**
 * Modal trigger that surfaces every G5a-editable field in one place
 * — directions / dosage / appearance / disintegration, declaration
 * text, allergens list, compliance flags, per-active claims. Each
 * input is empty by default; populating an input creates an
 * override on save, clearing it removes the override and falls back
 * to the snapshot value.
 */
export function EditOverridesButton({
  orgId,
  sheet,
  rendered,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
  rendered: RenderedSheetContext;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(() =>
    draftFromOverrides(sheet.snapshot_overrides, rendered),
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useUpdateSpecification(orgId, sheet.id);

  // Re-hydrate when the modal opens so a freshly-loaded sheet wipes
  // any stale draft state from a previous session.
  useEffect(() => {
    if (!isOpen) return;
    setDraft(draftFromOverrides(sheet.snapshot_overrides, rendered));
    setError(null);
  }, [isOpen, sheet.snapshot_overrides, rendered]);

  // Count of currently-active overrides — surfaces on the trigger as
  // a small badge so scientists can tell at a glance whether the
  // sheet has any client-specific tweaks applied.
  const activeOverrideCount = useMemo(() => {
    const o = sheet.snapshot_overrides ?? {};
    let count = 0;
    if (o.formulation) {
      count += Object.values(o.formulation).filter((v) => v).length;
    }
    if (o.declaration?.text) count += 1;
    if (o.allergens?.sources && o.allergens.sources.length > 0) count += 1;
    if (o.compliance) count += Object.keys(o.compliance).length;
    if (o.actives) {
      for (const lineOverrides of Object.values(o.actives)) {
        count += Object.keys(lineOverrides ?? {}).length;
      }
    }
    if (o.excipients_mg) {
      count += Object.keys(o.excipients_mg).length;
    }
    return count;
  }, [sheet.snapshot_overrides]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      await mutation.mutateAsync({
        snapshot_overrides: draftToPayload(draft),
      });
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const handleResetAll = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ snapshot_overrides: {} });
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const setForm = <K extends keyof DraftState>(
    key: K,
    value: DraftState[K],
  ) => setDraft((prev) => ({ ...prev, [key]: value }));

  const setComplianceValue = (
    key: keyof DraftState["compliance"],
    value: ComplianceValue,
  ) =>
    setDraft((prev) => ({
      ...prev,
      compliance: { ...prev.compliance, [key]: value },
    }));

  const setExcipientMg = (slug: string, value: string) =>
    setDraft((prev) => ({
      ...prev,
      excipients_mg: { ...prev.excipients_mg, [slug]: value },
    }));

  // Flatten the rendered excipients into a single edit list — typed
  // cells (water/gummy_base/mg_stearate/silica/mcc/dcp) plus per-row
  // entries from ``excipients.rows`` and ``gummy_base_rows``. Empty
  // values fall back to the snapshot mg via the input's placeholder.
  const editableExcipients: ReadonlyArray<{
    readonly slug: string;
    readonly label: string;
    readonly snapshotMg: string;
  }> = useMemo(() => {
    const ex = rendered.totals.excipients;
    if (!ex) return [];
    const out: { slug: string; label: string; snapshotMg: string }[] = [];
    if (ex.water_mg) out.push({ slug: "water_mg", label: "Water", snapshotMg: ex.water_mg });
    if (ex.gummy_base_mg) {
      out.push({
        slug: "gummy_base_mg",
        label: "Gummy Base (total)",
        snapshotMg: ex.gummy_base_mg,
      });
    }
    if (ex.mg_stearate_mg && Number(ex.mg_stearate_mg) > 0) {
      out.push({
        slug: "mg_stearate_mg",
        label: "Magnesium Stearate",
        snapshotMg: ex.mg_stearate_mg,
      });
    }
    if (ex.silica_mg && Number(ex.silica_mg) > 0) {
      out.push({
        slug: "silica_mg",
        label: "Silicon Dioxide",
        snapshotMg: ex.silica_mg,
      });
    }
    if (ex.mcc_mg && Number(ex.mcc_mg) > 0) {
      out.push({
        slug: "mcc_mg",
        label: "Microcrystalline Cellulose",
        snapshotMg: ex.mcc_mg,
      });
    }
    if (ex.dcp_mg && Number(ex.dcp_mg) > 0) {
      out.push({
        slug: "dcp_mg",
        label: "Dicalcium Phosphate",
        snapshotMg: ex.dcp_mg,
      });
    }
    for (const r of ex.gummy_base_rows ?? []) {
      out.push({
        slug: `gummy_base:${r.item_id}`,
        label: r.label,
        snapshotMg: r.mg,
      });
    }
    for (const r of ex.rows ?? []) {
      out.push({
        slug: r.slug,
        label: r.label,
        snapshotMg: r.mg,
      });
    }
    return out;
  }, [rendered.totals.excipients]);

  const setActiveField = (
    itemId: string,
    field: "label_claim_mg" | "nrv_pct",
    value: string,
  ) =>
    setDraft((prev) => ({
      ...prev,
      actives: {
        ...prev.actives,
        [itemId]: {
          label_claim_mg:
            field === "label_claim_mg"
              ? value
              : prev.actives[itemId]?.label_claim_mg ?? "",
          nrv_pct:
            field === "nrv_pct" ? value : prev.actives[itemId]?.nrv_pct ?? "",
        },
      },
    }));

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) setError(null);
      }}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <Pencil className="h-4 w-4" />
            {tSpecs("overrides.trigger")}
            {activeOverrideCount > 0 ? (
              <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-ink-0">
                {activeOverrideCount}
              </span>
            ) : null}
          </span>
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tSpecs("overrides.title")}
                </Modal.Heading>
                {activeOverrideCount > 0 ? (
                  <button
                    type="button"
                    onClick={handleResetAll}
                    disabled={mutation.isPending}
                    className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-1000 disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {tSpecs("overrides.reset_all")}
                  </button>
                ) : null}
              </Modal.Header>
              <Modal.Body className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tSpecs("overrides.subtitle")}
                </p>

                {/* Formulation metadata overrides */}
                <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-2">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("overrides.group.formulation")}
                  </legend>
                  <TextAreaField
                    label={tSpecs("overrides.directions_of_use")}
                    placeholder={
                      rendered.formulation.directions_of_use ||
                      tSpecs("overrides.fallback_placeholder")
                    }
                    value={draft.directions_of_use}
                    onChange={(v) => setForm("directions_of_use", v)}
                    hint={tSpecs("overrides.fallback_hint")}
                  />
                  <TextAreaField
                    label={tSpecs("overrides.suggested_dosage")}
                    placeholder={
                      rendered.formulation.suggested_dosage ||
                      tSpecs("overrides.fallback_placeholder")
                    }
                    value={draft.suggested_dosage}
                    onChange={(v) => setForm("suggested_dosage", v)}
                    hint={tSpecs("overrides.fallback_hint")}
                  />
                  <TextField
                    label={tSpecs("overrides.appearance")}
                    placeholder={
                      rendered.formulation.appearance ||
                      tSpecs("overrides.fallback_placeholder")
                    }
                    value={draft.appearance}
                    onChange={(v) => setForm("appearance", v)}
                    hint={tSpecs("overrides.fallback_hint")}
                  />
                  <TextField
                    label={tSpecs("overrides.disintegration_spec")}
                    placeholder={
                      rendered.formulation.disintegration_spec ||
                      tSpecs("overrides.fallback_placeholder")
                    }
                    value={draft.disintegration_spec}
                    onChange={(v) => setForm("disintegration_spec", v)}
                    hint={tSpecs("overrides.fallback_hint")}
                  />
                </fieldset>

                {/* Declaration text override */}
                <fieldset className="rounded-xl border border-ink-100 p-4">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("overrides.group.declaration")}
                  </legend>
                  <TextAreaField
                    label={tSpecs("overrides.declaration_text")}
                    placeholder={tSpecs("overrides.declaration_placeholder")}
                    value={draft.declaration_text}
                    onChange={(v) => setForm("declaration_text", v)}
                    hint={tSpecs("overrides.declaration_hint")}
                    rows={4}
                  />
                </fieldset>

                {/* Allergens override */}
                <fieldset className="rounded-xl border border-ink-100 p-4">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("overrides.group.allergens")}
                  </legend>
                  <TextField
                    label={tSpecs("overrides.allergens")}
                    placeholder={
                      rendered.allergens.sources.length > 0
                        ? rendered.allergens.sources.join(", ")
                        : tSpecs("overrides.allergens_placeholder")
                    }
                    value={draft.allergens_csv}
                    onChange={(v) => setForm("allergens_csv", v)}
                    hint={tSpecs("overrides.allergens_hint")}
                  />
                </fieldset>

                {/* Compliance overrides */}
                <fieldset className="grid grid-cols-2 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-4">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    {tSpecs("overrides.group.compliance")}
                  </legend>
                  {(["vegan", "organic", "halal", "kosher"] as const).map(
                    (key) => (
                      <ComplianceSelect
                        key={key}
                        label={tSpecs(
                          `overrides.compliance_${key}` as
                            | "overrides.compliance_vegan",
                        )}
                        value={draft.compliance[key]}
                        onChange={(v) => setComplianceValue(key, v)}
                        tSpecs={tSpecs}
                      />
                    ),
                  )}
                </fieldset>

                {/* Per-active claim + NRV */}
                {rendered.actives.length > 0 ? (
                  <fieldset className="rounded-xl border border-ink-100 p-4">
                    <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                      {tSpecs("overrides.group.actives")}
                    </legend>
                    <p className={`mb-2 ${HINT_CLASS}`}>
                      {tSpecs("overrides.actives_hint")}
                    </p>
                    <table className="w-full text-xs">
                      <thead className="border-b border-ink-200 text-ink-500">
                        <tr>
                          <th className="px-1 py-1 text-left font-medium">
                            {tSpecs("overrides.actives_col_name")}
                          </th>
                          <th className="px-1 py-1 text-right font-medium">
                            {tSpecs("overrides.actives_col_claim")}
                          </th>
                          <th className="px-1 py-1 text-right font-medium">
                            {tSpecs("overrides.actives_col_nrv")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rendered.actives.map((active) => {
                          const id = active.item_id;
                          if (!id) return null;
                          const cur = draft.actives[id] ?? {
                            label_claim_mg: "",
                            nrv_pct: "",
                          };
                          return (
                            <tr key={id} className="border-b border-ink-100">
                              <td className="px-1 py-1.5 text-ink-1000">
                                {active.ingredient_list_name ||
                                  active.item_name}
                              </td>
                              <td className="px-1 py-1.5 text-right">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={cur.label_claim_mg}
                                  placeholder={active.label_claim_mg}
                                  onChange={(e) =>
                                    setActiveField(
                                      id,
                                      "label_claim_mg",
                                      e.target.value,
                                    )
                                  }
                                  className="w-24 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                />
                              </td>
                              <td className="px-1 py-1.5 text-right">
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={cur.nrv_pct}
                                  placeholder={active.nrv_percent ?? "—"}
                                  onChange={(e) =>
                                    setActiveField(
                                      id,
                                      "nrv_pct",
                                      e.target.value,
                                    )
                                  }
                                  className="w-20 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </fieldset>
                ) : null}

                {/* Per-row excipient mg overrides */}
                {editableExcipients.length > 0 ? (
                  <fieldset className="rounded-xl border border-ink-100 p-4">
                    <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                      {tSpecs("overrides.group.excipients")}
                    </legend>
                    <p className={`mb-2 ${HINT_CLASS}`}>
                      {tSpecs("overrides.excipients_hint")}
                    </p>
                    <table className="w-full text-xs">
                      <thead className="border-b border-ink-200 text-ink-500">
                        <tr>
                          <th className="px-1 py-1 text-left font-medium">
                            {tSpecs("overrides.excipients_col_name")}
                          </th>
                          <th className="px-1 py-1 text-right font-medium">
                            {tSpecs("overrides.excipients_col_mg")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {editableExcipients.map((row) => (
                          <tr key={row.slug} className="border-b border-ink-100">
                            <td className="px-1 py-1.5 text-ink-1000">
                              {row.label}
                            </td>
                            <td className="px-1 py-1.5 text-right">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={draft.excipients_mg[row.slug] ?? ""}
                                placeholder={row.snapshotMg ?? ""}
                                onChange={(e) =>
                                  setExcipientMg(row.slug, e.target.value)
                                }
                                className="w-24 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </fieldset>
                ) : null}

                {error ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-2 border-t border-ink-200 bg-ink-50 px-6 py-3">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={() => setIsOpen(false)}
                >
                  {tSpecs("overrides.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={mutation.isPending}
                >
                  {tSpecs("overrides.save")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL_CLASS}>{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT_CLASS}
      />
      {hint ? <p className={HINT_CLASS}>{hint}</p> : null}
    </label>
  );
}


function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  rows?: number;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL_CLASS}>{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className={INPUT_CLASS}
      />
      {hint ? <p className={HINT_CLASS}>{hint}</p> : null}
    </label>
  );
}


function ComplianceSelect({
  label,
  value,
  onChange,
  tSpecs,
}: {
  label: string;
  value: ComplianceValue;
  onChange: (value: ComplianceValue) => void;
  tSpecs: ReturnType<typeof useTranslations<"specifications">>;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className={LABEL_CLASS}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ComplianceValue)}
        className={`${INPUT_CLASS} cursor-pointer`}
      >
        <option value="">
          {tSpecs("overrides.compliance_unset")}
        </option>
        <option value="yes">
          {tSpecs("overrides.compliance_yes")}
        </option>
        <option value="no">{tSpecs("overrides.compliance_no")}</option>
        <option value="unknown">
          {tSpecs("overrides.compliance_unknown")}
        </option>
      </select>
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
