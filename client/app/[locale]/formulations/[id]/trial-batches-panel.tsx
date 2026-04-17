"use client";

import { Button, Modal } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import type { FormulationVersionDto } from "@/services/formulations";
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
  canWrite,
  canDelete,
}: {
  orgId: string;
  formulationId: string;
  formulationName: string;
  versions: readonly FormulationVersionDto[];
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
    <section className="mt-10 border-2 border-ink-1000 bg-ink-0 p-6 md:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-ink-1000 pb-3">
        <div>
          <h2 className="font-mono text-xs tracking-widest uppercase text-ink-700">
            {tBatches("list.title")}
          </h2>
          <p className="mt-1 font-mono text-[10px] tracking-widest uppercase text-ink-500">
            {tBatches("list.subtitle")}
          </p>
        </div>
        {canWrite ? (
          <NewTrialBatchButton
            orgId={orgId}
            formulationId={formulationId}
            formulationName={formulationName}
            versions={versions}
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
          className="mt-4 border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
        >
          {deleteError}
        </p>
      ) : null}

      {batchesQuery.isLoading ? (
        <p className="mt-6 font-mono text-[10px] tracking-widest uppercase text-ink-500">
          {tBatches("list.loading")}
        </p>
      ) : batches.length === 0 ? (
        <p className="mt-6 text-sm text-ink-600">
          {tBatches("list.empty")}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-ink-200">
          {batches.map((batch) => (
            <li
              key={batch.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="flex flex-col gap-1">
                <Link
                  href={`/formulations/${formulationId}/trial-batches/${batch.id}`}
                  className="font-bold tracking-tight text-ink-1000 underline-offset-4 hover:underline"
                >
                  {batch.label || tBatches("list.untitled")}
                </Link>
                <span className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                  v{batch.formulation_version_number} ·{" "}
                  {formatInteger(batch.batch_size_units)}{" "}
                  {tBatches("list.packs")} ·{" "}
                  {tBatches("list.created_by", {
                    name: batch.created_by_name,
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href={`/formulations/${formulationId}/trial-batches/${batch.id}`}
                  className="inline-flex items-center justify-center rounded-none border-2 border-ink-1000 bg-ink-0 px-3 py-1 text-xs font-bold tracking-wider uppercase text-ink-1000 transition-colors hover:bg-ink-100"
                >
                  {tBatches("list.view_bom")}
                </Link>
                {canDelete ? (
                  <button
                    type="button"
                    onClick={() => handleDelete(batch.id)}
                    disabled={deleteMutation.isPending}
                    className="font-mono text-[10px] tracking-widest uppercase text-danger hover:underline disabled:opacity-50"
                  >
                    {tBatches("list.delete")}
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
  onCreated,
}: {
  orgId: string;
  formulationId: string;
  formulationName: string;
  versions: readonly FormulationVersionDto[];
  onCreated: (batchId: string) => void;
}) {
  const tBatches = useTranslations("trial_batches");
  const tErrors = useTranslations("errors");

  const [isOpen, setIsOpen] = useState(false);
  const [versionId, setVersionId] = useState<string>("");
  const [label, setLabel] = useState("");
  const [batchSize, setBatchSize] = useState<string>("");
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
      setVersionId(versions[0]!.id);
    }
  }, [versions, versionId]);

  const createMutation = useCreateTrialBatch(orgId, formulationId);

  const reset = () => {
    // The sync effect above handles re-seeding ``versionId`` against
    // the latest ``versions`` prop. Here we only need to clear the
    // free-text fields so a previously-typed batch size / label does
    // not leak into the next batch creation.
    setLabel("");
    setBatchSize("");
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
        className="rounded-none border-2 font-bold tracking-wider uppercase"
        isDisabled
      >
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
          variant="outline"
          size="sm"
          className="rounded-none border-2 font-bold tracking-wider uppercase"
        >
          {tBatches("create.trigger")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="border-2 border-ink-1000 bg-ink-0 p-0">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b-2 border-ink-1000 px-6 py-4">
                <Modal.Heading className="font-mono text-xs tracking-widest uppercase text-ink-700">
                  {tBatches("create.title", { formulation: formulationName })}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-5 px-6 py-6">
                <p className="text-sm text-ink-600">
                  {tBatches("create.subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tBatches("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    className="w-full cursor-pointer border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number}
                        {v.label ? ` — ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tBatches("create.batch_size")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={batchSize}
                    onChange={(e) => setBatchSize(e.target.value)}
                    placeholder="10000"
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                  <span className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                    {tBatches("create.batch_size_hint")}
                  </span>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tBatches("create.label")}
                  </span>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={tBatches("create.label_placeholder")}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tBatches("create.notes")}
                  </span>
                  <textarea
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

                {error ? (
                  <p
                    role="alert"
                    className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t-2 border-ink-1000 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="rounded-none border-2 font-bold tracking-wider uppercase"
                  onClick={close}
                  isDisabled={createMutation.isPending}
                >
                  {tBatches("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-none font-bold tracking-wider uppercase"
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
