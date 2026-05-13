"use client";

import { Button, Modal } from "@heroui/react";
import { Copy, Loader2, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useDebouncedValue } from "@/lib/utils";
import {
  useCloneFormulation,
  useInfiniteFormulations,
  type FormulationDto,
} from "@/services/formulations";


type CloneMode = "new" | "replace";


/**
 * "Duplicate" modal opened from the builder header.
 *
 * Two modes share a single drawer:
 *
 * * **New project** — user supplies a unique code + name; the backend
 *   creates a fresh ``Formulation`` row carrying the source's recipe.
 *
 * * **Replace existing project** — user picks any other project in
 *   the org; the backend auto-snapshots the target into a new
 *   version, then overwrites its recipe with the source's. The
 *   project's identity (code, name, status, owner, history) stays
 *   intact so the user can undo via the version drawer.
 *
 * The picker reads from the same paginated ``useInfiniteFormulations``
 * the projects list uses, with a debounced search input. Results
 * exclude the source itself so a user cannot accidentally pick the
 * formulation they are duplicating from.
 */
export function DuplicateFormulationModal({
  orgId,
  source,
  trigger,
}: {
  orgId: string;
  source: FormulationDto;
  trigger: React.ReactNode;
}) {
  const tFormulations = useTranslations("formulations");
  const tErrors = useTranslations("errors");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const cloneMutation = useCloneFormulation(orgId, source.id);

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<CloneMode>("new");

  // "new" mode state
  const defaultNewName = useMemo(
    () =>
      [source.name, tFormulations("duplicate.new_name_suffix")]
        .filter((part) => part)
        .join(" "),
    [source.name, tFormulations],
  );
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState(defaultNewName);

  // "replace" mode state
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Reset every transient field when the modal closes so the next
  // open isn't preloaded with the last attempt's state.
  const reset = () => {
    setMode("new");
    setNewCode("");
    setNewName(defaultNewName);
    setSearch("");
    setTargetId(null);
    setConfirmed(false);
    setError(null);
  };

  useEffect(() => {
    if (!isOpen) {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, defaultNewName]);

  const replaceQuery = useInfiniteFormulations(orgId, {
    ordering: "name",
    pageSize: 25,
    search: debouncedSearch,
  });
  const replaceResults = useMemo(
    () =>
      (replaceQuery.data?.pages.flatMap((page) => [...page.results]) ?? [])
        // Never let the user "replace the source with itself" — the
        // backend rejects this with CloneTargetIsSource but filtering
        // it out client-side keeps the picker from showing a row that
        // would always fail validation on submit.
        .filter((item) => item.id !== source.id),
    [replaceQuery.data, source.id],
  );

  const selectedTarget = useMemo(
    () => replaceResults.find((item) => item.id === targetId) ?? null,
    [replaceResults, targetId],
  );

  // Disable the submit button until the active mode's inputs are
  // valid — keeps the user from firing a request that the server
  // will reject for missing fields.
  const submitDisabled = (() => {
    if (cloneMutation.isPending) return true;
    if (mode === "new") {
      return !newCode.trim() || !newName.trim();
    }
    return !targetId || !confirmed;
  })();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      let result: FormulationDto;
      if (mode === "new") {
        result = await cloneMutation.mutateAsync({
          mode: "new",
          code: newCode.trim(),
          name: newName.trim(),
        });
      } else {
        if (!targetId) return;
        result = await cloneMutation.mutateAsync({
          mode: "replace",
          target_formulation_id: targetId,
        });
      }
      setIsOpen(false);
      router.push(`/formulations/${result.id}`);
    } catch (err) {
      setError(extractCloneError(err, tErrors, tFormulations));
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={setIsOpen}>
      <Modal.Trigger>{trigger}</Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="flex max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form
              onSubmit={handleSubmit}
              className="flex min-h-0 flex-1 flex-col"
            >
              <Modal.Header className="flex flex-col gap-1 border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tFormulations("duplicate.title")}
                </Modal.Heading>
                <p className="text-xs leading-snug text-ink-500">
                  {tFormulations("duplicate.subtitle")}
                </p>
              </Modal.Header>
              <Modal.Body className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
                {/* Mode toggle */}
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-xs font-medium text-ink-700">
                    {tFormulations("duplicate.mode_label")}
                  </legend>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                    <ModeRadio
                      label={tFormulations("duplicate.mode_new")}
                      hint={tFormulations("duplicate.mode_new_hint")}
                      checked={mode === "new"}
                      onSelect={() => setMode("new")}
                    />
                    <ModeRadio
                      label={tFormulations("duplicate.mode_replace")}
                      hint={tFormulations("duplicate.mode_replace_hint")}
                      checked={mode === "replace"}
                      onSelect={() => setMode("replace")}
                    />
                  </div>
                </fieldset>

                {mode === "new" ? (
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-ink-700">
                        {tFormulations("duplicate.new_code_label")}
                      </span>
                      <input
                        required
                        value={newCode}
                        onChange={(event) => setNewCode(event.target.value)}
                        placeholder={tFormulations(
                          "duplicate.new_code_placeholder",
                        )}
                        maxLength={64}
                        className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                      />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-ink-700">
                        {tFormulations("duplicate.new_name_label")}
                      </span>
                      <input
                        required
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                      />
                    </label>
                  </div>
                ) : (
                  <ReplacePicker
                    search={search}
                    onSearch={setSearch}
                    isLoading={replaceQuery.isFetching}
                    results={replaceResults}
                    selectedId={targetId}
                    onSelect={(id) => {
                      setTargetId(id);
                      // Picking a fresh target wipes the prior
                      // confirmation — the user must re-acknowledge
                      // the destructive action against the new pick.
                      setConfirmed(false);
                    }}
                    selected={selectedTarget}
                    onConfirm={setConfirmed}
                    confirmed={confirmed}
                    tFormulations={tFormulations}
                  />
                )}

                {error ? (
                  <p
                    role="alert"
                    className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={() => setIsOpen(false)}
                  isDisabled={cloneMutation.isPending}
                >
                  {tFormulations("duplicate.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="gap-1.5 rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={submitDisabled}
                >
                  {cloneMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {mode === "new"
                    ? tFormulations("duplicate.submit_new")
                    : tFormulations("duplicate.submit_replace")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function ModeRadio({
  label,
  hint,
  checked,
  onSelect,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={checked}
      className={`flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition-colors ${
        checked
          ? "border-orange-300 bg-orange-50 text-ink-1000 ring-2 ring-orange-200"
          : "border-ink-200 bg-ink-0 text-ink-700 hover:bg-ink-50"
      }`}
    >
      <span className="text-sm font-medium">{label}</span>
      <span className="text-[11px] leading-snug text-ink-500">{hint}</span>
    </button>
  );
}


function ReplacePicker({
  search,
  onSearch,
  isLoading,
  results,
  selectedId,
  onSelect,
  selected,
  confirmed,
  onConfirm,
  tFormulations,
}: {
  search: string;
  onSearch: (value: string) => void;
  isLoading: boolean;
  results: readonly FormulationDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  selected: FormulationDto | null;
  confirmed: boolean;
  onConfirm: (value: boolean) => void;
  tFormulations: ReturnType<typeof useTranslations<"formulations">>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <span className="text-xs font-medium text-ink-700">
        {tFormulations("duplicate.replace_picker_label")}
      </span>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={tFormulations("duplicate.replace_search_placeholder")}
          className="h-10 w-full rounded-xl bg-ink-0 pl-9 pr-3 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-orange-300"
        />
      </div>

      <div className="max-h-56 overflow-y-auto rounded-xl bg-ink-0 ring-1 ring-inset ring-ink-200">
        {isLoading && results.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-500">
            {tFormulations("duplicate.replace_loading")}
          </p>
        ) : results.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-500">
            {tFormulations("duplicate.replace_no_matches")}
          </p>
        ) : (
          <ul>
            {results.map((item) => {
              const isSelected = item.id === selectedId;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={`flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left text-sm transition-colors ${
                      isSelected
                        ? "bg-orange-50 text-ink-1000"
                        : "text-ink-700 hover:bg-ink-50"
                    }`}
                  >
                    <span className="font-medium">{item.name}</span>
                    {item.code ? (
                      <span className="text-[11px] text-ink-500">
                        {item.code}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected ? (
        <div className="flex flex-col gap-3 rounded-xl bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
          <p className="text-xs leading-snug text-amber-900">
            {tFormulations("duplicate.replace_warning")}
          </p>
          <label className="flex items-start gap-2 text-xs text-amber-900">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => onConfirm(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-amber-300 text-amber-600 focus:ring-amber-400"
            />
            <span>
              {tFormulations("duplicate.replace_confirm")}
              {" — "}
              <strong>{selected.name}</strong>
              {selected.code ? ` (${selected.code})` : ""}
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}


/**
 * Map ApiError field-error codes to translated copy.
 *
 * Handled codes (server-emitted): ``clone_target_required``,
 * ``clone_target_not_found``, ``clone_target_is_source``,
 * ``invalid_clone_mode``, ``formulation_code_required``,
 * ``formulation_code_conflict``. Anything else falls back to the
 * modal's generic copy.
 */
function extractCloneError(
  err: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
  tFormulations: ReturnType<typeof useTranslations<"formulations">>,
): string {
  if (err instanceof ApiError) {
    const fields = err.fieldErrors;
    for (const key of Object.keys(fields)) {
      const value = fields[key];
      const code = Array.isArray(value) && value.length > 0 ? String(value[0]) : "";
      if (code) return translateCode(tErrors, code);
    }
  }
  return tFormulations("duplicate.error_generic");
}
