"use client";

/**
 * Per-combo stage assignment section on the Routing tab for RTG
 * projects.
 *
 * The RTG catalog panel lets the scientist define one or more
 * PackagingCombos (bottle + label + lid, or pouch + sticker). This
 * section is where they wire each combo into a manufacturing stage,
 * so at customer order time the packaging cascade knows which stage's
 * BOM to overlay with the chosen combo's items.
 *
 * The Builder readiness gate requires every combo on an RTG project
 * to have a stage assignment before Spec sheets unlock — an unassigned
 * combo means "you offer this to customers but the packaging has
 * nowhere to land in production".
 *
 * Save through the existing full-list ``PUT`` endpoint: we hydrate
 * the current combos, mutate only the ``stage_id`` per row, and send
 * everything back. Simpler than a dedicated per-combo mutation and
 * keeps the combo card the single source of truth for combo defs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Loader2 } from "lucide-react";

import { normalizeApiError } from "@/lib/api";
import {
  usePackagingCombos,
  useReplacePackagingCombos,
  type FormulationDto,
  type PackagingComboDto,
} from "@/services/formulations";


interface Props {
  readonly orgId: string;
  readonly formulation: FormulationDto;
  readonly canWrite: boolean;
}


export function PackagingRoutingSection({
  orgId,
  formulation,
  canWrite,
}: Props) {
  //  Only mounts for RTG projects. Custom projects still declare
  //  packaging as an ingredient line — the ingredient inventory
  //  picker handles it there.
  if (formulation.project_type !== "ready_to_go") return null;

  return (
    <PackagingRoutingSectionInner
      orgId={orgId}
      formulation={formulation}
      canWrite={canWrite}
    />
  );
}


function PackagingRoutingSectionInner({
  orgId,
  formulation,
  canWrite,
}: Props) {
  const combosQuery = usePackagingCombos(orgId, formulation.id);
  const replace = useReplacePackagingCombos(orgId, formulation.id);

  //  Local overrides for both the combo-level and per-item stage
  //  pickers so dropdown edits are visible immediately without a
  //  round-trip. Keyed by combo id for the combo default, and by
  //  ``<comboId>:<itemId>`` for per-item overrides. The maps are
  //  empty until the operator changes something.
  const [pending, setPending] = useState<Map<string, string | null>>(
    () => new Map(),
  );
  const [pendingItems, setPendingItems] = useState<
    Map<string, string | null>
  >(() => new Map());
  const [error, setError] = useState<string | null>(null);

  //  Clear any pending overrides once the server round-trip lands
  //  and the query snaps back to the truth.
  useEffect(() => {
    if (!replace.isPending && replace.isSuccess) {
      setPending(new Map());
      setPendingItems(new Map());
    }
  }, [replace.isPending, replace.isSuccess]);

  const combos = useMemo(
    () => combosQuery.data?.items ?? [],
    [combosQuery.data],
  );

  const stages = formulation.stages;

  //  Key for the pendingItems map. Combo id + item id makes each
  //  row's optimistic override uniquely addressable.
  const itemKey = useCallback(
    (comboId: string, itemId: string) => `${comboId}:${itemId}`,
    [],
  );

  const setStageForCombo = useCallback(
    async (combo: PackagingComboDto, nextStageId: string | null) => {
      setError(null);
      //  Optimistic overlay so the dropdown reflects the pick
      //  immediately even though the round-trip is still in flight.
      setPending((prev) => {
        const next = new Map(prev);
        next.set(combo.id, nextStageId);
        return next;
      });
      try {
        await replace.mutateAsync(
          combos.map((c) => ({
            name: c.name,
            price_delta: c.price_delta,
            is_default: c.is_default,
            stage_id:
              c.id === combo.id
                ? nextStageId
                : (pending.get(c.id) ?? c.stage_id) ?? null,
            items: c.items.map((it) => ({
              item_id: it.item_id,
              quantity: it.quantity,
              stage_id:
                (pendingItems.get(itemKey(c.id, it.id)) ?? it.stage_id) ??
                null,
            })),
          })),
        );
      } catch (e) {
        const api = normalizeApiError(e);
        setError(
          (api.payload?.detail as string | undefined) ||
            api.message ||
            "Failed to save the stage assignment.",
        );
        //  Roll back the optimistic overlay so the dropdown snaps to
        //  the last-good value.
        setPending((prev) => {
          const next = new Map(prev);
          next.delete(combo.id);
          return next;
        });
      }
    },
    [combos, pending, pendingItems, itemKey, replace],
  );

  const setStageForItem = useCallback(
    async (
      combo: PackagingComboDto,
      item: PackagingComboDto["items"][number],
      nextStageId: string | null,
    ) => {
      setError(null);
      const key = itemKey(combo.id, item.id);
      //  Optimistic overlay for the per-item picker so the row
      //  reflects the choice immediately.
      setPendingItems((prev) => {
        const next = new Map(prev);
        next.set(key, nextStageId);
        return next;
      });
      try {
        await replace.mutateAsync(
          combos.map((c) => ({
            name: c.name,
            price_delta: c.price_delta,
            is_default: c.is_default,
            stage_id: (pending.get(c.id) ?? c.stage_id) ?? null,
            items: c.items.map((it) => {
              const nextItemStage =
                c.id === combo.id && it.id === item.id
                  ? nextStageId
                  : (pendingItems.get(itemKey(c.id, it.id)) ??
                      it.stage_id) ??
                    null;
              return {
                item_id: it.item_id,
                quantity: it.quantity,
                stage_id: nextItemStage,
              };
            }),
          })),
        );
      } catch (e) {
        const api = normalizeApiError(e);
        setError(
          (api.payload?.detail as string | undefined) ||
            api.message ||
            "Failed to save the item's stage assignment.",
        );
        setPendingItems((prev) => {
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [combos, pending, pendingItems, itemKey, replace],
  );

  //  Effective stage for a combo — apply any pending overlay on top
  //  of what the server returned.
  const effectiveStageId = useCallback(
    (combo: PackagingComboDto): string | null => {
      if (pending.has(combo.id)) return pending.get(combo.id) ?? null;
      return combo.stage_id;
    },
    [pending],
  );

  //  Effective stage for a specific item within a combo. Explicit
  //  override wins; otherwise ``null`` means "inherit combo default"
  //  and the picker renders that as the default option.
  const effectiveItemStageId = useCallback(
    (
      combo: PackagingComboDto,
      item: PackagingComboDto["items"][number],
    ): string | null => {
      const key = itemKey(combo.id, item.id);
      if (pendingItems.has(key)) return pendingItems.get(key) ?? null;
      return item.stage_id;
    },
    [pendingItems, itemKey],
  );

  const unassignedCount = combos.filter(
    (c) => effectiveStageId(c) === null,
  ).length;

  return (
    <section className="rounded-2xl border border-ink-200 bg-ink-0 p-4 shadow-sm">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink-1000">
            <Box className="h-4 w-4 text-orange-600" />
            Packaging combos → stages
          </h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Assign each combo the customer can pick to the stage that
            builds it. When the order arrives, that combo's bottle +
            label + lid drop into the assigned stage's BOM.
          </p>
        </div>
        {replace.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin text-ink-500" />
        ) : null}
      </header>

      {error ? (
        <div className="mb-3 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800">
          {error}
        </div>
      ) : null}

      {combosQuery.isLoading ? (
        <div className="rounded-lg border border-dashed border-ink-300 bg-ink-50 px-4 py-6 text-center text-sm text-ink-500">
          Loading combos…
        </div>
      ) : combos.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-300 bg-ink-50 px-4 py-6 text-center text-sm text-ink-500">
          No packaging combos defined yet — add at least one on the
          RTG catalog panel above the builder before you can route it.
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {combos.map((combo) => {
            const currentStage = effectiveStageId(combo);
            const isUnassigned = currentStage === null;
            const comboStageLabel = currentStage
              ? stages.find((s) => s.id === currentStage)?.name ||
                `Stage ${(stages.findIndex((s) => s.id === currentStage) + 1) || "?"}`
              : "combo default";
            return (
              <li
                key={combo.id}
                className={`flex flex-col gap-3 rounded-lg border px-3 py-2 ${
                  isUnassigned
                    ? "border-amber-300 bg-amber-50/40"
                    : "border-ink-200 bg-white"
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink-1000">
                      {combo.name}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {combo.items.length}{" "}
                      {combo.items.length === 1 ? "item" : "items"}
                      {combo.is_default ? " · default pick" : ""}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs">
                    <span className="whitespace-nowrap text-ink-600">
                      Assembles at
                    </span>
                    <select
                      value={currentStage ?? ""}
                      onChange={(e) =>
                        setStageForCombo(
                          combo,
                          e.currentTarget.value || null,
                        )
                      }
                      disabled={
                        !canWrite ||
                        replace.isPending ||
                        stages.length === 0
                      }
                      className={`rounded-lg border bg-white px-3 py-1.5 text-sm ${
                        isUnassigned
                          ? "border-amber-400 text-amber-900"
                          : "border-ink-300 text-ink-1000"
                      } disabled:cursor-not-allowed disabled:opacity-50`}
                    >
                      <option value="">— pick a stage —</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name || `Stage ${s.sort_order + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {combo.items.length > 0 ? (
                  <div className="ml-1 rounded-md bg-ink-50/60 px-3 py-2 ring-1 ring-inset ring-ink-200">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                      Per-item stage
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-500">
                      Leave any row on{" "}
                      <span className="italic">
                        same as combo ({comboStageLabel})
                      </span>{" "}
                      unless it needs a different stage — e.g. bottle at
                      bottling, label at labelling.
                    </p>
                    <ul className="mt-2 flex flex-col gap-1.5">
                      {combo.items.map((item) => {
                        const currentItemStage = effectiveItemStageId(
                          combo,
                          item,
                        );
                        return (
                          <li
                            key={item.id}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-ink-1000">
                                {item.item_name}
                                {item.quantity !== 1 ? (
                                  <span className="ml-1 text-ink-500">
                                    × {item.quantity}
                                  </span>
                                ) : null}
                              </p>
                              {item.item_code ? (
                                <p className="text-[10px] text-ink-500">
                                  {item.item_code}
                                </p>
                              ) : null}
                            </div>
                            <select
                              value={currentItemStage ?? ""}
                              onChange={(e) =>
                                setStageForItem(
                                  combo,
                                  item,
                                  e.currentTarget.value || null,
                                )
                              }
                              disabled={
                                !canWrite ||
                                replace.isPending ||
                                stages.length === 0
                              }
                              className="rounded-md border border-ink-300 bg-white px-2 py-1 text-xs text-ink-1000 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              <option value="">
                                same as combo ({comboStageLabel})
                              </option>
                              {stages.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name || `Stage ${s.sort_order + 1}`}
                                </option>
                              ))}
                            </select>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {combos.length > 0 && unassignedCount > 0 ? (
        <p className="mt-3 text-xs font-medium text-amber-800">
          {unassignedCount} combo
          {unassignedCount === 1 ? "" : "s"} still unassigned. Every
          active combo needs a stage before the Builder gate clears.
        </p>
      ) : null}
    </section>
  );
}
