"use client";

import { Button } from "@heroui/react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  DOSAGE_FORMS,
  useCreateStageTemplate,
  useDeleteStageTemplate,
  useStageTemplates,
  useUpdateStageTemplate,
  type StageTemplateDto,
  type StageTemplateStageDto,
  type UpsertStageTemplateRequestDto,
} from "@/services/formulations";
import { usePspWorkstationGroups } from "@/services/psp";


/** Stage-key vocabulary that matches the FormulationStage model.
 *  Kept as a plain list so the FE never diverges — mirrors the values
 *  ``inferStageKey`` in stage-strip.tsx uses. */
const STAGE_KEYS = [
  "blend",
  "encapsulate",
  "bottle",
  "label",
  "fill",
  "cook",
  "deposit",
  "cure",
  "coat",
  "package",
  "custom",
] as const;


interface StageDraft {
  readonly clientKey: string;
  name: string;
  stage_key: string;
  psp_item_type: "semi_finished" | "finished_product";
  operation_description: string;
  setup_time_min: string;
  cycle_time_min: string;
  workstation_group_uuid: string | null;
  workstation_group_name: string;
}


interface TemplateDraft {
  readonly clientKey: string;
  id: string | null;
  name: string;
  description: string;
  dosage_form: string;
  stages: StageDraft[];
  is_seeded: boolean;
  isNew: boolean;
  expanded: boolean;
}


function stageDraftFromDto(
  s: StageTemplateStageDto,
  index: number,
): StageDraft {
  return {
    clientKey: `stage-${index}-${Math.random().toString(36).slice(2)}`,
    name: s.name ?? "",
    stage_key: s.stage_key ?? "custom",
    psp_item_type: s.psp_item_type ?? "semi_finished",
    operation_description: s.operation_description ?? "",
    setup_time_min: s.setup_time_min ?? "",
    cycle_time_min: s.cycle_time_min ?? "",
    workstation_group_uuid: s.workstation_group_uuid ?? null,
    workstation_group_name: s.workstation_group_name ?? "",
  };
}


function templateDraftFromDto(t: StageTemplateDto): TemplateDraft {
  return {
    clientKey: t.id,
    id: t.id,
    name: t.name,
    description: t.description,
    dosage_form: t.dosage_form,
    stages: t.stages.map(stageDraftFromDto),
    is_seeded: t.is_seeded,
    isNew: false,
    expanded: false,
  };
}


function draftToRequest(
  draft: TemplateDraft,
  wsOptions: readonly { uuid: string; name: string }[],
): UpsertStageTemplateRequestDto {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    dosage_form: draft.dosage_form,
    stages: draft.stages.map((s, index) => {
      // Auto-link workstation on save: if the operator hasn't
      // explicitly picked one but the stage name exactly matches a
      // PSP workstation name (case-insensitive), use that. Covers
      // the common case where the stage name IS the workstation name
      // ("Blending", "Encapsulation", …) — the picker feels redundant
      // when it just mirrors the label above it.
      let uuid = s.workstation_group_uuid;
      let name = s.workstation_group_name;
      if (!uuid && s.name.trim()) {
        const needle = s.name.trim().toLowerCase();
        const match = wsOptions.find(
          (w) => w.name.toLowerCase() === needle,
        );
        if (match) {
          uuid = match.uuid;
          name = match.name;
        }
      }
      return {
        sort_order: index,
        name: s.name.trim() || `Stage ${index + 1}`,
        stage_key: s.stage_key || "custom",
        psp_item_type: s.psp_item_type,
        operation_description: s.operation_description.trim() || undefined,
        setup_time_min: s.setup_time_min.trim() || null,
        cycle_time_min: s.cycle_time_min.trim() || null,
        workstation_group_uuid: uuid,
        workstation_group_name: name,
      };
    }),
  };
}


const emptyStage = (): StageDraft => ({
  clientKey: `stage-new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  name: "",
  stage_key: "custom",
  psp_item_type: "semi_finished",
  operation_description: "",
  setup_time_min: "",
  cycle_time_min: "",
  workstation_group_uuid: null,
  workstation_group_name: "",
});


const emptyTemplate = (): TemplateDraft => ({
  clientKey: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  id: null,
  name: "",
  description: "",
  dosage_form: "",
  stages: [
    { ...emptyStage(), name: "Stage 1", psp_item_type: "semi_finished" },
    { ...emptyStage(), name: "Stage 2", psp_item_type: "finished_product" },
  ],
  is_seeded: false,
  isNew: true,
  expanded: true,
});


export function StageTemplatesTab({ orgId }: { orgId: string }) {
  const templatesQuery = useStageTemplates(orgId);
  const createMutation = useCreateStageTemplate(orgId);
  const updateMutation = useUpdateStageTemplate(orgId);
  const deleteMutation = useDeleteStageTemplate(orgId);
  // Workstation picker feeds — same source as the builder's stage
  // strip, so scientists see the identical roster when configuring
  // a template as they do when configuring a live stage.
  const wsQuery = usePspWorkstationGroups(orgId);
  const wsOptions = useMemo(
    () => wsQuery.data?.items ?? [],
    [wsQuery.data],
  );

  // Drafts live locally so the operator can edit multiple rows +
  // batch decide when to save. Re-hydrated from the server query on
  // mount + after each save.
  const [drafts, setDrafts] = useState<TemplateDraft[]>([]);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const serverRows = useMemo(
    () => templatesQuery.data?.items ?? [],
    [templatesQuery.data],
  );

  // Hydrate drafts from the server exactly once + after any explicit
  // "reload" call.
  if (!hasHydrated && serverRows.length >= 0 && !templatesQuery.isLoading) {
    setDrafts(serverRows.map(templateDraftFromDto));
    setHasHydrated(true);
  }

  const patchDraft = (clientKey: string, patch: Partial<TemplateDraft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.clientKey === clientKey ? { ...d, ...patch } : d)),
    );
  };

  const patchStage = (
    tKey: string,
    stageKey: string,
    patch: Partial<StageDraft>,
  ) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.clientKey !== tKey) return d;
        return {
          ...d,
          stages: d.stages.map((s) =>
            s.clientKey === stageKey ? { ...s, ...patch } : s,
          ),
        };
      }),
    );
  };

  const addStageRow = (tKey: string) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.clientKey !== tKey) return d;
        return { ...d, stages: [...d.stages, emptyStage()] };
      }),
    );
  };

  const removeStageRow = (tKey: string, stageKey: string) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.clientKey !== tKey) return d;
        return {
          ...d,
          stages: d.stages.filter((s) => s.clientKey !== stageKey),
        };
      }),
    );
  };

  const moveStage = (tKey: string, stageKey: string, delta: -1 | 1) => {
    setDrafts((prev) =>
      prev.map((d) => {
        if (d.clientKey !== tKey) return d;
        const i = d.stages.findIndex((s) => s.clientKey === stageKey);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= d.stages.length) return d;
        const next = [...d.stages];
        const a = next[i]!;
        const b = next[j]!;
        next[i] = b;
        next[j] = a;
        return { ...d, stages: next };
      }),
    );
  };

  const addTemplate = () => {
    setDrafts((prev) => [emptyTemplate(), ...prev]);
  };

  const saveDraft = async (draft: TemplateDraft) => {
    setRowError((prev) => ({ ...prev, [draft.clientKey]: "" }));
    if (!draft.name.trim()) {
      setRowError((prev) => ({
        ...prev,
        [draft.clientKey]: "Name is required.",
      }));
      return;
    }
    if (draft.stages.length === 0) {
      setRowError((prev) => ({
        ...prev,
        [draft.clientKey]: "At least one stage is required.",
      }));
      return;
    }
    const payload = draftToRequest(draft, wsOptions);
    try {
      if (draft.isNew || !draft.id) {
        const created = await createMutation.mutateAsync(payload);
        // Replace the local draft with the persisted row so the
        // clientKey now matches the server id.
        setDrafts((prev) =>
          prev.map((d) =>
            d.clientKey === draft.clientKey
              ? { ...templateDraftFromDto(created), expanded: true }
              : d,
          ),
        );
      } else {
        const updated = await updateMutation.mutateAsync({
          templateId: draft.id,
          patch: payload,
        });
        setDrafts((prev) =>
          prev.map((d) =>
            d.clientKey === draft.clientKey
              ? { ...templateDraftFromDto(updated), expanded: d.expanded }
              : d,
          ),
        );
      }
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [draft.clientKey]:
          err instanceof Error ? err.message : "Save failed.",
      }));
    }
  };

  const deleteDraft = async (draft: TemplateDraft) => {
    if (!draft.id) {
      // Local-only unsaved row — just drop it.
      setDrafts((prev) => prev.filter((d) => d.clientKey !== draft.clientKey));
      return;
    }
    setRowError((prev) => ({ ...prev, [draft.clientKey]: "" }));
    try {
      await deleteMutation.mutateAsync(draft.id);
      setDrafts((prev) => prev.filter((d) => d.clientKey !== draft.clientKey));
      setPendingDeleteId(null);
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [draft.clientKey]:
          err instanceof Error ? err.message : "Delete failed.",
      }));
    }
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <h2 className="text-lg font-semibold tracking-tight text-ink-1000">
            Stage templates
          </h2>
          <p className="mt-1 text-sm text-ink-600">
            Reusable production-stage graphs the New-formulation dialog and
            the Stages tab pick from. Scientists apply them; the reshape
            right sits with this settings surface. Seeded templates are
            marked and can be edited or removed like any other.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onPress={addTemplate}
          className="gap-1.5"
        >
          <Plus className="h-4 w-4" />
          New template
        </Button>
      </header>

      {templatesQuery.isLoading ? (
        <p className="mt-4 text-sm text-ink-500">Loading…</p>
      ) : templatesQuery.isError ? (
        <p className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-200">
          Couldn&apos;t load templates. Refresh the page or try again.
        </p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {drafts.length === 0 ? (
            <li className="rounded-lg bg-ink-50 p-4 text-sm text-ink-600 ring-1 ring-inset ring-ink-200">
              No templates yet. Add one with the button above.
            </li>
          ) : (
            drafts.map((draft) => {
              const isMutating =
                (draft.isNew && createMutation.isPending) ||
                (!draft.isNew && updateMutation.isPending);
              return (
                <li
                  key={draft.clientKey}
                  className="rounded-xl bg-ink-0 ring-1 ring-ink-200"
                >
                  {/* Header row: name + expand toggle + save + delete */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 p-3">
                    <button
                      type="button"
                      onClick={() =>
                        patchDraft(draft.clientKey, {
                          expanded: !draft.expanded,
                        })
                      }
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      {draft.expanded ? (
                        <ChevronDown className="h-4 w-4 text-ink-500" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-ink-500" />
                      )}
                      <span className="text-sm font-medium text-ink-1000">
                        {draft.name || (draft.isNew ? "(new template)" : "(untitled)")}
                      </span>
                      <span className="text-[11px] text-ink-500">
                        {draft.stages.length} stage
                        {draft.stages.length === 1 ? "" : "s"}
                      </span>
                      {draft.dosage_form ? (
                        <span className="rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-600">
                          {draft.dosage_form}
                        </span>
                      ) : null}
                      {draft.is_seeded ? (
                        <span
                          className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-orange-700 ring-1 ring-inset ring-orange-200"
                          title="Seeded default. Safe to edit or delete."
                        >
                          seeded
                        </span>
                      ) : null}
                    </button>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onPress={() => saveDraft(draft)}
                        isDisabled={isMutating}
                        className="gap-1.5"
                      >
                        {isMutating ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                        Save
                      </Button>
                      {pendingDeleteId === draft.clientKey ? (
                        <>
                          <button
                            type="button"
                            onClick={() => deleteDraft(draft)}
                            disabled={deleteMutation.isPending}
                            className="rounded-lg bg-red-500 px-2 py-1 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                          >
                            {deleteMutation.isPending ? "Deleting…" : "Confirm"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingDeleteId(null)}
                            className="text-[11px] text-ink-500 hover:text-ink-700"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPendingDeleteId(draft.clientKey)}
                          className="rounded p-1.5 text-ink-500 hover:bg-red-50 hover:text-red-600"
                          aria-label="Delete template"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {draft.expanded ? (
                    <div className="p-3">
                      {rowError[draft.clientKey] ? (
                        <p className="mb-3 rounded-lg bg-red-50 p-2 text-[12px] text-red-700 ring-1 ring-inset ring-red-200">
                          {rowError[draft.clientKey]}
                        </p>
                      ) : null}
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] font-medium text-ink-600">
                            Name
                          </span>
                          <input
                            value={draft.name}
                            onChange={(e) =>
                              patchDraft(draft.clientKey, { name: e.target.value })
                            }
                            className="w-full rounded-lg bg-ink-0 px-3 py-1.5 text-sm ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                            placeholder="e.g. Capsule — 3-stage"
                            maxLength={200}
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[11px] font-medium text-ink-600">
                            Dosage form (optional)
                          </span>
                          <select
                            value={draft.dosage_form}
                            onChange={(e) =>
                              patchDraft(draft.clientKey, {
                                dosage_form: e.target.value,
                              })
                            }
                            className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-1.5 text-sm ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                          >
                            <option value="">— any —</option>
                            {DOSAGE_FORMS.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="flex flex-col gap-1 md:col-span-2">
                          <span className="text-[11px] font-medium text-ink-600">
                            Description (optional)
                          </span>
                          <input
                            value={draft.description}
                            onChange={(e) =>
                              patchDraft(draft.clientKey, {
                                description: e.target.value,
                              })
                            }
                            className="w-full rounded-lg bg-ink-0 px-3 py-1.5 text-sm ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                            placeholder="Short hint shown in the picker"
                          />
                        </label>
                      </div>

                      <div className="mt-4">
                        <div className="flex items-center justify-between">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
                            Stages ({draft.stages.length})
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onPress={() => addStageRow(draft.clientKey)}
                            className="gap-1.5"
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add stage
                          </Button>
                        </div>
                        <ul className="mt-2 flex flex-col gap-2">
                          {draft.stages.map((s, i) => (
                            <li
                              key={s.clientKey}
                              className="flex flex-col gap-1.5 rounded-lg bg-ink-50 p-2 ring-1 ring-inset ring-ink-200"
                            >
                            <div className="grid grid-cols-1 gap-2 md:grid-cols-[24px_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.6fr)_minmax(0,0.6fr)_auto]">
                              <span className="flex items-center text-[11px] font-mono text-ink-500">
                                {i + 1}
                              </span>
                              <input
                                value={s.name}
                                onChange={(e) =>
                                  patchStage(draft.clientKey, s.clientKey, {
                                    name: e.target.value,
                                  })
                                }
                                placeholder="Stage name"
                                maxLength={150}
                                className="rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                              />
                              <select
                                value={s.stage_key}
                                onChange={(e) =>
                                  patchStage(draft.clientKey, s.clientKey, {
                                    stage_key: e.target.value,
                                  })
                                }
                                className="rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                              >
                                {STAGE_KEYS.map((k) => (
                                  <option key={k} value={k}>
                                    {k}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={s.psp_item_type}
                                onChange={(e) =>
                                  patchStage(draft.clientKey, s.clientKey, {
                                    psp_item_type: e.target.value as
                                      | "semi_finished"
                                      | "finished_product",
                                  })
                                }
                                className="rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                              >
                                <option value="semi_finished">semi</option>
                                <option value="finished_product">finished</option>
                              </select>
                              <input
                                value={s.setup_time_min}
                                onChange={(e) =>
                                  patchStage(draft.clientKey, s.clientKey, {
                                    setup_time_min: e.target.value,
                                  })
                                }
                                placeholder="Setup"
                                inputMode="decimal"
                                className="rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                                title="Setup time (min)"
                              />
                              <input
                                value={s.cycle_time_min}
                                onChange={(e) =>
                                  patchStage(draft.clientKey, s.clientKey, {
                                    cycle_time_min: e.target.value,
                                  })
                                }
                                placeholder="Cycle"
                                inputMode="decimal"
                                className="rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                                title="Cycle time (min)"
                              />
                              <div className="flex items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    moveStage(draft.clientKey, s.clientKey, -1)
                                  }
                                  disabled={i === 0}
                                  className="rounded p-1 text-ink-500 hover:bg-ink-100 disabled:opacity-30"
                                  aria-label="Move up"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    moveStage(draft.clientKey, s.clientKey, 1)
                                  }
                                  disabled={i === draft.stages.length - 1}
                                  className="rounded p-1 text-ink-500 hover:bg-ink-100 disabled:opacity-30"
                                  aria-label="Move down"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    removeStageRow(draft.clientKey, s.clientKey)
                                  }
                                  className="rounded p-1 text-red-600 hover:bg-red-50"
                                  aria-label="Remove stage"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                            {/* Second row: workstation picker (PSP
                                catalogue). Keeps its own row so the
                                dropdown has real estate + the primary
                                stage columns stay compact. */}
                            <div className="flex items-center gap-2 pl-6">
                              <span className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                                Operation
                              </span>
                              <select
                                value={s.workstation_group_uuid ?? ""}
                                onChange={(e) => {
                                  const uuid = e.target.value || null;
                                  const picked = wsOptions.find(
                                    (w) => w.uuid === uuid,
                                  );
                                  patchStage(draft.clientKey, s.clientKey, {
                                    workstation_group_uuid: uuid,
                                    workstation_group_name: picked?.name ?? "",
                                  });
                                }}
                                className="flex-1 rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                                title="Pre-fill the workstation group on stages spawned from this template. Blank leaves it open for the scientist to pick per-project."
                              >
                                <option value="">— any / scientist picks —</option>
                                {wsOptions.map((w) => (
                                  <option key={w.uuid} value={w.uuid}>
                                    {w.name}
                                  </option>
                                ))}
                              </select>
                              <input
                                value={s.operation_description}
                                onChange={(e) =>
                                  patchStage(draft.clientKey, s.clientKey, {
                                    operation_description: e.target.value,
                                  })
                                }
                                placeholder="Default SOP note (optional)"
                                className="flex-1 rounded bg-ink-0 px-2 py-1 text-xs ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                              />
                            </div>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 text-[11px] text-ink-500">
                          Last stage in the list becomes the finished
                          product on push; every earlier stage is a
                          semi-finished intermediate. Setup / cycle are
                          minutes, blank = leave PSP&apos;s existing value.
                        </p>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      )}
    </section>
  );
}
