"use client";

import { Button, Modal } from "@heroui/react";
import { Pencil, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
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
  actives: Record<
    string,
    { label_claim_mg: string; nrv_pct: string; ingredient_list_name: string }
  >;
  // Per-excipient-row mg override keyed by row slug (``water_mg``,
  // ``gummy_base_mg``, ``acidity``, ``flavouring:<id>``, etc.).
  // Empty strings clear the override on save.
  excipients_mg: Record<string, string>;
  // Per-excipient-row LABEL override (same slug vocabulary as
  // ``excipients_mg``). Empty string keeps the snapshot label.
  excipients_label: Record<string, string>;
  // Capsule-shell row override (label + mg). Both empty = no override.
  capsule_shell: { label: string; mg: string };
  // Per-nutrition-row override keyed by row slug. Each row has two
  // editable cells; empty cells fall back to the snapshot.
  nutrition: Record<
    string,
    { amount_per_100g: string; amount_per_serving: string }
  >;
  // Per-amino-acid override: outer key is the group slug, inner key
  // is the acid key, value is the mg-per-serving string.
  amino_acids: Record<string, Record<string, string>>;
  // Microbiological / heavy-metal / pesticide spec limits keyed by
  // the canonical slug (``total_aerobic``, ``e_coli``, ...).
  limits: Record<string, string>;
  // Per-cell metadata fields surfaced on the Product Specification
  // block. Empty cells fall back to the sheet-model field or the
  // snapshot value, whichever the renderer normally uses.
  metadata: {
    filled_total_mg: string;
    total_weight_label: string;
    weight_uniformity: string;
    powder_per_serving_mg: string;
    powder_pack_total_mg: string;
  };
}


/**
 * Build the initial draft from the current ``snapshot_overrides``
 * map. Fields that are not currently overridden seed as empty
 * strings so the inputs stay blank instead of filling with the
 * computed value (which would flip every render into an override
 * the moment the user clicks "Save").
 */
/**
 * Allergens roundtrip as a comma-separated string in the modal but
 * the wire format is an array of source names. Build a stable CSV the
 * baseline-equality check below can compare against without
 * worrying about whitespace drift.
 */
function allergenSourcesCsv(rendered: RenderedSheetContext): string {
  const sources = (rendered.allergens?.sources ?? []) as readonly string[];
  return sources.join(", ");
}


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

  // Pre-populate every input with the **current** rendered value
  // (override-if-set, otherwise the snapshot baseline) so the
  // scientist can see what each field is set to without flipping
  // back to the spec sheet. Save-time logic below diffs against the
  // baseline so unchanged fields don't get persisted as overrides
  // and the "active overrides" badge stays honest.
  const actives: DraftState["actives"] = {};
  for (const active of rendered.actives) {
    const id = active.item_id;
    if (!id) continue;
    const o = activesOverride[id];
    actives[id] = {
      label_claim_mg: o?.label_claim_mg ?? (active.label_claim_mg ?? ""),
      nrv_pct: o?.nrv_pct ?? (active.nrv_percent ?? ""),
      ingredient_list_name:
        o?.ingredient_list_name ?? (active.ingredient_list_name ?? ""),
    };
  }

  // Excipient-mg seeds: prefer the existing override; fall back to
  // the snapshot mg pulled off ``totals.excipients`` (the typed cells
  // and per-row entries the modal renders inputs for).
  const excipients_mg: Record<string, string> = {};
  const ex = rendered.totals.excipients;
  if (ex) {
    const seedFromSnapshot = (slug: string, snapshotMg: string | null | undefined) => {
      const overridden = excipientsMgOverride[slug];
      if (typeof overridden === "string") {
        excipients_mg[slug] = overridden;
        return;
      }
      if (snapshotMg) excipients_mg[slug] = snapshotMg;
    };
    if (ex.water_mg) seedFromSnapshot("water_mg", ex.water_mg);
    if (ex.gummy_base_mg) seedFromSnapshot("gummy_base_mg", ex.gummy_base_mg);
    if (ex.mg_stearate_mg && Number(ex.mg_stearate_mg) > 0) {
      seedFromSnapshot("mg_stearate_mg", ex.mg_stearate_mg);
    }
    if (ex.silica_mg && Number(ex.silica_mg) > 0) {
      seedFromSnapshot("silica_mg", ex.silica_mg);
    }
    if (ex.mcc_mg && Number(ex.mcc_mg) > 0) {
      seedFromSnapshot("mcc_mg", ex.mcc_mg);
    }
    if (ex.dcp_mg && Number(ex.dcp_mg) > 0) {
      seedFromSnapshot("dcp_mg", ex.dcp_mg);
    }
    for (const r of ex.gummy_base_rows ?? []) {
      seedFromSnapshot(`gummy_base:${r.item_id}`, r.mg);
    }
    for (const r of ex.rows ?? []) {
      seedFromSnapshot(r.slug, r.mg);
    }
  }
  // Pick up override-only slugs (e.g. an excipient that was zeroed
  // out and so isn't listed in ``totals.excipients`` anymore) so the
  // modal still surfaces them for editing.
  for (const [key, value] of Object.entries(excipientsMgOverride)) {
    if (typeof value === "string" && excipients_mg[key] === undefined) {
      excipients_mg[key] = value;
    }
  }

  // Excipient-label seeds: prefer the existing override, otherwise
  // pull the current displayed label off the rendered declaration
  // entries (which is what the spec sheet excipient table renders).
  const excipients_label: Record<string, string> = {};
  const labelOverrides = (overrides?.excipients_label ?? {}) as Record<
    string,
    string
  >;
  for (const slug of Object.keys(excipients_mg)) {
    excipients_label[slug] = labelOverrides[slug] ?? "";
  }

  // Capsule-shell seed.
  const shellOverride = (overrides?.capsule_shell ?? {}) as {
    label?: string;
    mg?: string;
  };
  // Pull the shell entry from the rendered declaration so the modal
  // can pre-fill its label / mg.
  const shellEntry = (rendered.declaration?.entries ?? []).find(
    (e) => e.category === "shell",
  );
  const capsule_shell = {
    label: shellOverride.label ?? (shellEntry?.label ?? ""),
    mg: shellOverride.mg ?? (shellEntry?.mg ?? ""),
  };

  // Nutrition seeds. Use the rendered rows to know which slugs to
  // expose; pre-fill each cell with the override-or-snapshot value.
  const nutritionOverrides = (overrides?.nutrition ?? {}) as Record<
    string,
    { amount_per_100g?: string; amount_per_serving?: string }
  >;
  const nutrition: DraftState["nutrition"] = {};
  for (const row of rendered.nutrition?.rows ?? []) {
    const slug = (row as { slug?: string; key?: string }).slug
      ?? (row as { slug?: string; key?: string }).key
      ?? "";
    if (!slug) continue;
    const ov = nutritionOverrides[slug] ?? {};
    nutrition[slug] = {
      amount_per_100g:
        ov.amount_per_100g
        ?? ((row as { amount_per_100g?: string }).amount_per_100g ?? ""),
      amount_per_serving:
        ov.amount_per_serving
        ?? ((row as { amount_per_serving?: string }).amount_per_serving ?? ""),
    };
  }

  // Amino acid seeds.
  const aminoAcidsOverrides = (overrides?.amino_acids ?? {}) as Record<
    string,
    Record<string, string>
  >;
  const amino_acids: DraftState["amino_acids"] = {};
  for (const group of rendered.amino_acids?.groups ?? []) {
    const groupSlug = (group as { slug?: string; key?: string }).slug
      ?? (group as { slug?: string; key?: string }).key
      ?? "";
    if (!groupSlug) continue;
    const groupOv = aminoAcidsOverrides[groupSlug] ?? {};
    amino_acids[groupSlug] = {};
    for (const acid of (group as { acids?: ReadonlyArray<unknown> }).acids ?? []) {
      const a = acid as { key?: string; slug?: string; amount_per_serving?: string };
      const acidKey = a.key ?? a.slug ?? "";
      if (!acidKey) continue;
      amino_acids[groupSlug]![acidKey] =
        groupOv[acidKey] ?? (a.amount_per_serving ?? "");
    }
  }

  // Limits seeds.
  const limitsOverrides = (overrides?.limits ?? {}) as Record<string, string>;
  const limits: Record<string, string> = {};
  for (const row of rendered.limits ?? []) {
    const slug = row.slug ?? "";
    if (!slug) continue;
    limits[slug] = limitsOverrides[slug] ?? (row.value ?? "");
  }

  const metadataOverrides = (overrides?.metadata ?? {}) as {
    filled_total_mg?: string;
    total_weight_label?: string;
    weight_uniformity?: string;
    powder_per_serving_mg?: string;
    powder_pack_total_mg?: string;
  };
  const metadata = {
    filled_total_mg:
      metadataOverrides.filled_total_mg
      ?? (rendered.totals.filled_total_mg ?? ""),
    total_weight_label:
      metadataOverrides.total_weight_label
      ?? (rendered.sheet.total_weight_label ?? ""),
    weight_uniformity:
      metadataOverrides.weight_uniformity ?? (rendered.weight_uniformity ?? ""),
    powder_per_serving_mg:
      metadataOverrides.powder_per_serving_mg
      ?? (rendered.totals.powder_per_serving_mg ?? ""),
    powder_pack_total_mg:
      metadataOverrides.powder_pack_total_mg
      ?? (rendered.totals.powder_pack_total_mg ?? ""),
  };

  return {
    directions_of_use:
      formulation.directions_of_use ?? (rendered.formulation.directions_of_use ?? ""),
    suggested_dosage:
      formulation.suggested_dosage ?? (rendered.formulation.suggested_dosage ?? ""),
    appearance: formulation.appearance ?? (rendered.formulation.appearance ?? ""),
    disintegration_spec:
      formulation.disintegration_spec
      ?? (rendered.formulation.disintegration_spec ?? ""),
    declaration_text: declaration.text ?? "",
    allergens_csv:
      Array.isArray(allergens) ? allergens.join(", ") : allergenSourcesCsv(rendered),
    compliance: {
      vegan: (compliance.vegan as ComplianceValue) ?? "",
      organic: (compliance.organic as ComplianceValue) ?? "",
      halal: (compliance.halal as ComplianceValue) ?? "",
      kosher: (compliance.kosher as ComplianceValue) ?? "",
    },
    actives,
    excipients_mg,
    excipients_label,
    capsule_shell,
    nutrition,
    amino_acids,
    limits,
    metadata,
  };
}


/**
 * Deep-clone the existing snapshot_overrides so we can mutate it
 * without churning React state. JSON roundtrip is fine here — the
 * payload is plain JSON.
 */
function cloneOverrides(value: SnapshotOverrides | undefined): SnapshotOverrides {
  return value ? JSON.parse(JSON.stringify(value)) : {};
}


/**
 * Convert the draft back into the wire-format ``snapshot_overrides``
 * payload by diffing the draft against the *initial* draft captured
 * when the modal opened, then layering only those edits on top of
 * ``existing`` (the sheet's current saved overrides).
 *
 * Why this shape: the modal pre-populates every input with the
 * field's current value (override-if-set, otherwise the snapshot
 * baseline) so the scientist sees what each field is at without
 * flipping back to the spec sheet. Naively persisting every
 * populated input would silently pin every baseline value as an
 * override the moment Save was clicked, freezing the sheet against
 * future formulation recomputes. The PATCH endpoint replaces the
 * full ``snapshot_overrides`` map, so we have to send the *complete
 * desired state* — that's ``existing`` for fields the user did not
 * touch + the user's edits for fields they did. Clearing an input
 * removes the override; typing the same value the modal opened with
 * is a no-op.
 */
function draftToPayload(
  draft: DraftState,
  initial: DraftState,
  existing: SnapshotOverrides | undefined,
): SnapshotOverrides {
  const payload = cloneOverrides(existing) as {
    formulation?: Record<string, string>;
    declaration?: { text?: string };
    allergens?: { sources?: string[] };
    compliance?: Record<string, "yes" | "no" | "unknown">;
    actives?: Record<
      string,
      {
        label_claim_mg?: string;
        nrv_pct?: string;
        ingredient_list_name?: string;
      }
    >;
    excipients_mg?: Record<string, string>;
    excipients_label?: Record<string, string>;
    capsule_shell?: { label?: string; mg?: string };
    nutrition?: Record<
      string,
      { amount_per_100g?: string; amount_per_serving?: string }
    >;
    amino_acids?: Record<string, Record<string, string>>;
    limits?: Record<string, string>;
    metadata?: {
      filled_total_mg?: string;
      total_weight_label?: string;
      weight_uniformity?: string;
      powder_per_serving_mg?: string;
      powder_pack_total_mg?: string;
    };
  };

  const setOrClear = <T extends Record<string, string>>(
    section: T | undefined,
    key: string,
    next: string,
  ): T | undefined => {
    const map = (section ?? {}) as Record<string, string>;
    if (next) map[key] = next;
    else delete map[key];
    if (Object.keys(map).length === 0) return undefined;
    return map as T;
  };

  for (const key of [
    "directions_of_use",
    "suggested_dosage",
    "appearance",
    "disintegration_spec",
  ] as const) {
    if (draft[key] !== initial[key]) {
      payload.formulation = setOrClear(
        payload.formulation,
        key,
        draft[key],
      ) as Record<string, string> | undefined;
    }
  }

  if (draft.declaration_text !== initial.declaration_text) {
    if (draft.declaration_text) {
      payload.declaration = { text: draft.declaration_text };
    } else {
      delete payload.declaration;
    }
  }

  if (draft.allergens_csv.trim() !== initial.allergens_csv.trim()) {
    const csv = draft.allergens_csv.trim();
    if (csv) {
      payload.allergens = {
        sources: csv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    } else {
      delete payload.allergens;
    }
  }

  for (const key of ["vegan", "organic", "halal", "kosher"] as const) {
    if (draft.compliance[key] !== initial.compliance[key]) {
      const v = draft.compliance[key];
      if (v === "yes" || v === "no" || v === "unknown") {
        payload.compliance = setOrClear(
          payload.compliance as Record<string, string> | undefined,
          key,
          v,
        ) as Record<string, "yes" | "no" | "unknown"> | undefined;
      } else {
        // Cleared — drop just this flag from the existing payload.
        if (payload.compliance) {
          delete payload.compliance[key];
          if (Object.keys(payload.compliance).length === 0) {
            delete payload.compliance;
          }
        }
      }
    }
  }

  for (const [id, vals] of Object.entries(draft.actives)) {
    const initialVals = initial.actives[id] ?? {
      label_claim_mg: "",
      nrv_pct: "",
      ingredient_list_name: "",
    };
    const claimChanged =
      vals.label_claim_mg.trim() !== initialVals.label_claim_mg.trim();
    const nrvChanged = vals.nrv_pct.trim() !== initialVals.nrv_pct.trim();
    const nameChanged =
      vals.ingredient_list_name.trim()
      !== initialVals.ingredient_list_name.trim();
    if (!claimChanged && !nrvChanged && !nameChanged) continue;

    const lineMap =
      payload.actives?.[id] ?? ({} as {
        label_claim_mg?: string;
        nrv_pct?: string;
        ingredient_list_name?: string;
      });
    if (claimChanged) {
      const next = vals.label_claim_mg.trim();
      if (next) lineMap.label_claim_mg = next;
      else delete lineMap.label_claim_mg;
    }
    if (nrvChanged) {
      const next = vals.nrv_pct.trim();
      if (next) lineMap.nrv_pct = next;
      else delete lineMap.nrv_pct;
    }
    if (nameChanged) {
      const next = vals.ingredient_list_name.trim();
      if (next) lineMap.ingredient_list_name = next;
      else delete lineMap.ingredient_list_name;
    }
    payload.actives = payload.actives ?? {};
    if (Object.keys(lineMap).length === 0) {
      delete payload.actives[id];
    } else {
      payload.actives[id] = lineMap;
    }
    if (payload.actives && Object.keys(payload.actives).length === 0) {
      delete payload.actives;
    }
  }

  // Layer excipient-mg edits on top, walking the union of both sides
  // so a slug that was removed from the modal (e.g. an excipient row
  // that no longer exists) gets cleared if it had been overridden.
  const allMgSlugs = new Set([
    ...Object.keys(draft.excipients_mg),
    ...Object.keys(initial.excipients_mg),
  ]);
  for (const slug of allMgSlugs) {
    const before = (initial.excipients_mg[slug] ?? "").trim();
    const after = (draft.excipients_mg[slug] ?? "").trim();
    if (after === before) continue;
    payload.excipients_mg = setOrClear(
      payload.excipients_mg,
      slug,
      after,
    ) as Record<string, string> | undefined;
  }

  const allLabelSlugs = new Set([
    ...Object.keys(draft.excipients_label),
    ...Object.keys(initial.excipients_label),
  ]);
  for (const slug of allLabelSlugs) {
    const before = (initial.excipients_label[slug] ?? "").trim();
    const after = (draft.excipients_label[slug] ?? "").trim();
    if (after === before) continue;
    payload.excipients_label = setOrClear(
      payload.excipients_label,
      slug,
      after,
    ) as Record<string, string> | undefined;
  }

  // Capsule shell — both keys flip together.
  const shellLabelChanged =
    draft.capsule_shell.label.trim() !== initial.capsule_shell.label.trim();
  const shellMgChanged =
    draft.capsule_shell.mg.trim() !== initial.capsule_shell.mg.trim();
  if (shellLabelChanged || shellMgChanged) {
    const shellMap = (payload.capsule_shell ?? {}) as {
      label?: string;
      mg?: string;
    };
    if (shellLabelChanged) {
      const next = draft.capsule_shell.label.trim();
      if (next) shellMap.label = next;
      else delete shellMap.label;
    }
    if (shellMgChanged) {
      const next = draft.capsule_shell.mg.trim();
      if (next) shellMap.mg = next;
      else delete shellMap.mg;
    }
    if (Object.keys(shellMap).length === 0) {
      delete payload.capsule_shell;
    } else {
      payload.capsule_shell = shellMap;
    }
  }

  // Nutrition — nested two-level diff per row.
  const nutritionSlugs = new Set([
    ...Object.keys(draft.nutrition),
    ...Object.keys(initial.nutrition),
  ]);
  for (const slug of nutritionSlugs) {
    const before = initial.nutrition[slug] ?? {
      amount_per_100g: "",
      amount_per_serving: "",
    };
    const after = draft.nutrition[slug] ?? {
      amount_per_100g: "",
      amount_per_serving: "",
    };
    const per100Changed =
      after.amount_per_100g.trim() !== before.amount_per_100g.trim();
    const perServingChanged =
      after.amount_per_serving.trim() !== before.amount_per_serving.trim();
    if (!per100Changed && !perServingChanged) continue;
    const rowMap = (payload.nutrition?.[slug] ?? {}) as {
      amount_per_100g?: string;
      amount_per_serving?: string;
    };
    if (per100Changed) {
      const next = after.amount_per_100g.trim();
      if (next) rowMap.amount_per_100g = next;
      else delete rowMap.amount_per_100g;
    }
    if (perServingChanged) {
      const next = after.amount_per_serving.trim();
      if (next) rowMap.amount_per_serving = next;
      else delete rowMap.amount_per_serving;
    }
    payload.nutrition = payload.nutrition ?? {};
    if (Object.keys(rowMap).length === 0) {
      delete payload.nutrition[slug];
    } else {
      payload.nutrition[slug] = rowMap;
    }
    if (payload.nutrition && Object.keys(payload.nutrition).length === 0) {
      delete payload.nutrition;
    }
  }

  // Amino acids — nested two-level diff per group / acid.
  const acidGroupSlugs = new Set([
    ...Object.keys(draft.amino_acids),
    ...Object.keys(initial.amino_acids),
  ]);
  for (const groupSlug of acidGroupSlugs) {
    const before = initial.amino_acids[groupSlug] ?? {};
    const after = draft.amino_acids[groupSlug] ?? {};
    const allAcidKeys = new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ]);
    const groupMap = (payload.amino_acids?.[groupSlug] ?? {}) as Record<
      string,
      string
    >;
    let touched = false;
    for (const key of allAcidKeys) {
      const b = (before[key] ?? "").trim();
      const a = (after[key] ?? "").trim();
      if (a === b) continue;
      touched = true;
      if (a) groupMap[key] = a;
      else delete groupMap[key];
    }
    if (!touched) continue;
    payload.amino_acids = payload.amino_acids ?? {};
    if (Object.keys(groupMap).length === 0) {
      delete payload.amino_acids[groupSlug];
    } else {
      payload.amino_acids[groupSlug] = groupMap;
    }
    if (
      payload.amino_acids
      && Object.keys(payload.amino_acids).length === 0
    ) {
      delete payload.amino_acids;
    }
  }

  // Limits — flat slug → value diff.
  const allLimitSlugs = new Set([
    ...Object.keys(draft.limits),
    ...Object.keys(initial.limits),
  ]);
  for (const slug of allLimitSlugs) {
    const before = (initial.limits[slug] ?? "").trim();
    const after = (draft.limits[slug] ?? "").trim();
    if (after === before) continue;
    payload.limits = setOrClear(
      payload.limits,
      slug,
      after,
    ) as Record<string, string> | undefined;
  }

  // Metadata — fixed-key diff.
  for (const key of [
    "filled_total_mg",
    "total_weight_label",
    "weight_uniformity",
    "powder_per_serving_mg",
    "powder_pack_total_mg",
  ] as const) {
    if (draft.metadata[key] !== initial.metadata[key]) {
      payload.metadata = setOrClear(
        payload.metadata as Record<string, string> | undefined,
        key,
        draft.metadata[key],
      ) as DraftState["metadata"] | undefined;
    }
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
  // Frozen copy of the draft as the modal opened. Save-time logic
  // diffs the live ``draft`` against this baseline so unchanged
  // pre-populated fields don't get persisted as overrides.
  const [initialDraft, setInitialDraft] = useState<DraftState>(() =>
    draftFromOverrides(sheet.snapshot_overrides, rendered),
  );
  const [error, setError] = useState<string | null>(null);

  const mutation = useUpdateSpecification(orgId, sheet.id);

  // Re-hydrate when the modal opens so a freshly-loaded sheet wipes
  // any stale draft state from a previous session.
  useEffect(() => {
    if (!isOpen) return;
    const fresh = draftFromOverrides(sheet.snapshot_overrides, rendered);
    setDraft(fresh);
    setInitialDraft(fresh);
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
        snapshot_overrides: draftToPayload(
          draft,
          initialDraft,
          sheet.snapshot_overrides,
        ),
      });
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  const handleResetAll = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ snapshot_overrides: {} });
      setIsOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
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
    field: "label_claim_mg" | "nrv_pct" | "ingredient_list_name",
    value: string,
  ) =>
    setDraft((prev) => {
      const current = prev.actives[itemId] ?? {
        label_claim_mg: "",
        nrv_pct: "",
        ingredient_list_name: "",
      };
      return {
        ...prev,
        actives: {
          ...prev.actives,
          [itemId]: {
            ...current,
            [field]: value,
          },
        },
      };
    });

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
                            Display name
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
                            ingredient_list_name: "",
                          };
                          return (
                            <tr key={id} className="border-b border-ink-100">
                              <td className="px-1 py-1.5">
                                <input
                                  type="text"
                                  value={cur.ingredient_list_name}
                                  placeholder={
                                    active.ingredient_list_name
                                    || active.item_name
                                  }
                                  onChange={(e) =>
                                    setActiveField(
                                      id,
                                      "ingredient_list_name",
                                      e.target.value,
                                    )
                                  }
                                  className="w-full rounded-md bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                />
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

                {/* Per-row excipient label + mg overrides */}
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
                            Label
                          </th>
                          <th className="px-1 py-1 text-right font-medium">
                            {tSpecs("overrides.excipients_col_mg")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {editableExcipients.map((row) => (
                          <tr key={row.slug} className="border-b border-ink-100">
                            <td className="px-1 py-1.5">
                              <input
                                type="text"
                                value={
                                  draft.excipients_label[row.slug] ?? ""
                                }
                                placeholder={row.label}
                                onChange={(e) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    excipients_label: {
                                      ...prev.excipients_label,
                                      [row.slug]: e.target.value,
                                    },
                                  }))
                                }
                                className="w-full rounded-md bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                              />
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

                {/* Capsule shell — single row, label + mg. */}
                {(rendered.declaration?.entries ?? []).some(
                  (e) => e.category === "shell",
                ) ? (
                  <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-2">
                    <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                      Capsule shell
                    </legend>
                    <TextField
                      label="Label"
                      value={draft.capsule_shell.label}
                      placeholder=""
                      onChange={(v) =>
                        setDraft((prev) => ({
                          ...prev,
                          capsule_shell: { ...prev.capsule_shell, label: v },
                        }))
                      }
                    />
                    <TextField
                      label="Weight (mg)"
                      value={draft.capsule_shell.mg}
                      placeholder=""
                      onChange={(v) =>
                        setDraft((prev) => ({
                          ...prev,
                          capsule_shell: { ...prev.capsule_shell, mg: v },
                        }))
                      }
                    />
                  </fieldset>
                ) : null}

                {/* Nutrition rows */}
                {(rendered.nutrition?.rows ?? []).length > 0 ? (
                  <fieldset className="rounded-xl border border-ink-100 p-4">
                    <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                      Nutrition information
                    </legend>
                    <table className="w-full text-xs">
                      <thead className="border-b border-ink-200 text-ink-500">
                        <tr>
                          <th className="px-1 py-1 text-left font-medium">Row</th>
                          <th className="px-1 py-1 text-right font-medium">
                            Per 100g
                          </th>
                          <th className="px-1 py-1 text-right font-medium">
                            Per serving
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {(rendered.nutrition?.rows ?? []).map((row) => {
                          const r = row as {
                            slug?: string;
                            key?: string;
                            label?: string;
                            amount_per_100g?: string;
                            amount_per_serving?: string;
                          };
                          const slug = r.slug ?? r.key ?? "";
                          if (!slug) return null;
                          const cur = draft.nutrition[slug] ?? {
                            amount_per_100g: "",
                            amount_per_serving: "",
                          };
                          return (
                            <tr
                              key={slug}
                              className="border-b border-ink-100"
                            >
                              <td className="px-1 py-1.5 text-ink-1000">
                                {r.label ?? slug}
                              </td>
                              <td className="px-1 py-1.5 text-right">
                                <input
                                  type="text"
                                  value={cur.amount_per_100g}
                                  placeholder={r.amount_per_100g ?? ""}
                                  onChange={(e) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      nutrition: {
                                        ...prev.nutrition,
                                        [slug]: {
                                          amount_per_100g: e.target.value,
                                          amount_per_serving:
                                            prev.nutrition[slug]
                                              ?.amount_per_serving ?? "",
                                        },
                                      },
                                    }))
                                  }
                                  className="w-24 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                />
                              </td>
                              <td className="px-1 py-1.5 text-right">
                                <input
                                  type="text"
                                  value={cur.amount_per_serving}
                                  placeholder={r.amount_per_serving ?? ""}
                                  onChange={(e) =>
                                    setDraft((prev) => ({
                                      ...prev,
                                      nutrition: {
                                        ...prev.nutrition,
                                        [slug]: {
                                          amount_per_100g:
                                            prev.nutrition[slug]
                                              ?.amount_per_100g ?? "",
                                          amount_per_serving: e.target.value,
                                        },
                                      },
                                    }))
                                  }
                                  className="w-24 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </fieldset>
                ) : null}

                {/* Amino acids */}
                {(rendered.amino_acids?.groups ?? []).length > 0 ? (
                  <fieldset className="rounded-xl border border-ink-100 p-4">
                    <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                      Amino acids
                    </legend>
                    <div className="space-y-3">
                      {(rendered.amino_acids?.groups ?? []).map((group) => {
                        const g = group as {
                          slug?: string;
                          key?: string;
                          label?: string;
                          acids?: ReadonlyArray<{
                            key?: string;
                            slug?: string;
                            label?: string;
                            amount_per_serving?: string;
                          }>;
                        };
                        const groupSlug = g.slug ?? g.key ?? "";
                        if (!groupSlug) return null;
                        return (
                          <div key={groupSlug}>
                            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-ink-500">
                              {g.label ?? groupSlug}
                            </p>
                            <table className="w-full text-xs">
                              <tbody>
                                {(g.acids ?? []).map((acid) => {
                                  const acidKey = acid.key ?? acid.slug ?? "";
                                  if (!acidKey) return null;
                                  const cur =
                                    draft.amino_acids[groupSlug]?.[acidKey]
                                    ?? "";
                                  return (
                                    <tr
                                      key={acidKey}
                                      className="border-b border-ink-100"
                                    >
                                      <td className="px-1 py-1.5 text-ink-1000">
                                        {acid.label ?? acidKey}
                                      </td>
                                      <td className="px-1 py-1.5 text-right">
                                        <input
                                          type="text"
                                          value={cur}
                                          placeholder={
                                            acid.amount_per_serving ?? ""
                                          }
                                          onChange={(e) =>
                                            setDraft((prev) => ({
                                              ...prev,
                                              amino_acids: {
                                                ...prev.amino_acids,
                                                [groupSlug]: {
                                                  ...(prev.amino_acids[
                                                    groupSlug
                                                  ] ?? {}),
                                                  [acidKey]: e.target.value,
                                                },
                                              },
                                            }))
                                          }
                                          className="w-24 rounded-md bg-ink-0 px-2 py-1 text-right text-xs tabular-nums text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                                        />
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        );
                      })}
                    </div>
                  </fieldset>
                ) : null}

                {/* Limits */}
                {(rendered.limits ?? []).length > 0 ? (
                  <fieldset className="rounded-xl border border-ink-100 p-4">
                    <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                      Microbiological / heavy metal limits
                    </legend>
                    <table className="w-full text-xs">
                      <tbody>
                        {(rendered.limits ?? []).map((row) => (
                          <tr
                            key={row.slug}
                            className="border-b border-ink-100"
                          >
                            <td className="px-1 py-1.5 text-ink-1000">
                              {row.name}
                            </td>
                            <td className="px-1 py-1.5">
                              <input
                                type="text"
                                value={draft.limits[row.slug] ?? ""}
                                placeholder={row.value ?? ""}
                                onChange={(e) =>
                                  setDraft((prev) => ({
                                    ...prev,
                                    limits: {
                                      ...prev.limits,
                                      [row.slug]: e.target.value,
                                    },
                                  }))
                                }
                                className="w-full rounded-md bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-orange-400"
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </fieldset>
                ) : null}

                {/* Metadata: filled total weight, weight uniformity, etc. */}
                <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-ink-100 p-4 sm:grid-cols-2">
                  <legend className="px-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
                    Weight + tolerance
                  </legend>
                  <TextField
                    label="Filled total weight (mg)"
                    value={draft.metadata.filled_total_mg}
                    placeholder=""
                    onChange={(v) =>
                      setDraft((prev) => ({
                        ...prev,
                        metadata: { ...prev.metadata, filled_total_mg: v },
                      }))
                    }
                  />
                  <TextField
                    label="Total weight label"
                    value={draft.metadata.total_weight_label}
                    placeholder=""
                    onChange={(v) =>
                      setDraft((prev) => ({
                        ...prev,
                        metadata: {
                          ...prev.metadata,
                          total_weight_label: v,
                        },
                      }))
                    }
                  />
                  <TextField
                    label="Weight uniformity tolerance"
                    value={draft.metadata.weight_uniformity}
                    placeholder=""
                    onChange={(v) =>
                      setDraft((prev) => ({
                        ...prev,
                        metadata: { ...prev.metadata, weight_uniformity: v },
                      }))
                    }
                  />
                  <TextField
                    label="Powder per serving (mg)"
                    value={draft.metadata.powder_per_serving_mg}
                    placeholder=""
                    onChange={(v) =>
                      setDraft((prev) => ({
                        ...prev,
                        metadata: {
                          ...prev.metadata,
                          powder_per_serving_mg: v,
                        },
                      }))
                    }
                  />
                  <TextField
                    label="Powder pack total (mg)"
                    value={draft.metadata.powder_pack_total_mg}
                    placeholder=""
                    onChange={(v) =>
                      setDraft((prev) => ({
                        ...prev,
                        metadata: {
                          ...prev.metadata,
                          powder_pack_total_mg: v,
                        },
                      }))
                    }
                  />
                </fieldset>

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
