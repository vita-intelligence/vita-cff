"use client";

/**
 * Packaging-combo editor on the RTG project workspace.
 *
 * Only mounted for ``project_type=ready_to_go`` rows. Lets scientists
 * define N named packaging bundles (bottle + label + lid, etc.) that
 * the customer will pick from at order time. Each combo carries an
 * ordered list of packaging items + a price delta on top of the
 * RTG base price.
 *
 * PUT-all API contract — the editor holds the full combo list in
 * local state, saves the whole array in a single call. Simpler than
 * piecemeal CRUD and matches how the backend accepts writes.
 *
 * Phase 1 (this file): staff editor. Phase 2 will wire the customer
 * portal picker + cascade the chosen combo into the spec sheet +
 * routing snapshot on order.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Package,
  Pencil,
  Plus,
  Star,
  Trash2,
  X,
} from "lucide-react";

import { apiClient, normalizeApiError } from "@/lib/api";
import {
  usePackagingCombos,
  useReplacePackagingCombos,
  type PackagingComboDto,
  type PackagingComboInput,
} from "@/services/formulations";


interface Props {
  readonly orgId: string;
  readonly formulationId: string;
  readonly canEdit: boolean;
}


export function PackagingCombosCard({
  orgId,
  formulationId,
  canEdit,
}: Props) {
  const query = usePackagingCombos(orgId, formulationId);
  const combos = query.data?.items ?? [];
  const [editing, setEditing] = useState<PackagingComboDto | "new" | null>(
    null,
  );
  const replace = useReplacePackagingCombos(orgId, formulationId);
  const [error, setError] = useState<string | null>(null);

  const saveList = async (next: PackagingComboInput[]) => {
    setError(null);
    try {
      await replace.mutateAsync(next);
      setEditing(null);
    } catch (err) {
      const api = normalizeApiError(err);
      setError(
        (api.payload?.detail as string | undefined) ||
          api.message ||
          "Failed to save packaging combos.",
      );
    }
  };

  const upsertCombo = (
    edited: PackagingComboInput,
    replacingId: string | null,
  ) => {
    const asInput = combos.map(dtoToInput);
    const next: PackagingComboInput[] = replacingId
      ? asInput.map((c, i) => (combos[i]?.id === replacingId ? edited : c))
      : [...asInput, edited];
    // Only one default allowed; if this one flipped default on, clear
    // any prior default so the BE guard doesn't 400 us.
    const normalised = next.map((c, i) =>
      edited.is_default && next[i] !== edited
        ? { ...c, is_default: false }
        : c,
    );
    return saveList(normalised);
  };

  const deleteCombo = (comboId: string) => {
    if (!window.confirm("Delete this packaging combo?")) return;
    const next = combos
      .filter((c) => c.id !== comboId)
      .map(dtoToInput);
    return saveList(next);
  };

  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center gap-2">
        <Package className="h-4 w-4 text-ink-400" />
        <h2 className="text-sm font-semibold text-ink-1000">
          Packaging combos
        </h2>
        <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-[10px] font-semibold text-ink-700">
          {combos.length}
        </span>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="inline-flex items-center gap-1 rounded-lg bg-ink-1000 px-3 py-1.5 text-xs font-semibold text-white hover:bg-ink-900"
          >
            <Plus className="h-3 w-3" /> New combo
          </button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-ink-500">
        Named packaging bundles the customer picks from at order time.
        Each combo lists the items it ships with and the price uplift
        applied on top of the base RTG price.
      </p>

      {query.isLoading ? (
        <p className="mt-4 inline-flex items-center gap-2 text-xs text-ink-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading combos…
        </p>
      ) : combos.length === 0 ? (
        <p className="mt-4 rounded-xl bg-ink-50 px-3 py-4 text-center text-xs italic text-ink-500">
          No packaging combos yet.{" "}
          {canEdit ? "Click New combo to add one." : ""}
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {combos.map((combo) => (
            <li
              key={combo.id}
              className="rounded-xl bg-ink-50 px-4 py-3 ring-1 ring-inset ring-ink-200"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-semibold text-ink-1000">
                  {combo.name}
                </span>
                {combo.is_default ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                    <Star className="h-3 w-3" /> Default
                  </span>
                ) : null}
                {Number(combo.price_delta) !== 0 ? (
                  <span
                    className={`text-xs font-medium ${
                      Number(combo.price_delta) > 0
                        ? "text-emerald-700"
                        : "text-rose-700"
                    }`}
                  >
                    {Number(combo.price_delta) > 0 ? "+" : ""}
                    {combo.price_delta}
                  </span>
                ) : null}
                {canEdit ? (
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(combo)}
                      className="rounded-md p-1 text-ink-500 hover:bg-ink-100 hover:text-ink-1000"
                      aria-label="Edit combo"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteCombo(combo.id)}
                      disabled={replace.isPending}
                      className="rounded-md p-1 text-ink-500 hover:bg-rose-100 hover:text-rose-700 disabled:opacity-50"
                      aria-label="Delete combo"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {combo.items.map((row) => (
                  <li
                    key={row.id}
                    className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-ink-700 ring-1 ring-inset ring-ink-200"
                    title={row.item_code}
                  >
                    <span>{row.item_name}</span>
                    {row.quantity !== 1 ? (
                      <span className="text-ink-500">× {row.quantity}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </p>
      ) : null}

      {editing !== null ? (
        <ComboEditor
          orgId={orgId}
          initial={editing === "new" ? null : editing}
          existingNames={combos
            .filter((c) => editing === "new" || c.id !== editing.id)
            .map((c) => c.name.toLowerCase())}
          busy={replace.isPending}
          onCancel={() => setEditing(null)}
          onSave={(row) =>
            upsertCombo(row, editing === "new" ? null : editing.id)
          }
        />
      ) : null}
    </div>
  );
}


function dtoToInput(combo: PackagingComboDto): PackagingComboInput {
  return {
    name: combo.name,
    price_delta: combo.price_delta,
    is_default: combo.is_default,
    items: combo.items.map((row) => ({
      item_id: row.item_id,
      quantity: row.quantity,
    })),
  };
}


// ---- Editor modal ----------------------------------------------------


interface PackagingItemOption {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}


function ComboEditor({
  orgId,
  initial,
  existingNames,
  busy,
  onCancel,
  onSave,
}: {
  orgId: string;
  initial: PackagingComboDto | null;
  existingNames: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onSave: (row: PackagingComboInput) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [priceDelta, setPriceDelta] = useState(initial?.price_delta ?? "0");
  const [isDefault, setIsDefault] = useState(initial?.is_default ?? false);
  const [items, setItems] = useState<
    { item_id: string; item_name: string; item_code: string; quantity: number }[]
  >(
    initial?.items.map((row) => ({
      item_id: row.item_id,
      item_name: row.item_name,
      item_code: row.item_code,
      quantity: row.quantity,
    })) ?? [],
  );
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<PackagingItemOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  // Bumped whenever a search re-fires so a slow first-page fetch
  // can't race a fresh one and overwrite fresher results with
  // stale ones.
  const searchGenRef = useRef(0);

  const mapResults = useCallback(
    (rows: readonly PackagingItemOption[]): PackagingItemOption[] =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        code:
          (r as unknown as { internal_code?: string }).internal_code ?? "",
      })),
    [],
  );

  // First-page fetch on open + on every search change. Debounced
  // 250 ms so keystrokes don't hammer the API. Resets pagination
  // state so a stale ``nextUrl`` from the previous query can't
  // fetch page 2 of the wrong query.
  useEffect(() => {
    const gen = searchGenRef.current + 1;
    searchGenRef.current = gen;

    const t = setTimeout(async () => {
      setLoadingOptions(true);
      try {
        const params = new URLSearchParams();
        // Larger page size — the picker used to cap at 20 which
        // stopped working the moment the catalog held anything
        // real. 50 is a good tradeoff for the modal viewport.
        params.set("page_size", "50");
        params.set("ordering", "name");
        if (search.trim()) params.set("search", search.trim());
        const { data } = await apiClient.get<{
          results: PackagingItemOption[];
          next: string | null;
        }>(
          `/api/organizations/${orgId}/catalogues/packaging/items/?${params.toString()}`,
        );
        if (searchGenRef.current !== gen) return;
        setOptions(mapResults(data.results ?? []));
        setNextUrl(data.next ?? null);
      } catch {
        if (searchGenRef.current !== gen) return;
        setOptions([]);
        setNextUrl(null);
      } finally {
        if (searchGenRef.current === gen) setLoadingOptions(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [orgId, search, mapResults]);

  // Fetch the next page. Cursor URL comes from the backend (DRF
  // cursor pagination emits absolute URLs) so we don't have to
  // hand-craft the cursor token.
  const fetchNext = useCallback(async () => {
    if (!nextUrl || loadingOptions) return;
    const gen = searchGenRef.current;
    setLoadingOptions(true);
    try {
      const { data } = await apiClient.get<{
        results: PackagingItemOption[];
        next: string | null;
      }>(nextUrl);
      if (searchGenRef.current !== gen) return;
      setOptions((prev) => [...prev, ...mapResults(data.results ?? [])]);
      setNextUrl(data.next ?? null);
    } catch {
      // Silent — leaves the current page shown. User can scroll
      // again to retry; a hard failure isn't worth a toast in a
      // small picker.
    } finally {
      if (searchGenRef.current === gen) setLoadingOptions(false);
    }
  }, [nextUrl, loadingOptions, mapResults]);

  // Sentinel-driven auto-load. ``rootMargin`` = 120px so the next
  // page starts loading before the user actually hits the bottom
  // (avoids the "wait for content" pause on scroll).
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || !nextUrl) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          void fetchNext();
        }
      },
      { root, rootMargin: "120px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchNext, nextUrl, options.length]);

  const pickedIds = useMemo(
    () => new Set(items.map((i) => i.item_id)),
    [items],
  );

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setValidation("Give the combo a name.");
      return;
    }
    if (existingNames.includes(trimmed.toLowerCase())) {
      setValidation("Another combo already uses this name.");
      return;
    }
    if (items.length === 0) {
      setValidation("Add at least one packaging item.");
      return;
    }
    const numDelta = Number(priceDelta);
    if (!Number.isFinite(numDelta)) {
      setValidation("Price delta must be a number.");
      return;
    }
    setValidation(null);
    onSave({
      name: trimmed,
      price_delta: numDelta.toFixed(2),
      is_default: isDefault,
      items: items.map((i) => ({ item_id: i.item_id, quantity: i.quantity })),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Packaging combo
            </p>
            <h3 className="mt-0.5 text-lg font-semibold text-ink-1000">
              {initial ? "Edit combo" : "New combo"}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full p-1 text-ink-500 hover:bg-ink-100"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-col gap-3">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-700">
              Combo name
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Bottle 60ct — premium"
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
              autoFocus
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-700">
                Price delta
              </span>
              <input
                type="number"
                step="0.01"
                value={priceDelta}
                onChange={(e) => setPriceDelta(e.currentTarget.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
              />
              <p className="mt-1 text-[10px] text-ink-500">
                On top of the RTG base price. 0 = same price.
              </p>
            </label>
            <label className="mt-6 inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.currentTarget.checked)}
                className="h-4 w-4 rounded border-ink-300"
              />
              Default in picker
            </label>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-700">
              Items ({items.length})
            </p>
            {items.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1.5">
                {items.map((row, idx) => (
                  <li
                    key={row.item_id}
                    className="flex items-center gap-2 rounded-lg bg-ink-50 px-3 py-1.5 text-xs ring-1 ring-inset ring-ink-200"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink-1000">
                        {row.item_name}
                      </p>
                      {row.item_code ? (
                        <p className="text-[10px] text-ink-500">
                          {row.item_code}
                        </p>
                      ) : null}
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={row.quantity}
                      onChange={(e) => {
                        const q = Math.max(
                          1,
                          Number(e.currentTarget.value) || 1,
                        );
                        setItems((prev) =>
                          prev.map((r, i) =>
                            i === idx ? { ...r, quantity: q } : r,
                          ),
                        );
                      }}
                      className="w-14 rounded border border-ink-300 px-2 py-1 text-right text-xs"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setItems((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="rounded p-1 text-ink-500 hover:bg-rose-100 hover:text-rose-700"
                      aria-label="Remove item"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="mt-3">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                placeholder="Search packaging catalog…"
                className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
              />
              <div
                ref={listRef}
                className="mt-1 max-h-60 overflow-y-auto rounded-lg bg-ink-50 ring-1 ring-inset ring-ink-200"
              >
                {options.length === 0 && loadingOptions ? (
                  <p className="p-3 text-xs text-ink-500">
                    <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
                    Loading…
                  </p>
                ) : options.length === 0 ? (
                  <p className="p-3 text-xs text-ink-500">
                    No packaging items found.
                  </p>
                ) : (
                  <ul>
                    {options.map((opt) => {
                      const already = pickedIds.has(opt.id);
                      return (
                        <li key={opt.id}>
                          <button
                            type="button"
                            disabled={already}
                            onClick={() =>
                              setItems((prev) => [
                                ...prev,
                                {
                                  item_id: opt.id,
                                  item_name: opt.name,
                                  item_code: opt.code,
                                  quantity: 1,
                                },
                              ])
                            }
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <span className="flex-1 truncate">{opt.name}</span>
                            {opt.code ? (
                              <span className="text-[10px] text-ink-500">
                                {opt.code}
                              </span>
                            ) : null}
                            {already ? (
                              <span className="text-[10px] text-ink-500">
                                Added
                              </span>
                            ) : (
                              <Plus className="h-3 w-3 text-ink-500" />
                            )}
                          </button>
                        </li>
                      );
                    })}
                    {nextUrl ? (
                      <li
                        ref={sentinelRef}
                        className="flex items-center justify-center gap-1.5 px-3 py-2 text-[10px] text-ink-500"
                      >
                        {loadingOptions ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading more…
                          </>
                        ) : (
                          <span>Scroll for more</span>
                        )}
                      </li>
                    ) : options.length > 20 ? (
                      <li className="px-3 py-2 text-center text-[10px] text-ink-400">
                        End of catalog
                      </li>
                    ) : null}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {validation ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger">
              {validation}
            </p>
          ) : null}

          <footer className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-ink-700 hover:bg-ink-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-60"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}


