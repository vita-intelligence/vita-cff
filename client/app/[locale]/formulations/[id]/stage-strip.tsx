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
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useUpsertStages } from "@/services/formulations/hooks";
import type {
  FormulationDto,
  FormulationStageDto,
  StageKey,
  UpsertStageInput,
} from "@/services/formulations/types";
import { usePspWorkstationGroups } from "@/services/psp/hooks";


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
  setup_time_min: string;
  cycle_time_min: string;
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


function toDraft(stage: FormulationStageDto): StageDraft {
  return {
    clientKey: stage.id,
    id: stage.id,
    sort_order: stage.sort_order,
    name: stage.name,
    stage_key: stage.stage_key,
    workstation_group_uuid: stage.workstation_group_uuid,
    workstation_group_name: stage.workstation_group_name,
    setup_time_min: stage.setup_time_min ?? "",
    cycle_time_min: stage.cycle_time_min ?? "",
  };
}


function draftToInput(draft: StageDraft, index: number): UpsertStageInput {
  const emptyToNull = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    id: draft.id,
    sort_order: index,
    name: draft.name.trim() || `Stage ${index + 1}`,
    stage_key: draft.stage_key,
    workstation_group_uuid: draft.workstation_group_uuid,
    workstation_group_name: draft.workstation_group_name,
    setup_time_min: emptyToNull(draft.setup_time_min),
    cycle_time_min: emptyToNull(draft.cycle_time_min),
  };
}


// Match the builder's plain-input Tailwind style so the strip
// blends in with the surrounding form controls.
const inputClass =
  "w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-50";


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
  /** Live line drafts from the builder, keyed to
   *  :attr:`StageStripBuilderLine.key`. Used to render each stage's
   *  own BOM contents underneath the stage row so the operator can
   *  see "what's in the Blend BOM" without leaving the strip. */
  readonly lines: readonly StageStripBuilderLine[];
}


export function StageStrip({
  orgId,
  formulation,
  canEdit,
  activeStageId,
  onActiveStageChange,
  lines,
}: StageStripProps) {
  const [drafts, setDrafts] = useState<StageDraft[]>(() =>
    formulation.stages.map(toDraft),
  );
  const [pickerOpened, setPickerOpened] = useState(false);
  const upsert = useUpsertStages(orgId, formulation.id);

  // Only fetch workstation groups when the operator touches a
  // stage's workstation dropdown — the builder mount shouldn't
  // trigger a PSP round-trip for every project view.
  const wsQuery = usePspWorkstationGroups(orgId, { enabled: pickerOpened });
  const wsOptions = useMemo(
    () => wsQuery.data?.items ?? [],
    [wsQuery.data],
  );

  // Re-sync when the server-side formulation changes (save,
  // rollback, stage-update by a peer). Deliberately by-id — a
  // rename doesn't stomp local edits mid-typing.
  useEffect(() => {
    setDrafts(formulation.stages.map(toDraft));
  }, [formulation.stages]);

  const dirty = useMemo(() => {
    if (drafts.length !== formulation.stages.length) return true;
    return drafts.some((d, i) => {
      const s = formulation.stages[i];
      if (!s || s.id !== d.id) return true;
      return (
        s.name !== d.name ||
        s.stage_key !== d.stage_key ||
        s.workstation_group_uuid !== d.workstation_group_uuid ||
        (s.setup_time_min ?? "") !== d.setup_time_min ||
        (s.cycle_time_min ?? "") !== d.cycle_time_min
      );
    });
  }, [drafts, formulation.stages]);

  function updateDraft(clientKey: string, patch: Partial<StageDraft>) {
    setDrafts((prev) =>
      prev.map((d) => (d.clientKey === clientKey ? { ...d, ...patch } : d)),
    );
  }

  function addStage() {
    const nextOrder = drafts.length;
    setDrafts((prev) => [
      ...prev,
      {
        clientKey: `new-${Date.now()}-${Math.random()}`,
        sort_order: nextOrder,
        name: `Stage ${nextOrder + 1}`,
        stage_key: "custom",
        workstation_group_uuid: null,
        workstation_group_name: "",
        setup_time_min: "",
        cycle_time_min: "",
      },
    ]);
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
      stages: drafts.map((d, i) => draftToInput(d, i)),
    });
  }

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
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
          <div className="flex items-center gap-2">
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
              isDisabled={!dirty || upsert.isPending}
              className="gap-1.5"
            >
              <Save className="h-4 w-4" />
              {upsert.isPending ? "Saving…" : "Save stages"}
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
            // Lines already assigned to this stage — the operator's
            // per-stage BOM in the making. Unsaved additions
            // ("new-*" keys) also show up so the strip stays in
            // sync with the picker in real time.
            const stageLines = stageId
              ? lines.filter((l) => l.stage_id === stageId)
              : [];
            const isTerminal = i === drafts.length - 1;
            return (
            <li
              key={draft.clientKey}
              className={
                isActive
                  ? "rounded-xl bg-orange-50 p-4 ring-1 ring-inset ring-orange-300"
                  : "rounded-xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200"
              }
            >
              <div className="flex items-start justify-between gap-3">
                <div className="grid flex-1 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,0.6fr)_minmax(0,0.6fr)]">
                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Stage {i + 1}
                    </label>
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
                  </div>

                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Kind
                    </label>
                    <select
                      value={draft.stage_key}
                      onChange={(e) =>
                        updateDraft(draft.clientKey, {
                          stage_key: e.target.value as StageKey,
                        })
                      }
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    >
                      {Object.entries(STAGE_KEY_LABELS).map(
                        ([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-ink-600">
                      Workstation
                    </label>
                    <select
                      value={draft.workstation_group_uuid ?? ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        const picked = wsOptions.find(
                          (w) => w.uuid === v,
                        );
                        updateDraft(draft.clientKey, {
                          workstation_group_uuid: v || null,
                          workstation_group_name: picked?.name ?? "",
                        });
                      }}
                      onFocus={() => setPickerOpened(true)}
                      disabled={!canEdit || upsert.isPending}
                      className={`${inputClass} mt-1`}
                    >
                      <option value="">
                        {draft.workstation_group_name ||
                          "Pick a machine…"}
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
                        Loading workstations…
                      </p>
                    ) : null}
                    {pickerOpened &&
                    !wsQuery.isLoading &&
                    wsOptions.length === 0 ? (
                      <p className="mt-1 text-xs text-ink-500">
                        No workstations on PSP yet.
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
                      disabled={upsert.isPending}
                      className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-30"
                      title="Remove stage"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ) : null}
              </div>

              {/* Per-stage BOM contents. Renders the ingredient
                  lines already assigned to this stage + a button
                  that sets it as the sticky "adding to" target so
                  the next pick from the picker lands here. On the
                  terminal stage a hint reminds the operator that
                  unassigned (null-stage) lines fold into this BOM
                  on the push cascade. */}
              {stageId !== null ? (
                <div className="mt-3 rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                      BOM · {stageLines.length}{" "}
                      {stageLines.length === 1
                        ? "ingredient"
                        : "ingredients"}
                    </p>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => onActiveStageChange(stageId)}
                        disabled={upsert.isPending}
                        className={
                          isActive
                            ? "rounded-md bg-orange-100 px-2 py-1 text-xs font-medium text-orange-800 ring-1 ring-inset ring-orange-300"
                            : "rounded-md bg-ink-50 px-2 py-1 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-orange-50 hover:text-orange-700"
                        }
                      >
                        {isActive
                          ? "Active target"
                          : "Add ingredients here"}
                      </button>
                    ) : null}
                  </div>
                  {stageLines.length === 0 ? (
                    <p className="mt-2 text-xs text-ink-500">
                      No ingredients assigned yet. Click "Add
                      ingredients here" to make this stage the
                      picker's target, then pick from the
                      ingredient list.
                    </p>
                  ) : (
                    <ul className="mt-2 flex flex-col gap-1 text-sm text-ink-1000">
                      {stageLines.map((line) => (
                        <li
                          key={line.key}
                          className="flex items-center justify-between gap-2 border-b border-dashed border-ink-100 py-1 last:border-b-0"
                        >
                          <span>
                            {line.item_name}
                            {line.item_internal_code ? (
                              <span className="ml-2 text-xs text-ink-500">
                                {line.item_internal_code}
                              </span>
                            ) : null}
                          </span>
                          <span className="text-xs tabular-nums text-ink-700">
                            {line.label_claim_mg || "0"} mg
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {isTerminal ? (
                    <p className="mt-2 text-[11px] italic text-ink-500">
                      Terminal stage — any ingredient without a
                      stage assignment folds into this BOM on the
                      next save.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
            );
          })}
        </ol>
      )}

      {upsert.isError ? (
        <p className="mt-3 text-sm text-red-600">
          Couldn't save stages. Please try again.
        </p>
      ) : null}
    </section>
  );
}
