"use client";

import { Button, Modal } from "@heroui/react";
import { ExternalLink, FlaskConical, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import type { FormulationVersionDto } from "@/services/formulations";
import type { BatchSizeMode } from "@/services/trial_batches";
import {
  useCreateTrialBatch,
  useDeleteTrialBatch,
  useTrialBatches,
} from "@/services/trial_batches";


/**
 * Panel on the formulation detail page listing every trial batch
 * targeting any version of this formulation, with an inline "Plan
 * batch" modal. Each row links to the batch's own page where the
 * scale-up BOM lives.
 */
export function TrialBatchesPanel({
  orgId,
  formulationId,
  formulationName,
  versions,
  approvedVersionNumber,
  canWrite,
  canDelete,
}: {
  orgId: string;
  formulationId: string;
  formulationName: string;
  versions: readonly FormulationVersionDto[];
  approvedVersionNumber: number | null;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const tBatches = useTranslations("trial_batches");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const batchesQuery = useTrialBatches(orgId, formulationId);
  const deleteMutation = useDeleteTrialBatch(orgId);

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (batchId: string) => {
    if (!confirm(tBatches("list.delete_confirm"))) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(batchId);
    } catch (err) {
      setDeleteError(extractErrorMessage(err, tErrors));
    }
  };

  const batches = batchesQuery.data ?? [];

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div className="flex flex-col">
          <h2 className="text-base font-semibold text-ink-1000">
            {tBatches("list.title")}
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {tBatches("list.subtitle")}
          </p>
        </div>
        {canWrite ? (
          <NewTrialBatchButton
            orgId={orgId}
            formulationId={formulationId}
            formulationName={formulationName}
            versions={versions}
            approvedVersionNumber={approvedVersionNumber}
            onCreated={(batchId) =>
              router.push(
                `/formulations/${formulationId}/trial-batches/${batchId}`,
              )
            }
          />
        ) : null}
      </header>

      {deleteError ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {deleteError}
        </p>
      ) : null}

      {batchesQuery.isLoading ? (
        <p className="mt-6 text-sm text-ink-500">
          {tBatches("list.loading")}
        </p>
      ) : batches.length === 0 ? (
        <div className="mt-6 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
          <FlaskConical className="mx-auto h-6 w-6 text-ink-400" />
          <p className="mt-2 text-sm text-ink-500">
            {tBatches("list.empty")}
          </p>
        </div>
      ) : (
        <ul className="mt-2 divide-y divide-ink-100">
          {batches.map((batch) => (
            <li
              key={batch.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="flex flex-col gap-0.5">
                <Link
                  href={`/formulations/${formulationId}/trial-batches/${batch.id}`}
                  className="text-sm font-medium text-ink-1000 hover:text-orange-700"
                >
                  {batch.label || tBatches("list.untitled")}
                </Link>
                <span className="text-xs text-ink-500">
                  v{batch.formulation_version_number} ·{" "}
                  {formatInteger(batch.batch_size_units)}{" "}
                  {batch.batch_size_mode === "unit"
                    ? tBatches("list.units")
                    : tBatches("list.packs")}{" "}
                  ·{" "}
                  {tBatches("list.created_by", {
                    name: batch.created_by_name,
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/formulations/${formulationId}/trial-batches/${batch.id}`}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {tBatches("list.view_bom")}
                </Link>
                {canDelete ? (
                  <button
                    type="button"
                    aria-label={tBatches("list.delete")}
                    onClick={() => handleDelete(batch.id)}
                    disabled={deleteMutation.isPending}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}


function NewTrialBatchButton({
  orgId,
  formulationId,
  formulationName,
  versions,
  approvedVersionNumber,
  onCreated,
}: {
  orgId: string;
  formulationId: string;
  formulationName: string;
  versions: readonly FormulationVersionDto[];
  approvedVersionNumber: number | null;
  onCreated: (batchId: string) => void;
}) {
  const tBatches = useTranslations("trial_batches");
  const tErrors = useTranslations("errors");

  const [isOpen, setIsOpen] = useState(false);
  const [versionId, setVersionId] = useState<string>("");
  const [label, setLabel] = useState("");
  const [batchSize, setBatchSize] = useState<string>("");
  const [sizeMode, setSizeMode] = useState<BatchSizeMode>("pack");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Keep ``versionId`` valid against the async ``versions`` prop: the
  // list is empty on first render (TanStack Query hasn't resolved
  // yet), so the initial useState of "" stays stale once versions
  // arrive. Re-seed to the first version as soon as the list
  // populates, and reset to "" if the previously-picked version
  // disappears (e.g. got deleted in another tab).
  useEffect(() => {
    if (versions.length === 0) {
      if (versionId !== "") setVersionId("");
      return;
    }
    const stillValid = versions.some((v) => v.id === versionId);
    if (!stillValid) {
      // Default to the approved version if one is marked — scientists
      // rarely want to plan a batch off a draft, so the picker
      // pre-selects the known-good recipe.
      const approved = versions.find(
        (v) => v.version_number === approvedVersionNumber,
      );
      setVersionId((approved ?? versions[0]!).id);
    }
  }, [versions, versionId, approvedVersionNumber]);

  const createMutation = useCreateTrialBatch(orgId, formulationId);

  const reset = () => {
    setLabel("");
    setBatchSize("");
    setSizeMode("pack");
    setNotes("");
    setError(null);
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const sizeNum = Number.parseInt(batchSize, 10);
    if (!versionId || !Number.isFinite(sizeNum) || sizeNum <= 0) {
      setError(tBatches("create.invalid_input"));
      return;
    }
    try {
      const created = await createMutation.mutateAsync({
        formulation_version_id: versionId,
        batch_size_units: sizeNum,
        batch_size_mode: sizeMode,
        label: label.trim(),
        notes: notes.trim(),
      });
      close();
      onCreated(created.id);
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  if (versions.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-500 ring-1 ring-inset ring-ink-200"
        isDisabled
      >
        <Plus className="h-4 w-4" />
        {tBatches("create.trigger")}
      </Button>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? setIsOpen(true) : close())}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          {tBatches("create.trigger")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tBatches("create.title", { formulation: formulationName })}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tBatches("create.subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tBatches("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    {versions.map((v) => {
                      const isApproved =
                        v.version_number === approvedVersionNumber;
                      return (
                        <option key={v.id} value={v.id}>
                          {isApproved ? "✓ " : ""}v{v.version_number}
                          {v.label ? ` — ${v.label}` : ""}
                          {isApproved ? ` (${tBatches("create.approved_tag")})` : ""}
                        </option>
                      );
                    })}
                  </select>
                  {approvedVersionNumber !== null ? (
                    <span className="text-xs text-success">
                      {tBatches("create.approved_hint", {
                        version: approvedVersionNumber,
                      })}
                    </span>
                  ) : null}
                </label>

                <fieldset className="flex flex-col gap-1.5">
                  <legend className="text-xs font-medium text-ink-700">
                    {tBatches("create.batch_size_mode")}
                  </legend>
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["pack", "create.mode_pack"],
                        ["unit", "create.mode_unit"],
                      ] as const
                    ).map(([value, label]) => (
                      <label
                        key={value}
                        className={`flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors ${
                          sizeMode === value
                            ? "bg-orange-500 text-ink-0 ring-orange-500"
                            : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="batch_size_mode"
                          value={value}
                          checked={sizeMode === value}
                          onChange={() => setSizeMode(value)}
                          className="sr-only"
                        />
                        {tBatches(label)}
                      </label>
                    ))}
                  </div>
                  <span className="text-xs text-ink-500">
                    {tBatches(
                      sizeMode === "unit"
                        ? "create.mode_unit_hint"
                        : "create.mode_pack_hint",
                    )}
                  </span>
                </fieldset>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tBatches(
                      sizeMode === "unit"
                        ? "create.batch_size_unit_label"
                        : "create.batch_size",
                    )}
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={batchSize}
                    onChange={(e) => setBatchSize(e.target.value)}
                    placeholder={sizeMode === "unit" ? "10" : "10000"}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                  <span className="text-xs text-ink-500">
                    {tBatches(
                      sizeMode === "unit"
                        ? "create.batch_size_unit_hint"
                        : "create.batch_size_hint",
                    )}
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tBatches("create.label")}
                  </span>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={tBatches("create.label_placeholder")}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tBatches("create.notes")}
                  </span>
                  <textarea
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </label>

                {error ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
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
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={close}
                  isDisabled={createMutation.isPending}
                >
                  {tBatches("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={createMutation.isPending}
                >
                  {tBatches("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return String(value | 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
