/**
 * Production-stage strip on the formulation builder.
 *
 * Renders the formulation's ordered ``FormulationStage`` graph as a
 * horizontal list of editable cards. Each card carries the stage's
 * name, PSP workstation-group pick, and setup / cycle time fields.
 * Save-to-server fires a wholesale-replace against
 * ``PUT /formulations/<id>/stages/`` and re-hydrates the builder
 * from the returned formulation DTO.
 *
 * The stage strip is what turns a flat BOM into a multi-level
 * cascade on PSP — each non-terminal stage becomes a semi-finished
 * item on the PSP side after the next ``save_version`` (see
 * ``push_bom_to_psp`` in ``server/apps/psp/services.py``).
 *
 * Scope for phase 4:
 * * List / add / remove / reorder stages.
 * * Pick workstation group per stage from PSP's catalogue.
 * * Set setup + cycle time per stage.
 * * Save the whole graph in one PUT.
 *
 * Deferred to a polish PR: drag-to-reorder, drag-line-between-
 * stages, fixed/variable-cost inputs.
 */

"use client";

import { Button } from "@heroui/react";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  useApplyStageTemplate,
  usePullPspBom,
  useStageTemplates,
  useUpsertStages,
} from "@/services/formulations/hooks";
import type {
  FormulationDto,
  FormulationStageDto,
  StageKey,
  UpsertStageInput,
} from "@/services/formulations/types";
import {
  usePspItemDetail,
  usePspProductFamilies,
  usePspUnitsOfMeasurement,
  usePspWorkstationGroups,
} from "@/services/psp/hooks";


/** Local edit-state for one stage. Kept as strings for the inputs
 *  so the operator can type freely without a Decimal parse on
 *  every keystroke — normalisation happens at save time. */
interface StageDraft {
  readonly clientKey: string;
  id?: string;
  sort_order: number;
  name: string;
  stage_key: StageKey;
  workstation_group_uuid: string | null;
  workstation_group_name: string;
  operation_description: string;
  setup_time_min: string;
  cycle_time_min: string;
  fixed_cost: string;
  variable_cost: string;
  capacity: string;
  other_fixed_cost: string;
  other_variable_cost: string;
  other_variable_cost_basis: string;
  worker_psp_uuids: readonly string[];
  // Phase 1 PSP identity fields (see FormulationStageDto). Kept as
  // strings on the draft so the inputs stay controlled without
  // converting on every keystroke.
  psp_item_type: "semi_finished" | "finished_product";
  // Optional override for the PSP item's display name. Blank falls
  // back to the auto-derived "{formulation.code} — {stage.name}".
  psp_item_name: string;
  psp_item_external_sku: string;
  psp_item_description: string;
  // Attributes bag rendered as an ordered key-value list on the
  // stage form. Storing as a plain object mirrors the DTO shape so
  // save-time is a no-op serialisation.
  psp_item_attributes: Record<string, unknown>;
  psp_item_barcode: string;
  psp_item_stock_uom_uuid: string | null;
  psp_item_product_family_uuid: string | null;
  // Phase 3 spec bag. Only edited on the finished stage — semi-
  // finished stages don't render the section (spec is a shipping
  // product concern per EU 1169). Empty object = no override.
  psp_finished_product_spec: Record<string, unknown>;
  // How many finished-good servings equal 1 stock-unit of this
  // stage's PSP output. Kept as a string on the draft so keystrokes
  // don't fight ``Decimal`` parsing; server-side ``_parse_positive_decimal``
  // does the coercion.
  servings_per_output_unit: string;
}


const STAGE_KEY_LABELS: Record<StageKey, string> = {
  blend: "Blend",
  encapsulate: "Encapsulate",
  bottle: "Bottle",
  label: "Label",
  fill: "Fill",
  cook: "Cook",
  deposit: "Deposit",
  cure: "Cure",
  coat: "Coat",
  package: "Package",
  custom: "Custom",
};


/** Best-guess mapping from a workstation display name to a
 *  ``StageKey``. The Stages tab used to expose a manual "Kind"
 *  dropdown, but every workstation on PSP already encodes its
 *  purpose in its name (Blending, Encapsulating, Bottling,
 *  Labelling, …). Deriving here means the scientist picks a
 *  workstation and the stage_key just follows. Falls back to
 *  ``custom`` when nothing matches — the FormulationStage still
 *  saves cleanly. */
function inferStageKey(workstationName: string): StageKey {
  const n = workstationName.toLowerCase();
  if (n.includes("blend")) return "blend";
  if (n.includes("encapsul")) return "encapsulate";
  if (n.includes("bottl")) return "bottle";
  if (n.includes("label")) return "label";
  if (n.includes("fill")) return "fill";
  if (n.includes("cook")) return "cook";
  if (n.includes("deposit")) return "deposit";
  if (n.includes("cure")) return "cure";
  if (n.includes("coat")) return "coat";
  if (n.includes("packag")) return "package";
  return "custom";
}


/**
 * Tiny status chip next to each pre-populated identity input so the
 * scientist knows whether they're looking at the auto-derived value
 * (grey, italic) or an explicit override they typed (orange). The
 * distinction matters because "auto" values change if the formulation
 * code or stage name changes; "custom" values stay put on PSP.
 */
function AutoOrCustomBadge({ overridden }: { overridden: boolean }) {
  if (overridden) {
    return (
      <span
        className="rounded-full bg-orange-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200"
        title="Custom value. Ships to PSP verbatim."
      >
        custom
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-600"
      title="Auto-derived from the formulation code + stage. Edit to override."
    >
      auto
    </span>
  );
}


/**
 * Read-only chip showing the PSP system code for a stage's mirror
 * item. Fires only when we have a stage UUID (otherwise the picker
 * silently skips). PSP's ``code`` is the numbering-sequence identifier
 * scientists reference on shop-floor paperwork and audits — surfacing
 * it here saves a trip back to PSP just to look it up.
 */
function PspCodeChip({
  orgId,
  pspItemUuid,
}: {
  orgId: string;
  pspItemUuid: string;
}) {
  const detail = usePspItemDetail(orgId, pspItemUuid, {
    enabled: !!pspItemUuid,
  });
  const code = detail.data?.matched ? detail.data.item.code : "";
  if (!code) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-orange-50 px-2 py-1 font-mono text-[11px] font-medium text-orange-800 ring-1 ring-inset ring-orange-200"
      title="PSP system code — the numbering-sequence identifier assigned by PSP on item creation."
    >
      PSP · {code}
    </span>
  );
}


/**
 * Compute the auto-derived PSP identity a stage would fall back to
 * when the corresponding override field is left blank. Mirrors the
 * server-side derivation in ``_ensure_semi_finished`` /
 * ``_ensure_finished_product`` so scientists see the same value on
 * screen as what PSP would receive on an "auto" push.
 */
function derivedPspIdentity(
  formulation: { id: string; code: string; name: string },
  draft: Pick<StageDraft, "name" | "sort_order" | "psp_item_type">,
): { name: string; sku: string; description: string } {
  const stageLabel = draft.name?.trim() || `Stage ${draft.sort_order + 1}`;
  const isFinished = draft.psp_item_type === "finished_product";
  return {
    // Finished-stage PSP name mirrors the Setup product name — the
    // finished stage IS the finished product, so its PSP identity
    // has to match what Setup declares. Editing lives on Setup; the
    // stage strip's name input is disabled for the finished stage
    // so the two surfaces can't drift.
    name: isFinished
      ? (formulation.name?.trim() ||
        `${formulation.code} — ${stageLabel}`)
      : `${formulation.code} — ${stageLabel}`,
    sku: isFinished
      ? `NPD-FINISHED-${formulation.id}`
      : `NPD-STAGE-${formulation.id}-${draft.sort_order}`,
    description: isFinished
      ? `Auto-created by NPD for formulation ${formulation.code} on first BOM push.`
      : `Auto-created by NPD for formulation ${formulation.code} stage ${draft.sort_order + 1}.`,
  };
}


function toDraft(stage: FormulationStageDto): StageDraft {
  return {
    clientKey: stage.id,
    id: stage.id,
    sort_order: stage.sort_order,
    name: stage.name,
    stage_key: stage.stage_key,
    workstation_group_uuid: stage.workstation_group_uuid,
    workstation_group_name: stage.workstation_group_name,
    operation_description: stage.operation_description ?? "",
    setup_time_min: stage.setup_time_min ?? "",
    cycle_time_min: stage.cycle_time_min ?? "",
    fixed_cost: stage.fixed_cost ?? "",
    variable_cost: stage.variable_cost ?? "",
    capacity: stage.capacity ?? "",
    other_fixed_cost: stage.other_fixed_cost ?? "",
    other_variable_cost: stage.other_variable_cost ?? "",
    other_variable_cost_basis: stage.other_variable_cost_basis ?? "",
    worker_psp_uuids: stage.worker_psp_uuids ?? [],
    psp_item_type: stage.psp_item_type ?? "semi_finished",
    psp_item_name: stage.psp_item_name ?? "",
    psp_item_external_sku: stage.psp_item_external_sku ?? "",
    psp_item_description: stage.psp_item_description ?? "",
    psp_item_attributes: { ...(stage.psp_item_attributes ?? {}) },
    psp_item_barcode: stage.psp_item_barcode ?? "",
    psp_item_stock_uom_uuid: stage.psp_item_stock_uom_uuid ?? null,
    psp_item_product_family_uuid:
      stage.psp_item_product_family_uuid ?? null,
    psp_finished_product_spec: {
      ...(stage.psp_finished_product_spec ?? {}),
    },
    servings_per_output_unit: stage.servings_per_output_unit ?? "1",
  };
}


function draftToInput(
  draft: StageDraft,
  index: number,
  productName: string,
): UpsertStageInput {
  const emptyToNull = (v: string) => (v.trim() === "" ? null : v.trim());
  // The finished stage's stage name AND PSP item name are locked to
  // the Setup product name — one product identity, two surfaces.
  // Editing lives on Setup; this override closes the loop server-side
  // so a divergent legacy value gets rewritten on the next save.
  const isFinished = draft.psp_item_type === "finished_product";
  const finishedName = productName.trim();
  const resolvedName = isFinished && finishedName
    ? finishedName
    : draft.name.trim() || `Stage ${index + 1}`;
  const resolvedPspName = isFinished && finishedName
    ? finishedName
    : draft.psp_item_name.trim();
  return {
    id: draft.id,
    sort_order: index,
    name: resolvedName,
    stage_key: draft.stage_key,
    workstation_group_uuid: draft.workstation_group_uuid,
    workstation_group_name: draft.workstation_group_name,
    operation_description: draft.operation_description.trim(),
    setup_time_min: emptyToNull(draft.setup_time_min),
    cycle_time_min: emptyToNull(draft.cycle_time_min),
    fixed_cost: emptyToNull(draft.fixed_cost),
    variable_cost: emptyToNull(draft.variable_cost),
    capacity: emptyToNull(draft.capacity),
    other_fixed_cost: emptyToNull(draft.other_fixed_cost),
    other_variable_cost: emptyToNull(draft.other_variable_cost),
    other_variable_cost_basis: emptyToNull(draft.other_variable_cost_basis),
    worker_psp_uuids: draft.worker_psp_uuids,
    psp_item_type: draft.psp_item_type,
    psp_item_name: resolvedPspName,
    psp_item_external_sku: draft.psp_item_external_sku.trim(),
    psp_item_description: draft.psp_item_description.trim(),
    psp_item_attributes: draft.psp_item_attributes,
    psp_item_barcode: draft.psp_item_barcode.trim(),
    psp_item_stock_uom_uuid: draft.psp_item_stock_uom_uuid,
    psp_item_product_family_uuid: draft.psp_item_product_family_uuid,
    psp_finished_product_spec: draft.psp_finished_product_spec,
    servings_per_output_unit: emptyToNull(draft.servings_per_output_unit),
  };
}


/** Suggested ``servings_per_output_unit`` for a stage. Reads Setup
 *  values + the stage's picked stock UoM symbol and returns the
 *  number of finished-good servings equal to 1 stock-unit of the
 *  stage's PSP output. Works across every dosage form:
 *  capsule / tablet / powder / gummy use ``target_fill_weight_mg`` as
 *  the per-serving mass; liquid falls back to ``water_volume_ml`` as
 *  a per-serving volume. The finished stage always defaults to
 *  ``servings_per_pack`` — one bottle / one pack contains that many
 *  servings by definition.
 *
 *  Returns ``null`` when the answer can't be derived (unknown UoM,
 *  missing Setup fields). Callers fall back to the raw draft value
 *  or 1 in that case. */
export function suggestServingsPerOutputUnit(args: {
  psp_item_type: "semi_finished" | "finished_product";
  stock_uom_symbol: string;
  dosage_form: string;
  target_fill_weight_mg: string;
  water_volume_ml: string;
  servings_per_pack: number | null | undefined;
}): number | null {
  const isTerminal = args.psp_item_type === "finished_product";
  if (isTerminal) {
    // 1 finished stock-unit (bottle / tub / pack) = servings_per_pack.
    const spp = args.servings_per_pack ?? 0;
    return spp > 0 ? spp : 1;
  }
  // Semi stage: depends on stock UoM. Mass / volume units convert
  // to servings via the per-serving mass (or volume). Count-based
  // units (unit, pcs, count, each, ea) mean "1 stock unit = 1 serving".
  const symbol = (args.stock_uom_symbol || "").toLowerCase().trim();
  const massBased: Record<string, number> = {
    kg: 1_000_000,
    g: 1_000,
    mg: 1,
  };
  const volumeBased: Record<string, number> = {
    l: 1_000_000, // 1 L = 1 kg water = 1e6 mg
    ml: 1_000, // 1 mL = 1 g water = 1000 mg
  };
  const massFactor = massBased[symbol];
  const volFactor = volumeBased[symbol];
  // Count-based → 1 unit = 1 serving.
  if (!massFactor && !volFactor) return 1;
  // Per-serving basis: liquid dosage forms use water volume;
  // everything else (capsule / tablet / powder / gummy / cream / …)
  // uses the fill weight the compute already relies on.
  const fillMg = Number.parseFloat(args.target_fill_weight_mg || "0");
  const waterMl = Number.parseFloat(args.water_volume_ml || "0");
  const servingMg =
    args.dosage_form === "liquid" && waterMl > 0
      ? waterMl * 1000
      : fillMg;
  if (servingMg <= 0) return null;
  const factor = massFactor ?? volFactor ?? 1;
  const suggested = factor / servingMg;
  // Round to 4 decimals so the FE displays clean numbers. Anything
  // finer than 4dp doesn't move the compute meaningfully.
  return Math.round(suggested * 10_000) / 10_000;
}


/** Format a number for display in the "Auto: X" hint. Trims trailing
 *  zeroes so ``100.0000`` → ``100`` but ``0.5`` stays ``0.5``. */
export function formatSuggested(n: number): string {
  const s = n.toFixed(4);
  return s.replace(/\.?0+$/, "") || "0";
}


// Match the builder's plain-input Tailwind style so the strip
// blends in with the surrounding form controls.
const inputClass =
  "w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50";



/**
 * Key/value editor for a stage's ``psp_item_attributes`` bag. Rendered
 * as a mini table with add / remove rows — matches the way PSP's own
 * item form exposes custom attributes so scientists don't have to
 * context-switch between the two UIs. Values persist as strings on
 * the wire (PSP's ``attributes`` is a JSONB map keyed by
 * ``attribute.key`` from PSP's ``attribute_definitions`` catalogue;
 * scientists typing free-form keys here get free-form values
 * respected by PSP's normalise function).
 */
function StageAttributesEditor({
  attributes,
  disabled,
  onChange,
}: {
  attributes: Record<string, unknown>;
  disabled: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(attributes);

  function setEntry(oldKey: string, key: string, value: string) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (k === oldKey) continue;
      next[k] = v;
    }
    if (key.trim()) next[key.trim()] = value;
    onChange(next);
  }

  function removeEntry(key: string) {
    const next: Record<string, unknown> = { ...attributes };
    delete next[key];
    onChange(next);
  }

  function addEntry() {
    let base = "new_attribute";
    let candidate = base;
    let i = 1;
    while (candidate in attributes) {
      candidate = `${base}_${i++}`;
    }
    onChange({ ...attributes, [candidate]: "" });
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-medium text-ink-600">
          Custom attributes
        </label>
        {!disabled ? (
          <button
            type="button"
            onClick={addEntry}
            className="rounded-md bg-ink-50 px-2 py-1 text-[11px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-orange-50 hover:text-orange-700"
          >
            + Add attribute
          </button>
        ) : null}
      </div>
      {entries.length === 0 ? (
        <p className="mt-1 rounded-lg bg-ink-50 px-3 py-2 text-[11px] leading-snug text-ink-500">
          No custom attributes. Use these for values scientists edit
          alongside identity — <span className="font-medium">use_as</span>,
          <span className="font-medium"> capsule_size</span>,
          <span className="font-medium"> shell_weight_mg</span>,
          <span className="font-medium"> extract_ratio</span>, etc. Empty
          leaves PSP&apos;s existing bag untouched.
        </p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1.5">
          {entries.map(([key, value]) => (
            <li
              key={key}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_28px] items-center gap-2"
            >
              <input
                value={key}
                onChange={(e) =>
                  setEntry(key, e.target.value, String(value ?? ""))
                }
                disabled={disabled}
                className={inputClass}
                placeholder="attribute_key"
              />
              <input
                value={String(value ?? "")}
                onChange={(e) => setEntry(key, key, e.target.value)}
                disabled={disabled}
                className={inputClass}
                placeholder="value"
              />
              {!disabled ? (
                <button
                  type="button"
                  onClick={() => removeEntry(key)}
                  className="rounded-md p-1.5 text-ink-500 hover:bg-red-50 hover:text-red-600"
                  aria-label={`Remove ${key}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              ) : (
                <span aria-hidden />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


function uuidListsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const sorted = (xs: readonly string[]) => [...xs].sort();
  const sa = sorted(a);
  const sb = sorted(b);
  return sa.every((v, i) => v === sb[i]);
}


export interface StageStripBuilderLine {
  readonly key: string;
  readonly item_id: string;
  readonly item_name: string;
  readonly item_internal_code: string;
  readonly label_claim_mg: string;
  readonly stage_id: string | null;
}


export interface StageStripProps {
  readonly orgId: string;
  readonly formulation: FormulationDto;
  readonly canEdit: boolean;
  /** Sticky "adding to" stage — highlights the target stage card
   *  in orange so the operator can see where the next pick will
   *  land. Also drives the per-card "Add ingredient" button copy. */
  readonly activeStageId: string | null;
  readonly onActiveStageChange: (stageId: string | null) => void;
  /** Live line drafts from the builder. Consumed by the "Replace
   *  finished-stage BOM with PSP's?" confirm dialog to show how many
   *  lines the pull will overwrite. Not rendered per-stage anymore —
   *  ingredient-to-stage routing lives on the Routing tab. */
  readonly lines: readonly StageStripBuilderLine[];
  /** Fired with the fresh formulation DTO after a successful
   *  ``Save stages`` round-trip. The builder wires this to its
   *  own ``setFormulation`` so the Stage BOMs preview + picker
   *  chip + line list see the same server state the strip does —
   *  without this callback the parent stays on stale data and the
   *  three surfaces drift. */
  readonly onSaved?: (formulation: FormulationDto) => void;
  /** PSP base URL from the org config — feeds the per-stage
   *  "Open on PSP ↗" deep-link that lands on the semi-finished (or
   *  finished, for the terminal) item's detail page. ``null`` /
   *  empty when PSP isn't configured; the link then doesn't render.
   */
  readonly pspBaseUrl?: string | null;
  /** Formulation-level finished-product UUID — needed to compute
   *  the terminal stage's PSP deep-link, since the terminal stage
   *  reuses ``formulation.psp_finished_product_uuid`` rather than
   *  spawning its own ``psp_semi_finished_uuid``. */
  readonly pspFinishedProductUuid?: string | null;
  /** Fired when the operator clicks a per-stage "Sync now" button.
   *  Pushes the current in-memory formulation state to PSP without
   *  cutting a version. Optional — hidden if the parent doesn't wire
   *  it (early formulations where nothing has been staged yet). */
  readonly onSyncNow?: () => Promise<void> | void;
  /** True while a manual sync push is in flight — disables every
   *  Sync-now button so double-clicks can't fan out. */
  readonly syncPending?: boolean;
  /** Fires whenever the local strip's dirty state flips (drafts
   *  diverge from / re-align with the server DTO). Parent tracks
   *  this so its own Save version / Save draft buttons can enable
   *  on stage edits, not just line edits. */
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** One-time callback the strip fires on mount to hand its save
   *  action out to the parent. The parent stores the fn on a ref
   *  and can call it before a Save version to persist pending
   *  stage edits (returning the fresh formulation DTO from the
   *  round-trip). Optional — nothing else in the strip depends on
   *  it being wired. */
  readonly onRegisterSave?: (
    save: () => Promise<FormulationDto>,
  ) => void;
  /** RTG packaging combos with per-combo stage assignment. Drives a
   *  small "Packaging: X" chip on each stage card so the operator
   *  can see at a glance which combos land at which stage. Undefined
   *  / empty on Custom projects (combos don't apply). */
  readonly packagingCombosByStage?: ReadonlyMap<
    string,
    readonly { readonly id: string; readonly name: string }[]
  >;
}


export function StageStrip({
  orgId,
  formulation,
  canEdit,
  activeStageId,
  onActiveStageChange,
  lines,
  onSaved,
  pspBaseUrl,
  pspFinishedProductUuid,
  onSyncNow,
  syncPending,
  onDirtyChange,
  onRegisterSave,
  packagingCombosByStage,
}: StageStripProps) {
  const [drafts, setDrafts] = useState<StageDraft[]>(() =>
    formulation.stages.map(toDraft),
  );
  const [pickerOpened, setPickerOpened] = useState(false);
  const upsert = useUpsertStages(orgId, formulation.id);
  const pullPspBom = usePullPspBom(orgId, formulation.id);
  const applyTemplate = useApplyStageTemplate(orgId, formulation.id);
  const stageTemplatesQuery = useStageTemplates(orgId);
  const stageTemplates = stageTemplatesQuery.data?.items ?? [];
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateApplyError, setTemplateApplyError] = useState<string | null>(
    null,
  );
  const [pullConfirmOpen, setPullConfirmOpen] = useState(false);
  const [pullResult, setPullResult] = useState<null | {
    lines: number;
    mirrored: number;
    reused: number;
    unconvertible: readonly string[];
  }>(null);
  const [pullError, setPullError] = useState<string | null>(null);

  // Only fetch workstation groups when the operator touches a
  // stage's workstation dropdown — the builder mount shouldn't
  // trigger a PSP round-trip for every project view.
  // Fetch workstation groups on mount (not gated behind picker-open)
  // so drafts that already have a ``workstation_group_uuid`` — from a
  // stage-template apply, a rehydration after save, or a legacy row —
  // can resolve the uuid to the visible option label. Without this
  // eager fetch the ``<select>`` has a ``value`` set but no matching
  // ``<option>`` yet, so it renders the empty placeholder and looks
  // like the pick was lost. staleTime on the hook keeps this cheap.
  const wsQuery = usePspWorkstationGroups(orgId);
  const wsOptions = useMemo(
    () => wsQuery.data?.items ?? [],
    [wsQuery.data],
  );
  // UOM + product-family pickers on the PSP identity block. Fetch
  // eagerly (no ``enabled`` gate) — the drop-downs render on every
  // stage card so we'd hit the fetch on first paint anyway, and the
  // ``staleTime: 5min`` on the hooks keeps this cheap.
  const uomQuery = usePspUnitsOfMeasurement(orgId);
  const uomOptions = useMemo(
    () => uomQuery.data?.items ?? [],
    [uomQuery.data],
  );
  const familyQuery = usePspProductFamilies(orgId);
  const familyOptions = useMemo(
    () => familyQuery.data?.items ?? [],
    [familyQuery.data],
  );
  // Workers picker fetch removed with the Default crew section —
  // scientists shouldn't schedule crews. The FormulationStage
  // model still has ``worker_psp_uuids`` (nullable / defaults to
  // empty), so saves that don't touch it stay backward-compatible.

  // Re-sync drafts from the server on TWO events, never on random
  // parent re-renders:
  //
  // * Save success — ``upsert.data`` is the fresh formulation DTO
  //   from the PUT round-trip. Mirroring drafts to it clears the
  //   dirty flag + picks up server-set ids on newly-created stages.
  // * The formulation ID itself changed (navigation between two
  //   different projects sharing this component mount).
  //
  // Deliberately NOT depending on ``formulation.stages`` — the
  // parent updates ``formulation`` state on unrelated saves (lines,
  // metadata) which would previously wipe unsaved stage edits on
  // every keystroke that fired those flows.
  //
  // ``lastAppliedUpsert`` is the load-bearing guard: React parents
  // typically pass an inline arrow for ``onSaved``, which
  // changes reference every render. Without the ref check the
  // effect would loop — calling onSaved → parent setState →
  // new onSaved reference → effect fires → onSaved → ... —
  // producing "Maximum update depth exceeded".
  const lastAppliedUpsert = useRef<FormulationDto | null>(null);
  useEffect(() => {
    const fresh = upsert.data;
    if (!fresh) return;
    if (lastAppliedUpsert.current === fresh) return;
    lastAppliedUpsert.current = fresh;
    setDrafts(fresh.stages.map(toDraft));
    onSaved?.(fresh);
  }, [upsert.data, onSaved]);

  const lastSyncedFormulationId = useRef(formulation.id);
  useEffect(() => {
    if (lastSyncedFormulationId.current === formulation.id) return;
    lastSyncedFormulationId.current = formulation.id;
    setDrafts(formulation.stages.map(toDraft));
  }, [formulation]);

  const dirty = useMemo(() => {
    if (drafts.length !== formulation.stages.length) return true;
    return drafts.some((d, i) => {
      const s = formulation.stages[i];
      if (!s || s.id !== d.id) return true;
      return (
        s.name !== d.name ||
        s.stage_key !== d.stage_key ||
        s.workstation_group_uuid !== d.workstation_group_uuid ||
        (s.operation_description ?? "") !== d.operation_description ||
        (s.setup_time_min ?? "") !== d.setup_time_min ||
        (s.cycle_time_min ?? "") !== d.cycle_time_min ||
        (s.fixed_cost ?? "") !== d.fixed_cost ||
        (s.variable_cost ?? "") !== d.variable_cost ||
        (s.capacity ?? "") !== d.capacity ||
        (s.other_fixed_cost ?? "") !== d.other_fixed_cost ||
        (s.other_variable_cost ?? "") !== d.other_variable_cost ||
        (s.other_variable_cost_basis ?? "") !==
          d.other_variable_cost_basis ||
        !uuidListsEqual(s.worker_psp_uuids ?? [], d.worker_psp_uuids) ||
        (s.psp_item_type ?? "semi_finished") !== d.psp_item_type ||
        (s.psp_item_name ?? "") !== d.psp_item_name ||
        (s.psp_item_external_sku ?? "") !== d.psp_item_external_sku ||
        (s.psp_item_description ?? "") !== d.psp_item_description ||
        JSON.stringify(s.psp_item_attributes ?? {}) !==
          JSON.stringify(d.psp_item_attributes) ||
        (s.psp_item_barcode ?? "") !== d.psp_item_barcode ||
        (s.psp_item_stock_uom_uuid ?? null) !==
          d.psp_item_stock_uom_uuid ||
        (s.psp_item_product_family_uuid ?? null) !==
          d.psp_item_product_family_uuid ||
        JSON.stringify(s.psp_finished_product_spec ?? {}) !==
          JSON.stringify(d.psp_finished_product_spec) ||
        (s.servings_per_output_unit ?? "1") !==
          d.servings_per_output_unit
      );
    });
  }, [drafts, formulation.stages]);

  // Auto-populate ``servings_per_output_unit`` from Setup + the
  // picked stock UoM.
  //
  // Fires on rows the scientist hasn't touched — "not touched" means
  // BOTH blank AND still on the model default ``1`` / ``1.0000``.
  // Treating the raw default as "unset" is what retroactively fixes
  // legacy stages (created before this effect existed) that stored
  // ``1`` at seed time and never got updated — those stages show up
  // on the SPOU warning banner in the parent builder even though the
  // derivation would produce the right number (e.g. 120 for a
  // Bottling stage that outputs 1 bottle of 120 servings). Without
  // this widening, the scientist has to blank the field, wait for
  // auto-populate, then save — a manual dance for what should be
  // deterministic math.
  //
  // Runs whenever Setup values or the UoM catalog changes so a
  // mid-session Setup edit (e.g. fill weight 500 mg → 750 mg) reflows
  // the suggestion. A scientist who legitimately wants ``1`` on a
  // stage where the suggestion is > 1 can still type it — the change
  // sticks because the next re-render sees a non-default value and
  // this effect stops touching it. (Not perfect, but the yield-loss
  // override case is rare enough that a first-class override toggle
  // isn't worth the UI surface yet.)
  useEffect(() => {
    if (uomOptions.length === 0) return;
    setDrafts((prev) => {
      let changed = false;
      const next = prev.map((d) => {
        const raw = (d.servings_per_output_unit || "").trim();
        const isModelDefault = raw === "" || raw === "1" || raw === "1.0000";
        if (!isModelDefault) return d;
        const stockUom = uomOptions.find(
          (u) => u.uuid === d.psp_item_stock_uom_uuid,
        );
        const suggested = suggestServingsPerOutputUnit({
          psp_item_type: d.psp_item_type,
          stock_uom_symbol: stockUom?.symbol ?? "",
          dosage_form: formulation.dosage_form,
          target_fill_weight_mg:
            formulation.target_fill_weight_mg ?? "",
          water_volume_ml: formulation.water_volume_ml ?? "",
          servings_per_pack: formulation.servings_per_pack,
        });
        if (suggested === null) return d;
        const suggestedStr = formatSuggested(suggested);
        // No-op guard — skip Encapsulation-style stages where the
        // legitimate answer IS 1 and stored is already 1. Prevents a
        // spurious dirty flip on every render.
        if (suggestedStr === raw) return d;
        changed = true;
        return {
          ...d,
          servings_per_output_unit: suggestedStr,
        };
      });
      return changed ? next : prev;
    });
  }, [
    uomOptions,
    formulation.dosage_form,
    formulation.target_fill_weight_mg,
    formulation.water_volume_ml,
    formulation.servings_per_pack,
  ]);

  // Bubble the strip's local dirty state to the parent so its
  // Save version / Save draft buttons can enable on stage edits,
  // not just line / metadata edits.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // One-time save-handle registration. Parent stashes the fn on a
  // ref and calls it before Save version to persist pending stage
  // edits inline (chaining through the existing upsert mutation so
  // the resulting formulation DTO flows into the parent's setter
  // via the mutation's promise). Guarded on ``onRegisterSave`` so
  // the register only fires when the parent actually wired it.
  //
  // The handle closes over the LIVE ``drafts`` + ``upsert`` refs —
  // storing it on a ref inside the effect keeps the parent-side
  // getter stable while ensuring the invoked closure always sees
  // the latest state.
  const saveHandleRef = useRef<(() => Promise<FormulationDto>) | null>(null);
  saveHandleRef.current = async () => {
    const result = await upsert.mutateAsync({
      stages: drafts.map((d, i) => draftToInput(d, i, formulation.name)),
    });
    onSaved?.(result);
    return result;
  };
  useEffect(() => {
    if (!onRegisterSave) return;
    onRegisterSave(async () => {
      const fn = saveHandleRef.current;
      if (!fn) throw new Error("stage save handle not registered");
      return await fn();
    });
  }, [onRegisterSave]);

  // "Save + sync" should also be clickable when nothing changed
  // locally but a stage hasn't been pushed to PSP yet — otherwise
  // scientists get stuck with a "not on PSP yet" hint next to a
  // disabled button. Any stage missing its PSP mirror uuid counts;
  // the terminal stage uses the formulation-level
  // ``psp_finished_product_uuid`` instead of its own semi uuid.
  const needsSync = useMemo(() => {
    return formulation.stages.some((s) => {
      if (s.psp_item_type === "finished_product") {
        return !pspFinishedProductUuid;
      }
      return !s.psp_semi_finished_uuid;
    });
  }, [formulation.stages, pspFinishedProductUuid]);

  function updateDraft(clientKey: string, patch: Partial<StageDraft>) {
    setDrafts((prev) =>
      prev.map((d) => (d.clientKey === clientKey ? { ...d, ...patch } : d)),
    );
  }

  function addStage() {
    // Insert BEFORE the terminal stage so the finished-product
    // placeholder stays anchored at the bottom of the strip. Terminal
    // is always the last entry (the seeder guarantees it; the whole
    // production graph flows *into* it). Sort_order gets rewritten
    // at save time by ``draftToInput(d, i, formulation.name)`` from the array index,
    // so the ``sort_order: 0`` here is just a placeholder that never
    // reaches the server.
    setDrafts((prev) => {
      const newStage: StageDraft = {
        clientKey: `new-${Date.now()}-${Math.random()}`,
        sort_order: 0,
        name: `Stage ${prev.length + 1}`,
        stage_key: "custom",
        workstation_group_uuid: null,
        workstation_group_name: "",
        operation_description: "",
        setup_time_min: "",
        cycle_time_min: "",
        fixed_cost: "",
        variable_cost: "",
        capacity: "",
        other_fixed_cost: "",
        other_variable_cost: "",
        other_variable_cost_basis: "",
        worker_psp_uuids: [],
        psp_item_type: "semi_finished",
        psp_item_name: "",
        psp_item_external_sku: "",
        psp_item_description: "",
        psp_item_attributes: {},
        psp_item_barcode: "",
        psp_item_stock_uom_uuid: null,
        psp_item_product_family_uuid: null,
        psp_finished_product_spec: {},
        // Empty triggers the auto-populate effect above once the
        // scientist picks a stock UoM. Beats seeding "1" that would
        // then need to be manually cleared.
        servings_per_output_unit: "",
      };
      // No existing stages → just append.
      if (prev.length === 0) return [newStage];
      // Insert before the last (terminal) stage.
      return [...prev.slice(0, -1), newStage, prev[prev.length - 1]!];
    });
  }

  function removeStage(clientKey: string) {
    setDrafts((prev) => prev.filter((d) => d.clientKey !== clientKey));
  }

  function move(clientKey: string, direction: -1 | 1) {
    setDrafts((prev) => {
      const idx = prev.findIndex((d) => d.clientKey === clientKey);
      const target = idx + direction;
      if (idx < 0 || target < 0 || target >= prev.length) return prev;
      const a = prev[idx];
      const b = prev[target];
      if (!a || !b) return prev;
      const next = [...prev];
      next[idx] = b;
      next[target] = a;
      return next;
    });
  }

  function save() {
    upsert.mutate({
      stages: drafts.map((d, i) => draftToInput(d, i, formulation.name)),
    });
  }

  const runPull = () => {
    setPullError(null);
    pullPspBom.mutate(undefined, {
      onSuccess: (result) => {
        setPullConfirmOpen(false);
        setPullResult({
          lines: result.summary.lines_pulled,
          mirrored: result.summary.items_mirrored,
          reused: result.summary.items_reused,
          unconvertible: result.summary.unconvertible_uom_lines,
        });
        // Re-hydrate drafts from the fresh formulation server-side
        // returned so stage cards + BOM totals reflect the pulled
        // state without a manual page refresh.
        setDrafts(result.formulation.stages.map(toDraft));
        onSaved?.(result.formulation);
      },
      onError: (err) => {
        setPullError(err.message || "PSP pull failed.");
      },
    });
  };

  const runApplyTemplate = (templateId: string) => {
    setTemplateApplyError(null);
    applyTemplate.mutate(templateId, {
      onSuccess: (result) => {
        setDrafts(result.formulation.stages.map(toDraft));
        onSaved?.(result.formulation);
        setTemplatePickerOpen(false);
      },
      onError: (err) => {
        setTemplateApplyError(err.message || "Couldn't apply template.");
      },
    });
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      {templatePickerOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/40 p-4"
          onClick={() =>
            applyTemplate.isPending ? null : setTemplatePickerOpen(false)
          }
        >
          <div
            className="w-full max-w-lg rounded-2xl bg-ink-0 p-5 shadow-xl ring-1 ring-ink-200"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-ink-1000">
              Apply stage template
            </h2>
            <p className="mt-1 text-xs text-ink-600">
              Wholesale-replaces this project&apos;s stages with the
              template&apos;s. Existing stages + their lines are
              re-linked where names match; lines that reference a
              stage that&apos;s removed fall back to the terminal
              stage.
            </p>
            {templateApplyError ? (
              <p className="mt-3 rounded-lg bg-red-50 p-2 text-[12px] text-red-700 ring-1 ring-inset ring-red-200">
                {templateApplyError}
              </p>
            ) : null}
            <ul className="mt-4 max-h-80 divide-y divide-ink-100 overflow-y-auto rounded-xl ring-1 ring-ink-200">
              {stageTemplates.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start justify-between gap-3 p-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink-1000">{t.name}</p>
                    {t.description ? (
                      <p className="mt-0.5 text-[11px] text-ink-600">
                        {t.description}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-ink-500">
                      {t.stages.length} stage
                      {t.stages.length === 1 ? "" : "s"}
                      {t.dosage_form ? ` · ${t.dosage_form}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => runApplyTemplate(t.id)}
                    disabled={applyTemplate.isPending}
                    className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-orange-600 disabled:opacity-50"
                  >
                    {applyTemplate.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : null}
                    Apply
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setTemplatePickerOpen(false)}
                disabled={applyTemplate.isPending}
                className="rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pullConfirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/40 p-4"
          onClick={() => (pullPspBom.isPending ? null : setPullConfirmOpen(false))}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-ink-0 p-5 shadow-xl ring-1 ring-ink-200"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-ink-1000">
              Replace finished-stage BOM with PSP&apos;s?
            </h2>
            <p className="mt-2 text-sm text-ink-700">
              PSP is treated as source of truth here. This will
              wholesale-replace the finished stage&apos;s ingredient
              lines ({" "}
              <span className="font-medium">
                {drafts.length > 0
                  ? lines.filter(
                      (l) =>
                        l.stage_id === null ||
                        l.stage_id === drafts[drafts.length - 1]?.id,
                    ).length
                  : 0}{" "}
                current
              </span>{" "}
              → PSP&apos;s active BOM). Semi-finished stages stay
              intact.
            </p>
            <p className="mt-2 text-[12px] text-ink-600">
              A snapshot version labelled{" "}
              <span className="font-mono">pre-pull-from-psp</span> is
              saved before the overwrite, so you can roll back from
              the version drawer if the wrong recipe was pulled.
            </p>
            {pullError ? (
              <p className="mt-3 rounded-lg bg-red-50 p-2 text-[12px] text-red-700 ring-1 ring-inset ring-red-200">
                {pullError}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPullConfirmOpen(false)}
                disabled={pullPspBom.isPending}
                className="rounded-lg px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={runPull}
                disabled={pullPspBom.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
              >
                {pullPspBom.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                Replace with PSP&apos;s BOM
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {pullResult ? (
        <div className="mb-3 flex items-start justify-between gap-3 rounded-xl bg-green-50 p-3 text-[12px] text-green-800 ring-1 ring-inset ring-green-200">
          <div>
            <p className="font-medium">
              Loaded {pullResult.lines} lines from PSP.
            </p>
            <p className="mt-0.5 text-[11px]">
              {pullResult.mirrored} newly mirrored,{" "}
              {pullResult.reused} reused from existing mirrors.
              {pullResult.unconvertible.length > 0 ? (
                <>
                  {" "}
                  Non-mg UOMs stored verbatim (adjust in the builder):{" "}
                  <span className="font-medium">
                    {pullResult.unconvertible.join(", ")}
                  </span>
                  .
                </>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPullResult(null)}
            className="rounded p-1 text-green-700 hover:bg-green-100"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ) : null}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            Production stages
          </p>
          <p className="mt-1 max-w-xl text-sm text-ink-700">
            Each stage produces one PSP item — non-terminal stages
            spawn semi-finished items on the next save; the terminal
            stage becomes the finished product's routing.
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            {stageTemplates.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setTemplateApplyError(null);
                  setTemplatePickerOpen(true);
                }}
                isDisabled={upsert.isPending || applyTemplate.isPending}
                className="gap-1.5"
              >
                Apply template
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addStage}
              isDisabled={upsert.isPending}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              Add stage
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={save}
              isDisabled={(!dirty && !needsSync) || upsert.isPending}
              className="gap-1.5"
            >
              <Save className="h-4 w-4" />
              {upsert.isPending
                ? "Saving + syncing…"
                : dirty
                  ? "Save + sync to PSP"
                  : needsSync
                    ? "Sync to PSP"
                    : "Save + sync to PSP"}
            </Button>
          </div>
        ) : null}
      </header>

      {drafts.length === 0 ? (
        <p className="mt-4 rounded-lg bg-ink-50 p-4 text-sm text-ink-700">
          No stages defined. Capsule, powder, tablet, and gummy
          formulations auto-seed a default graph on create — liquid
          / other-solid dosage forms start empty and you add stages
          yourself.
        </p>
      ) : (
        <ol className="mt-4 flex flex-col gap-3">
          {drafts.map((draft, i) => {
            const stageId = draft.id ?? null;
            const isActive =
              stageId !== null && stageId === activeStageId;
            const isFinishedCard =
              draft.psp_item_type === "finished_product";
            return (
            <li
              key={draft.clientKey}
              className={
                isActive
                  ? "rounded-xl bg-orange-50 p-4 ring-1 ring-inset ring-orange-300"
                  : isFinishedCard
                    ? "rounded-xl bg-ink-0 p-4 ring-2 ring-inset ring-orange-400"
                    : "rounded-xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200"
              }
            >
              {/* Big obvious role banner at the top of every stage
                  card. Orange = finished product (the shipping SKU on
                  PSP); grey = semi-finished intermediate. Removes any
                  ambiguity about which stage will publish as MA00xxx
                  vs which spawns its own semi-finished PSP item. */}
              <div
                className={
                  isFinishedCard
                    ? "mb-3 flex items-center justify-between gap-2 rounded-lg bg-orange-500 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-white"
                    : "mb-3 flex items-center justify-between gap-2 rounded-lg bg-ink-200 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-700"
                }
              >
                <span className="inline-flex items-center gap-1.5">
                  {isFinishedCard ? "✦ Finished product" : "◇ Semi-finished"}
                </span>
                <span className="text-[10px] font-normal opacity-80">
                  {isFinishedCard
                    ? "Ships to PSP as this project's shipping SKU"
                    : `Spawns its own PSP item · stage ${i + 1}`}
                </span>
              </div>
              {/* RTG packaging combos wired to this stage on the
                  Routing tab. Reads through the ``packagingCombosByStage``
                  prop so the strip stays render-only — no extra query.
                  Undefined on Custom projects (prop omitted); empty on
                  RTG stages that no combo lands on. */}
              {stageId ? (
                (() => {
                  const combosHere = packagingCombosByStage?.get(stageId);
                  if (!combosHere || combosHere.length === 0) return null;
                  return (
                    <div
                      className="mb-2 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg bg-orange-50 px-2 py-1 text-[11px] font-medium text-orange-900 ring-1 ring-inset ring-orange-200"
                      title="These packaging combos route to this stage on the Routing tab. Whichever the customer picks at checkout, its items land in this stage's BOM at order time."
                    >
                      <span className="font-semibold uppercase tracking-wide text-orange-700">
                        📦 Packaging
                      </span>
                      <span className="truncate">
                        {combosHere.map((c) => c.name).join(", ")}
                      </span>
                    </div>
                  );
                })()
              ) : null}
              {/* Per-stage PSP deep-link + Sync-now row. Renders only
                  when PSP is live for the org AND the stage already has
                  an item on PSP (or, for the terminal stage, the
                  formulation has a linked finished product). The
                  ``Sync now`` button pushes the current in-memory state
                  to PSP without cutting a version — useful when the
                  scientist wants to prototype one stage's BOM without
                  going through the whole Save Version flow. */}
              {(() => {
                // Which PSP item this stage produces depends on the
                // stage's own ``psp_item_type`` — NOT its position in
                // the list. A semi-finished stage that happens to be
                // last still maps to its own semi-finished uuid; only
                // stages explicitly marked ``finished_product``
                // resolve to the formulation's finished-product uuid.
                const isFinishedStage =
                  draft.psp_item_type === "finished_product";
                const stagePspUuid = isFinishedStage
                  ? pspFinishedProductUuid ?? null
                  : formulation.stages.find(
                      (s) => s.id === stageId,
                    )?.psp_semi_finished_uuid ?? null;
                const canShowPspLink = !!pspBaseUrl && !!stagePspUuid;
                const canShowSync = !!onSyncNow && canEdit;
                if (!canShowPspLink && !canShowSync) return null;
                return (
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
                    {stagePspUuid ? (
                      <PspCodeChip
                        orgId={orgId}
                        pspItemUuid={stagePspUuid}
                      />
                    ) : null}
                    {canShowPspLink ? (
                      <a
                        href={`${pspBaseUrl}/production/items/${stagePspUuid}`}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-2 py-1 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                        title={
                          isFinishedStage
                            ? "Opens this formulation's finished-product item + BOM on PSP"
                            : "Opens the semi-finished item + BOM this stage produces on PSP"
                        }
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open on PSP
                      </a>
                    ) : null}
                    {/* Load-from-PSP: pulls the finished-product item's
                        active primary BOM and wholesale-replaces the
                        finished stage's lines. Only shows on stages
                        marked ``finished_product`` AND when the
                        formulation is linked to a PSP item — otherwise
                        there's no BOM to pull. */}
                    {isFinishedStage &&
                    !!pspFinishedProductUuid &&
                    canEdit ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPullError(null);
                          setPullResult(null);
                          setPullConfirmOpen(true);
                        }}
                        disabled={pullPspBom.isPending}
                        className="inline-flex items-center gap-1 rounded-md bg-ink-0 px-2 py-1 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
                        title="Replace this stage's ingredient list with PSP's active BOM. Auto-snapshots the current state to a new version before overwriting."
                      >
                        {pullPspBom.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <ExternalLink className="h-3 w-3 rotate-180" />
                        )}
                        Load BOM from PSP
                      </button>
                    ) : null}
                    {!canShowPspLink ? (
                      <span className="rounded-md bg-amber-50 px-2 py-1 font-medium text-amber-800 ring-1 ring-inset ring-amber-200">
                        Not on PSP yet — save the stages to create it.
                      </span>
                    ) : null}
                  </div>
                );
              })()}

              {/* Row 1 — what operation. Workstation is the pick;
                  the stage name auto-mirrors the workstation but
                  stays editable so a scientist can override
                  ("Blending — Vitamin C batch") when helpful. Kind
                  auto-derives from workstation name; no dropdown. */}
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,0.6fr)]">
                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Stage {i + 1}
                    </label>
                    {draft.psp_item_type === "finished_product" ? (
                      // Finished stage IS the finished product — its
                      // name mirrors the Setup product name and can't
                      // be edited here (single source of truth on
                      // Setup). ``draftToInput`` also force-syncs on
                      // save so a legacy diverged value gets rewritten.
                      <>
                        <input
                          value={formulation.name}
                          disabled
                          className={`${inputClass} mt-1 cursor-not-allowed bg-ink-50`}
                          title="Managed on Setup — edit the product name there"
                        />
                        <p className="mt-1 text-[11px] text-ink-500">
                          Locked to the Setup product name.
                        </p>
                      </>
                    ) : (
                      <input
                        value={draft.name}
                        onChange={(e) =>
                          updateDraft(draft.clientKey, {
                            name: e.target.value,
                          })
                        }
                        disabled={!canEdit || upsert.isPending}
                        className={`${inputClass} mt-1`}
                      />
                    )}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Operation (workstation)
                    </label>
                    <select
                      value={draft.workstation_group_uuid ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        const picked = wsOptions.find(
                          (w) => w.uuid === v,
                        );
                        // When the operator picks a workstation,
                        // auto-mirror its name into the stage name
                        // if the stage name is still the untouched
                        // default ("Stage 1", "Stage 2", ...). Once
                        // the operator has typed anything else we
                        // leave it alone.
                        const looksLikeDefault =
                          !draft.name.trim() ||
                          /^Stage \d+$/.test(draft.name.trim());
                        updateDraft(draft.clientKey, {
                          workstation_group_uuid: v || null,
                          workstation_group_name: picked?.name ?? "",
                          name:
                            looksLikeDefault && picked?.name
                              ? picked.name
                              : draft.name,
                          // Kind auto-derives from the workstation
                          // name via a simple substring match. Falls
                          // back to ``custom`` for anything unknown.
                          stage_key: inferStageKey(
                            picked?.name ?? "",
                          ),
                        });
                      }}
                      onFocus={() => setPickerOpened(true)}
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    >
                      <option value="">
                        {draft.workstation_group_name ||
                          "Pick an operation…"}
                      </option>
                      {wsOptions.map((w) => (
                        <option key={w.uuid} value={w.uuid}>
                          {w.name}
                          {w.kind === "passive_processing"
                            ? " · passive"
                            : ""}
                        </option>
                      ))}
                    </select>
                    {pickerOpened && wsQuery.isLoading ? (
                      <p className="mt-1 text-xs text-ink-500">
                        Loading operations from PSP…
                      </p>
                    ) : null}
                    {pickerOpened &&
                    !wsQuery.isLoading &&
                    wsOptions.length === 0 ? (
                      <p className="mt-1 text-xs text-ink-500">
                        No operations set up on PSP yet.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Setup (min)
                    </label>
                    <input
                      value={draft.setup_time_min}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          setup_time_min: e.target.value,
                        })
                      }
                      inputMode="decimal"
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Cycle (min)
                    </label>
                    <input
                      value={draft.cycle_time_min}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          cycle_time_min: e.target.value,
                        })
                      }
                      inputMode="decimal"
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    />
                  </div>
                </div>

                {canEdit ? (
                  <div className="flex flex-col items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(draft.clientKey, -1)}
                      disabled={i === 0 || upsert.isPending}
                      className="rounded p-1 text-ink-500 hover:bg-ink-100 disabled:opacity-30"
                      title="Move up"
                    >
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(draft.clientKey, 1)}
                      disabled={
                        i === drafts.length - 1 || upsert.isPending
                      }
                      className="rounded p-1 text-ink-500 hover:bg-ink-100 disabled:opacity-30"
                      title="Move down"
                    >
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeStage(draft.clientKey)}
                      disabled={
                        upsert.isPending ||
                        draft.psp_item_type === "finished_product"
                      }
                      className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={
                        draft.psp_item_type === "finished_product"
                          ? "The finished-product stage is the project's PSP identity — reassign the finished flag to another stage before removing this one."
                          : "Remove stage"
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Row 1a — PSP identity (phase 1). Scientist picks
                  whether this stage produces a semi-finished blend or
                  the finished product. When Save Version pushes to
                  PSP, this stage's ``external_sku`` becomes the PSP
                  item's code and ``description`` its description.
                  Blank stored values auto-derive (``NPD-STAGE-…`` /
                  ``NPD-FINISHED-…``); the inputs pre-populate with the
                  derived values so the scientist sees what's live and
                  can edit in place. */}
              {(() => {
                const derived = derivedPspIdentity(formulation, draft);
                const nameOverridden = !!draft.psp_item_name;
                const skuOverridden = !!draft.psp_item_external_sku;
                const descriptionOverridden = !!draft.psp_item_description;
                const nameShown = draft.psp_item_name || derived.name;
                const skuShown = draft.psp_item_external_sku || derived.sku;
                const descriptionShown =
                  draft.psp_item_description || derived.description;
                const applyOverride =
                  (field: "psp_item_name" | "psp_item_external_sku" | "psp_item_description",
                   nextValue: string,
                   derivedValue: string) => {
                    // Empty OR equal-to-derived collapses to the "auto"
                    // stored state (blank). Anything else counts as an
                    // explicit override.
                    const cleaned =
                      nextValue.trim() === "" || nextValue === derivedValue
                        ? ""
                        : nextValue;
                    updateDraft(draft.clientKey, { [field]: cleaned });
                  };
                return (
              <div className="mt-3 rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200">
                <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                  PSP identity
                </p>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,0.6fr)_minmax(0,1fr)]">
                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Item type
                    </label>
                    <select
                      value={draft.psp_item_type}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          psp_item_type: e.target.value as
                            | "semi_finished"
                            | "finished_product",
                        })
                      }
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    >
                      <option value="semi_finished">Semi-finished</option>
                      <option value="finished_product">Finished product</option>
                    </select>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-medium text-ink-600">
                        External SKU (code)
                      </label>
                      <AutoOrCustomBadge overridden={skuOverridden} />
                    </div>
                    <input
                      // Show the raw draft as the controlled value so
                      // clearing the field leaves it empty for typing.
                      // The derived fallback is surfaced via placeholder
                      // instead — without this the field snaps back to
                      // ``derived.sku`` the instant the operator empties
                      // it (``nextValue || derived`` short-circuits) and
                      // the next keystroke lands into a pre-populated
                      // input rather than a blank one.
                      value={draft.psp_item_external_sku}
                      placeholder={derived.sku}
                      onChange={(e) =>
                        applyOverride(
                          "psp_item_external_sku",
                          e.target.value,
                          derived.sku,
                        )
                      }
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    />
                  </div>
                </div>
                <div className="mt-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium text-ink-600">
                      PSP item name
                    </label>
                    <AutoOrCustomBadge overridden={nameOverridden} />
                  </div>
                  {draft.psp_item_type === "finished_product" ? (
                    // Finished stage's PSP identity is the finished
                    // product's identity — its PSP name mirrors the
                    // Setup product name. Editing lives on Setup;
                    // ``draftToInput`` force-syncs on save.
                    <>
                      <input
                        value={formulation.name}
                        disabled
                        className={`${inputClass} mt-1 cursor-not-allowed bg-ink-50`}
                        title="Managed on Setup — edit the product name there"
                      />
                      <p className="mt-1 text-[11px] text-ink-500">
                        Locked to the Setup product name.
                      </p>
                    </>
                  ) : (
                    <>
                      <input
                        // Raw draft as controlled value + derived name
                        // as placeholder — same reasoning as the SKU
                        // input above.
                        value={draft.psp_item_name}
                        placeholder={derived.name}
                        onChange={(e) =>
                          applyOverride(
                            "psp_item_name",
                            e.target.value,
                            derived.name,
                          )
                        }
                        disabled={!canEdit || upsert.isPending}
                        className={`${inputClass} mt-1`}
                        maxLength={200}
                      />
                      <p className="mt-1 text-[11px] text-ink-500">
                        Edit to override the label shown on PSP. Clearing
                        (or typing the auto value back) restores the
                        derived name.
                      </p>
                    </>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Stock UOM
                    </label>
                    <select
                      value={draft.psp_item_stock_uom_uuid ?? ""}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          psp_item_stock_uom_uuid:
                            e.target.value || null,
                        })
                      }
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
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
                      Product family
                    </label>
                    <select
                      value={draft.psp_item_product_family_uuid ?? ""}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          psp_item_product_family_uuid:
                            e.target.value || null,
                        })
                      }
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    >
                      <option value="">— none —</option>
                      {familyOptions.map((f) => (
                        <option key={f.uuid} value={f.uuid}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,0.5fr)]">
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-medium text-ink-600">
                        Description
                      </label>
                      <AutoOrCustomBadge overridden={descriptionOverridden} />
                    </div>
                    <textarea
                      // Raw draft as controlled value + derived
                      // description as placeholder — same reasoning as
                      // the SKU + name inputs above.
                      value={draft.psp_item_description}
                      placeholder={derived.description}
                      onChange={(e) =>
                        applyOverride(
                          "psp_item_description",
                          e.target.value,
                          derived.description,
                        )
                      }
                      rows={2}
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Barcode (GTIN)
                    </label>
                    <input
                      value={draft.psp_item_barcode}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          psp_item_barcode: e.target.value,
                        })
                      }
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                      placeholder="e.g. 05012345678900"
                    />
                    <p className="mt-1 text-[11px] text-ink-500">
                      Blank leaves PSP&apos;s existing value untouched.
                    </p>
                  </div>
                </div>
                <StageAttributesEditor
                  attributes={draft.psp_item_attributes}
                  disabled={!canEdit || upsert.isPending}
                  onChange={(next) =>
                    updateDraft(draft.clientKey, {
                      psp_item_attributes: next,
                    })
                  }
                />
                {draft.psp_item_type === "finished_product" ? (
                  <p className="mt-3 rounded-lg bg-ink-50/60 p-3 text-[11px] leading-snug text-ink-500 ring-1 ring-inset ring-ink-100">
                    <span className="font-medium">Finished-product spec</span>{" "}
                    (regulatory category, net qty, servings per pack,
                    warnings, storage, target markets…) lives on the
                    Setup tab. The push cascade mirrors those values
                    onto this stage&apos;s PSP spec on the next Save
                    version / Sync now.
                  </p>
                ) : null}
              </div>
                );
              })()}

              {/* Row 2 — SOP notes. Always visible. This is the ONE
                  thing scientists own: what to do on this operation
                  for THIS product. Costs / capacity / crew belong
                  on the workstation on PSP; scheduling belongs to
                  ops. Everything else was clutter for R&D. */}
              <div className="mt-3">
                <label className="text-xs font-medium text-ink-600">
                  SOP notes
                </label>
                <textarea
                  value={draft.operation_description}
                  onChange={(e) =>
                    updateDraft(draft.clientKey, {
                      operation_description: e.target.value,
                    })
                  }
                  rows={2}
                  disabled={!canEdit || upsert.isPending}
                  className={`${inputClass} mt-1`}
                  placeholder="e.g. Blend actives + excipients for 20 min at 40 rpm; screen through 40 mesh."
                />
                <p className="mt-1 text-[11px] text-ink-500">
                  What the shop-floor operator should do on this
                  operation for this product. Ships to PSP as the
                  routing step's operation description.
                </p>
              </div>

              {/* Output-batch bridge to PSP — read-only display of
                  the auto-derived value. Scientists asked us to hide
                  the input so it can't be typed to a wrong number by
                  accident. The number is computed from Setup (fill
                  weight / water volume / servings-per-pack) + the
                  stage's stock UoM; the field on the draft is still
                  populated by the auto-populate effect above so the
                  save payload keeps shipping the same value to PSP. */}
              {(() => {
                const stockUom = uomOptions.find(
                  (u) => u.uuid === draft.psp_item_stock_uom_uuid,
                );
                const suggested = suggestServingsPerOutputUnit({
                  psp_item_type: draft.psp_item_type,
                  stock_uom_symbol: stockUom?.symbol ?? "",
                  dosage_form: formulation.dosage_form,
                  target_fill_weight_mg:
                    formulation.target_fill_weight_mg ?? "",
                  water_volume_ml: formulation.water_volume_ml ?? "",
                  servings_per_pack: formulation.servings_per_pack,
                });
                const suggestedText =
                  suggested !== null
                    ? formatSuggested(suggested)
                    : null;
                const displayValue =
                  suggestedText ??
                  ((draft.servings_per_output_unit || "").trim() || "—");
                return (
                  <div className="mt-3 rounded-xl bg-orange-50/60 p-3 ring-1 ring-inset ring-orange-100">
                    <p className="text-xs font-medium text-ink-700">
                      1 stock-unit of{" "}
                      <strong>
                        {draft.psp_item_name ||
                          (draft.psp_item_type === "finished_product"
                            ? "the finished product"
                            : "this stage's semi output")}
                      </strong>{" "}
                      ={" "}
                      <span className="font-mono text-ink-1000">
                        {displayValue}
                      </span>{" "}
                      servings
                    </p>
                    {suggestedText !== null ? (
                      <p className="mt-1 text-[11px] text-ink-600">
                        Auto-computed from Setup (
                        {draft.psp_item_type === "finished_product"
                          ? `${
                              formulation.servings_per_pack ?? "?"
                            } servings per pack`
                          : `${
                              stockUom?.symbol ?? "stock unit"
                            } vs ${
                              formulation.dosage_form === "liquid"
                                ? `${
                                    formulation.water_volume_ml || "?"
                                  } ml/serving`
                                : `${
                                    formulation.target_fill_weight_mg ||
                                    "?"
                                  } mg/serving`
                            }`}
                        ).
                      </p>
                    ) : (
                      <p className="mt-1 text-[11px] text-ink-600">
                        Pick a stock UOM{" "}
                        {formulation.dosage_form === "liquid"
                          ? "and set water volume on Setup"
                          : "and set fill weight on Setup"}{" "}
                        so we can auto-compute this.
                      </p>
                    )}
                  </div>
                );
              })()}

            </li>
            );
          })}
        </ol>
      )}

      {upsert.isError ? (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-red-600">
          Couldn&apos;t save stages —{" "}
          {(() => {
            const err = upsert.error as unknown as {
              response?: {
                status?: number;
                data?: {
                  message?: unknown;
                  stages?: unknown;
                  detail?: unknown;
                };
              };
              message?: string;
            } | null;
            const body = err?.response?.data;
            if (body && typeof body === "object") {
              if (typeof body.message === "string" && body.message) {
                return body.message;
              }
              if (typeof body.detail === "string" && body.detail) {
                return body.detail;
              }
              // Any string list under a key surfaces first.
              for (const value of Object.values(body)) {
                if (
                  Array.isArray(value) &&
                  value.length > 0 &&
                  typeof value[0] === "string"
                ) {
                  return String(value[0]);
                }
              }
            }
            return err?.message ?? "unknown error";
          })()}
        </p>
      ) : null}
    </section>
  );
}
