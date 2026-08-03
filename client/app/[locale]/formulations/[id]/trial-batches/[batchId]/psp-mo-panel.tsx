"use client";

/**
 * PSP Manufacturing Order panel for the trial-batch detail page.
 *
 * When no MO has been created yet: renders a "Create MO on PSP"
 * button that opens a modal. The modal captures quantity (default
 * from the trial batch's ``batch_size_units``), project_type
 * (trial / sample), optional due date + notes, and posts to PSP via
 * NPD's ``POST /trial-batches/:id/create-psp-mo/`` proxy. On success
 * the batch row picks up ``psp_manufacturing_order_uuid`` and the
 * toolbar flips to the "linked MO" chip.
 *
 * When an MO IS linked: renders a chip with the MO uuid + a live
 * pick summary ("3 / 5 booked lots picked") that polls the bookings
 * endpoint every 20 seconds so scientists can watch progress from
 * NPD without opening PSP.
 */

import {
  ClipboardCheck,
  ExternalLink,
  FlaskConical,
  Loader2,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useTranslations } from "next-intl";
import {
  useCreateTrialBatchPspMo,
  useTrialBatchPspMoBookings,
  type TrialBatchDto,
} from "@/services/trial_batches";
import { usePspConfig } from "@/services/psp";


export function PspMoPanel({
  orgId,
  batch,
  pspUiBaseUrl,
}: {
  orgId: string;
  batch: TrialBatchDto;
  /** PSP's Next.js host (falls back to the API base URL). Used to
   *  build the "Open on PSP" deep link on the linked-MO chip. */
  pspUiBaseUrl: string;
}) {
  const moUuid = batch.psp_manufacturing_order_uuid;

  if (moUuid) {
    return (
      <LinkedMoChip
        orgId={orgId}
        batchId={batch.id}
        moUuid={moUuid}
        pspUiBaseUrl={pspUiBaseUrl}
      />
    );
  }

  return <CreateMoButton orgId={orgId} batch={batch} />;
}


function CreateMoButton({
  orgId,
  batch,
}: {
  orgId: string;
  batch: TrialBatchDto;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Create a Manufacturing Order on PSP for this trial batch"
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-ink-0 transition-colors hover:bg-emerald-700"
      >
        <FlaskConical className="h-4 w-4" />
        Create MO on PSP
      </button>
      {open ? (
        <CreateMoModal
          orgId={orgId}
          batch={batch}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}


type ProjectType = "trial" | "sample";


function CreateMoModal({
  orgId,
  batch,
  onClose,
}: {
  orgId: string;
  batch: TrialBatchDto;
  onClose: () => void;
}) {
  const tErrors = useTranslations("errors");
  const pspConfig = usePspConfig(orgId);

  const [quantity, setQuantity] = useState(String(batch.batch_size_units));
  const [projectType, setProjectType] = useState<ProjectType>("trial");
  const [itemUuidOverride, setItemUuidOverride] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [banner, setBanner] = useState<
    | { readonly kind: "error"; readonly message: string }
    | null
  >(null);

  const createMutation = useCreateTrialBatchPspMo(orgId, batch.id);

  const warehouseUuid = pspConfig.data?.psp_warehouse_uuid ?? "";
  const warehouseMissing = pspConfig.isSuccess && !warehouseUuid;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    const qtyInt = Number.parseInt(quantity, 10);
    if (!Number.isFinite(qtyInt) || qtyInt <= 0) {
      setBanner({
        kind: "error",
        message: "Quantity must be a positive whole number.",
      });
      return;
    }
    try {
      await createMutation.mutateAsync({
        quantity: qtyInt,
        project_type: projectType,
        item_uuid: itemUuidOverride.trim() || undefined,
        due_date: dueDate.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setBanner({
        kind: "error",
        message: extractApiErrorMessage(err, tErrors),
      });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-ink-0 p-6 shadow-xl ring-1 ring-ink-200">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink-1000">
              Create Manufacturing Order on PSP
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              Books FEFO stock against your R&amp;D pool. PSP&apos;s
              warehouse team gets the pick queue as soon as you save.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-500 hover:bg-ink-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {warehouseMissing ? (
          <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
            No PSP warehouse configured on /settings/integrations. Set
            the R&amp;D warehouse UUID there before creating an MO.
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-700">
              Quantity (finished units)
            </label>
            <input
              type="number"
              min={1}
              step={1}
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-ink-500">
              Defaults to the trial batch&apos;s size ({batch.batch_size_units}
              ). Edit if you want PSP to make fewer than the planned
              scale-up.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              Project type
            </span>
            <div className="flex gap-2">
              <label
                className={`inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset transition-colors ${
                  projectType === "trial"
                    ? "bg-emerald-500 text-ink-0 ring-emerald-500"
                    : "bg-ink-0 text-ink-600 ring-ink-200 hover:bg-ink-50"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="project_type"
                  value="trial"
                  checked={projectType === "trial"}
                  onChange={() => setProjectType("trial")}
                />
                Trial
              </label>
              <label
                className={`inline-flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset transition-colors ${
                  projectType === "sample"
                    ? "bg-emerald-500 text-ink-0 ring-emerald-500"
                    : "bg-ink-0 text-ink-600 ring-ink-200 hover:bg-ink-50"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name="project_type"
                  value="sample"
                  checked={projectType === "sample"}
                  onChange={() => setProjectType("sample")}
                />
                Sample
              </label>
            </div>
            <p className="text-[11px] text-ink-500">
              Both consume from the R&amp;D stock pool + drop to the
              R&amp;D cell configured on PSP. Sample = bench-scale
              one-offs; Trial = the standard workflow.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-700">
              PSP finished-product item UUID (optional override)
            </label>
            <input
              type="text"
              value={itemUuidOverride}
              onChange={(e) => setItemUuidOverride(e.target.value)}
              placeholder="Leave blank to use the formulation's linked item"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm font-mono"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-ink-700">
                Due date (optional)
              </label>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-ink-700">
                Notes (optional)
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. Rush job for QC re-test"
                className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
              />
            </div>
          </div>

          {banner ? (
            <p className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20">
              {banner.message}
            </p>
          ) : null}

          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={createMutation.isPending}
              className="rounded-lg px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-100 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || warehouseMissing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-ink-0 hover:bg-emerald-700 disabled:opacity-60"
            >
              {createMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              Create MO
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}


function LinkedMoChip({
  orgId,
  batchId,
  moUuid,
  pspUiBaseUrl,
}: {
  orgId: string;
  batchId: string;
  moUuid: string;
  pspUiBaseUrl: string;
}) {
  // Poll every 20s — cheap enough that scientists watching progress
  // don't have to refresh manually, quiet enough that a tab left
  // open overnight doesn't hammer PSP.
  const bookingsQuery = useTrialBatchPspMoBookings(orgId, batchId, {
    refetchInterval: 20_000,
  });

  const summary = bookingsQuery.data?.summary;

  const label = useMemo(() => {
    if (!summary || summary.total === 0) return "MO created";
    return `MO: ${summary.picked} / ${summary.total} picked`;
  }, [summary]);

  // Prefer the UI host when configured (dev + split-host prod). Fall
  // back to the API host in single-origin deployments.
  const openHref = useMemo(() => {
    const base = (pspUiBaseUrl || "").replace(/\/$/, "");
    if (!base) return "";
    return `${base}/production/manufacturing-orders/${moUuid}`;
  }, [pspUiBaseUrl, moUuid]);

  return (
    <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
      <ClipboardCheck className="h-4 w-4" />
      <span>{label}</span>
      {openHref ? (
        <a
          href={openHref}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-1 inline-flex items-center gap-0.5 text-emerald-700 underline decoration-dotted underline-offset-2 hover:text-emerald-900"
        >
          Open on PSP <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </div>
  );
}
