"use client";

import { Button, Modal } from "@heroui/react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useCreateValidation } from "@/services/product_validation";
import type { ProductValidationDto } from "@/services/product_validation";
import { useTrialBatches } from "@/services/trial_batches";


/**
 * Create a new :class:`ProductValidation` from the QC tab.
 *
 * The QC tab is the canonical home for validations, so the creation
 * flow lives here rather than buried on a batch detail page. Because
 * ``ProductValidation`` is a one-to-one against ``TrialBatch``, we
 * fetch the batch list for this formulation and offer a picker that
 * hides batches already bound to a validation — no silent 400s.
 *
 * Only a valid batch selection triggers the create call; the
 * disabled/empty state surfaces a dedicated hint pointing the
 * scientist to the Trial Batches tab rather than leaving them
 * staring at an inert button.
 */
export function NewValidationButton({
  orgId,
  formulationId,
  validations,
}: {
  orgId: string;
  formulationId: string;
  validations: readonly ProductValidationDto[];
}) {
  const tV = useTranslations("product_validation");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [batchId, setBatchId] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const batchesQuery = useTrialBatches(orgId, formulationId);
  const createMutation = useCreateValidation(orgId);

  // One validation per batch on the backend — filter those already
  // taken client-side so the dropdown only shows batches the create
  // call can actually accept.
  const availableBatches = useMemo(() => {
    const taken = new Set(validations.map((v) => v.trial_batch_id));
    return (batchesQuery.data ?? []).filter((b) => !taken.has(b.id));
  }, [batchesQuery.data, validations]);

  // Keep ``batchId`` valid against the async batches prop. Re-seed
  // to the first available batch as soon as the list populates;
  // reset to "" if the prior pick disappears (e.g. another tab just
  // kicked off a validation against it).
  useEffect(() => {
    if (availableBatches.length === 0) {
      if (batchId !== "") setBatchId("");
      return;
    }
    const stillValid = availableBatches.some((b) => b.id === batchId);
    if (!stillValid) {
      setBatchId(availableBatches[0]!.id);
    }
  }, [availableBatches, batchId]);

  const reset = () => {
    setBatchId("");
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
    if (!batchId) {
      setError(tV("create.generic_error"));
      return;
    }
    try {
      const created = await createMutation.mutateAsync({
        trial_batch_id: batchId,
        notes: notes.trim(),
      });
      close();
      // Drop the scientist straight into the new validation's
      // editor so they can start filling tests immediately — the
      // create button isn't the end of the flow, it's the start.
      router.push(
        `/formulations/${formulationId}/trial-batches/${batchId}/validation/${created.id}`,
      );
    } catch (err) {
      setError(extractErrorMessage(err, tV, tErrors));
    }
  };

  // Loading state: render a muted trigger so the header's layout
  // doesn't jump when the query resolves. Empty/no-batches state:
  // surface a clear CTA toward the Trial Batches tab.
  if (batchesQuery.isLoading) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-400 ring-1 ring-inset ring-ink-200"
        isDisabled
      >
        <Plus className="h-4 w-4" />
        {tV("create.trigger")}
      </Button>
    );
  }

  if (availableBatches.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-500 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        onClick={() =>
          router.push(`/formulations/${formulationId}/trial-batches`)
        }
      >
        <Plus className="h-4 w-4" />
        {tV("create.no_batches_cta")}
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
          {tV("create.trigger")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tV("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">{tV("create.subtitle")}</p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tV("create.batch_label")}
                  </span>
                  <select
                    value={batchId}
                    onChange={(e) => setBatchId(e.target.value)}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  >
                    {availableBatches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label || tV("untitled_batch")}
                        {` — v${b.formulation_version_number}`}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tV("create.notes_label")}
                  </span>
                  <textarea
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={tV("create.notes_placeholder")}
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
                  {tV("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={createMutation.isPending}
                >
                  {tV("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


/**
 * Translate backend error codes into locale copy. Mirrors the
 * pattern from ``new-formulation-button.tsx`` — DRF field errors
 * arrive on ``fieldErrors.detail[0]`` and we prefer the localised
 * version when we have one, falling back to a generic message.
 */
function extractErrorMessage(
  err: unknown,
  tV: ReturnType<typeof useTranslations<"product_validation">>,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (err instanceof ApiError) {
    const detail = err.fieldErrors.detail;
    const first =
      Array.isArray(detail) && detail.length > 0 ? String(detail[0]) : "";
    if (first) return translateCode(tErrors, first);
  }
  return tV("create.generic_error");
}
