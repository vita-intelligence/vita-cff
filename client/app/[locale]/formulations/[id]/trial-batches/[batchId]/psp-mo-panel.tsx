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
  ChevronRight,
  ClipboardCheck,
  ExternalLink,
  FlaskConical,
  Layers,
  Loader2,
  Package,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useTranslations } from "next-intl";
import {
  useCreateTrialBatchPspMo,
  useTrialBatchPspMoBookings,
  useTrialBatchPspMoChain,
  type PspTrialMoChainNodeDto,
  type TrialBatchDto,
} from "@/services/trial_batches";
import { usePspRndWarehouses } from "@/services/psp";


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

  // Pull the chain so we know the root MO's status. If the previously
  // linked MO ended in ``cancelled``, PSP's partial unique index has
  // freed the trial-batch slot, so the scientist can re-fire Create
  // MO to spawn a fresh chain (same trial batch, new run). We show
  // the button in place of the chip in that case — the trial batch
  // is the plan, cancellation abandons only the run.
  const chainQuery = useTrialBatchPspMoChain(orgId, batch.id, {
    enabled: !!moUuid,
    refetchInterval: 20_000,
  });
  const rootStatus = chainQuery.data?.chain?.[0]?.status;
  const linkedButCancelled = !!moUuid && rootStatus === "cancelled";

  if (moUuid && !linkedButCancelled) {
    return (
      <LinkedMoChip
        orgId={orgId}
        batchId={batch.id}
        moUuid={moUuid}
        pspUiBaseUrl={pspUiBaseUrl}
      />
    );
  }

  return (
    <CreateMoButton
      orgId={orgId}
      batch={batch}
      previousCancelled={linkedButCancelled}
    />
  );
}


function CreateMoButton({
  orgId,
  batch,
  previousCancelled = false,
}: {
  orgId: string;
  batch: TrialBatchDto;
  /** True when the trial batch had an MO but it was cancelled on
   *  PSP — the button label + tooltip flip to reflect a retry rather
   *  than a first-time create. */
  previousCancelled?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const label = previousCancelled ? "Create new MO" : "Create MO on PSP";
  const title = previousCancelled
    ? "The previous MO was cancelled on PSP — click to spawn a fresh chain against the same trial batch."
    : "Create a Manufacturing Order on PSP for this trial batch";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={previousCancelled ? `${label} (previous was cancelled)` : label}
        className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-ink-0 transition-colors hover:bg-emerald-700"
      >
        <FlaskConical className="h-4 w-4" />
        {label}
        {previousCancelled ? (
          <span
            aria-hidden
            className="ml-0.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-300"
            title="Previous MO was cancelled"
          />
        ) : null}
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

  // Project_type and finished-product uuid derive from the batch +
  // formulation and are never asked:
  //   * project_type → always "trial" for trial batches
  //   * item_uuid → ``Formulation.psp_finished_product_uuid``
  //
  // Quantity is EDITABLE — defaults to ``TrialBatch.batch_size_units``
  // but the scientist commonly wants PSP to run a smaller / larger
  // size than the planned scale on this specific MO (e.g. cycle
  // slot 1 was planned at 20 units for the initial pass, but this
  // MO run should produce 10). The backend already accepts an
  // optional ``quantity`` override; we just have to surface the
  // input.
  //
  // Warehouse is per-MO too — multi-site R&D setups route different
  // trial batches to different R&D warehouses — via a dropdown
  // filtered to warehouses PSP has flagged as R&D-tagged.
  const [quantity, setQuantity] = useState<string>(
    String(batch.batch_size_units ?? 0),
  );
  // "packs" (default) = pack count, matches TrialBatch.batch_size_units
  //                     semantics for sample batches — 10 → 10 bottles.
  // "units"           = raw individual capsules/gummies. Server divides
  //                     by servings_per_pack so 5 → 0.0833 packs on PSP.
  // Toggle only surfaces on sample batches with servings_per_pack > 1;
  // trial-kind batches already count in individual units and one-per-
  // pack formulations have nothing to convert.
  const [sizeMode, setSizeMode] = useState<"packs" | "units">("packs");
  const [warehouseUuid, setWarehouseUuid] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [banner, setBanner] = useState<
    | { readonly kind: "error"; readonly message: string }
    | null
  >(null);

  const warehousesQuery = usePspRndWarehouses(orgId);
  const warehouses = warehousesQuery.data?.items ?? [];
  const warehousesLoading = warehousesQuery.isLoading;
  const noRndWarehouses =
    !warehousesLoading && warehouses.length === 0;

  // Auto-select the only option — a company with a single R&D
  // warehouse shouldn't force the scientist to open a dropdown of
  // one to pick the obvious answer.
  useEffect(() => {
    if (!warehouseUuid && warehouses.length === 1 && warehouses[0]?.uuid) {
      setWarehouseUuid(warehouses[0].uuid);
    }
  }, [warehouseUuid, warehouses]);

  const servingsPerPack = Math.max(1, batch.servings_per_pack ?? 1);
  const showUnitsToggle =
    batch.kind === "sample" && servingsPerPack > 1;
  // Dosage-form-aware nouns (server-owned mapping, exposed on the
  // TrialBatchDto). Falls back to generic "unit" / "units" for
  // legacy versions where the snapshot doesn't record a dosage
  // form. Used by the toggle label, quantity input label, helper
  // text, and preview so a powder MO reads "5 scoops", a liquid
  // MO reads "5 doses", etc. — never "5 caps" for the wrong form.
  const unitSingular = batch.unit_label_singular || "unit";
  const unitPlural = batch.unit_label_plural || "units";
  const parsedQtyLive = Number.parseInt(quantity.trim(), 10);
  const previewCapsules =
    Number.isFinite(parsedQtyLive) && parsedQtyLive > 0
      ? sizeMode === "units"
        ? parsedQtyLive
        : parsedQtyLive * servingsPerPack
      : null;
  const previewPacks =
    Number.isFinite(parsedQtyLive) && parsedQtyLive > 0
      ? sizeMode === "units"
        ? parsedQtyLive / servingsPerPack
        : parsedQtyLive
      : null;

  const createMutation = useCreateTrialBatchPspMo(orgId, batch.id);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    if (!warehouseUuid) {
      setBanner({
        kind: "error",
        message: "Pick a PSP warehouse for this MO.",
      });
      return;
    }
    const parsedQty = Number.parseInt(quantity.trim(), 10);
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      setBanner({
        kind: "error",
        message: "Quantity must be a positive whole number of finished units.",
      });
      return;
    }
    try {
      await createMutation.mutateAsync({
        quantity: parsedQty,
        // Only send size_mode when the toggle is meaningful — trial
        // batches + one-per-pack formulations pass the default
        // ("packs" ≡ passthrough) and the server ignores the field.
        size_mode: showUnitsToggle ? sizeMode : undefined,
        warehouse_uuid: warehouseUuid,
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

        {noRndWarehouses ? (
          <div className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
            No R&amp;D warehouse configured on PSP. Open a warehouse
            plan on PSP, pick a shelf, and set its{" "}
            <strong>Purpose</strong> to <em>R&amp;D</em> — one shelf is
            enough for the warehouse to show up here.
          </div>
        ) : null}

        <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label
              htmlFor="psp-mo-quantity"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-700"
            >
              <Package className="h-3 w-3 text-ink-500" />
              Quantity ({sizeMode === "units" ? `individual ${unitPlural}` : "complete packs"})
            </label>

            {showUnitsToggle ? (
              <div className="flex gap-1 rounded-lg bg-ink-100 p-0.5 text-[11px] font-medium">
                <button
                  type="button"
                  onClick={() => setSizeMode("packs")}
                  className={`flex-1 rounded-md px-2 py-1 transition-colors ${
                    sizeMode === "packs"
                      ? "bg-ink-0 text-ink-1000 shadow-sm ring-1 ring-ink-200"
                      : "text-ink-600 hover:text-ink-1000"
                  }`}
                >
                  Complete packs
                  <span className="ml-1 text-ink-500">
                    ({servingsPerPack} {servingsPerPack === 1 ? unitSingular : unitPlural}/pack)
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setSizeMode("units")}
                  className={`flex-1 rounded-md px-2 py-1 transition-colors ${
                    sizeMode === "units"
                      ? "bg-ink-0 text-ink-1000 shadow-sm ring-1 ring-ink-200"
                      : "text-ink-600 hover:text-ink-1000"
                  }`}
                >
                  Individual {unitPlural}
                  <span className="ml-1 text-ink-500">(e.g. 5 {unitPlural})</span>
                </button>
              </div>
            ) : null}

            <input
              id="psp-mo-quantity"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm tabular-nums"
            />

            <p className="text-[10px] text-ink-500">
              Defaults to the trial batch&apos;s planned scale
              ({batch.batch_size_units} units).
              {showUnitsToggle
                ? ` Switch to Individual ${unitPlural} to ship a handful of loose`
                  + ` ${unitPlural} instead of a full pack — common on cycle`
                  + " sample slots."
                : " Change to run a smaller or larger MO than the planned"
                  + " size without editing the trial batch."}
            </p>

            {showUnitsToggle && previewCapsules !== null && previewPacks !== null ? (
              <p className="rounded-lg bg-ink-50 px-3 py-1.5 text-[11px] text-ink-600 ring-1 ring-inset ring-ink-200">
                PSP will book{" "}
                <strong className="text-ink-1000 tabular-nums">
                  {previewPacks < 1
                    ? previewPacks.toFixed(4).replace(/\.?0+$/, "")
                    : previewPacks.toFixed(previewPacks % 1 === 0 ? 0 : 2)}
                </strong>{" "}
                pack{previewPacks === 1 ? "" : "s"} ={" "}
                <strong className="text-ink-1000 tabular-nums">
                  {previewCapsules}
                </strong>{" "}
                {previewCapsules === 1 ? unitSingular : unitPlural}.
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="psp-mo-warehouse"
              className="text-xs font-medium text-ink-700"
            >
              R&amp;D warehouse on PSP
            </label>
            <select
              id="psp-mo-warehouse"
              value={warehouseUuid}
              onChange={(e) => setWarehouseUuid(e.target.value)}
              required
              disabled={warehousesLoading || noRndWarehouses}
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-400"
            >
              <option value="">
                {warehousesLoading
                  ? "Loading warehouses…"
                  : noRndWarehouses
                    ? "No R&D warehouse available"
                    : "Select a warehouse…"}
              </option>
              {warehouses.map((w) => (
                <option key={w.uuid} value={w.uuid}>
                  {w.name}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-ink-500">
              Filtered to warehouses with at least one R&amp;D-tagged
              cell — trial-batch consumption + finished output land
              here, isolated from production stock.
            </p>
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
              disabled={
                createMutation.isPending ||
                noRndWarehouses ||
                warehousesLoading ||
                !warehouseUuid
              }
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
  const [chainOpen, setChainOpen] = useState(false);

  // Poll every 20s — cheap enough that scientists watching progress
  // don't have to refresh manually, quiet enough that a tab left
  // open overnight doesn't hammer PSP.
  const bookingsQuery = useTrialBatchPspMoBookings(orgId, batchId, {
    refetchInterval: 20_000,
  });

  // Chain fetch — only fires when the expander opens. Polls at the
  // same 20s cadence so the child-MO statuses stay live while the
  // scientist is watching.
  const chainQuery = useTrialBatchPspMoChain(orgId, batchId, {
    enabled: chainOpen,
    refetchInterval: chainOpen ? 20_000 : undefined,
  });

  const summary = bookingsQuery.data?.summary;
  const chain = chainQuery.data?.chain ?? [];

  const label = useMemo(() => {
    if (!summary || summary.total === 0) return "MO created";
    return `MO: ${summary.picked} / ${summary.total} picked`;
  }, [summary]);

  // Prefer the UI host when configured (dev + split-host prod). Fall
  // back to the API host in single-origin deployments.
  const pspBaseHost = useMemo(
    () => (pspUiBaseUrl || "").replace(/\/$/, ""),
    [pspUiBaseUrl],
  );
  const openHref = useMemo(() => {
    if (!pspBaseHost) return "";
    return `${pspBaseHost}/production/manufacturing-orders/${moUuid}`;
  }, [pspBaseHost, moUuid]);

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <div className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
        <ClipboardCheck className="h-4 w-4" />
        <span>{label}</span>
        <button
          type="button"
          onClick={() => setChainOpen((v) => !v)}
          title={
            chainOpen ? "Hide the stage MO chain" : "Show the stage MO chain"
          }
          className="ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-emerald-700 hover:bg-emerald-100"
        >
          <Layers className="h-3 w-3" />
          Stages
          <ChevronRight
            className={`h-3 w-3 transition-transform ${
              chainOpen ? "rotate-90" : ""
            }`}
          />
        </button>
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

      {chainOpen ? (
        <div className="w-[min(28rem,90vw)] rounded-lg border border-ink-200 bg-ink-0 p-2 text-xs shadow-sm">
          {chainQuery.isLoading && chain.length === 0 ? (
            <p className="flex items-center gap-1.5 px-2 py-3 text-ink-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading stage chain…
            </p>
          ) : chain.length === 0 ? (
            <p className="px-2 py-3 text-ink-500">
              No stage chain yet — the MO was created but hasn&apos;t booked
              a BOM yet. Refresh in a moment.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {chain.map((node) => (
                <MoChainRow
                  key={node.uuid}
                  node={node}
                  isCurrent={node.uuid === moUuid}
                  pspBaseHost={pspBaseHost}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}


function MoChainRow({
  node,
  isCurrent,
  pspBaseHost,
}: {
  node: PspTrialMoChainNodeDto;
  isCurrent: boolean;
  pspBaseHost: string;
}) {
  const href = pspBaseHost
    ? `${pspBaseHost}/production/manufacturing-orders/${node.uuid}`
    : "";

  return (
    <li
      className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 ${
        isCurrent
          ? "bg-emerald-50 ring-1 ring-inset ring-emerald-200"
          : "hover:bg-ink-50"
      }`}
      style={{ paddingLeft: `${0.5 + node.depth * 1}rem` }}
    >
      {node.depth > 0 ? (
        <span className="text-ink-400" aria-hidden>
          └
        </span>
      ) : (
        <FlaskConical className="h-3 w-3 text-emerald-600" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-ink-800">
        {node.item?.name ?? "(unnamed item)"}
      </span>
      <span
        className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${moStatusChipClass(
          node.status,
        )}`}
      >
        {node.status.replace(/_/g, " ")}
      </span>
      <span className="tabular-nums text-ink-500">{node.quantity}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-ink-500 hover:text-emerald-700"
          title="Open on PSP"
        >
          <ExternalLink className="h-3 w-3" />
        </a>
      ) : null}
    </li>
  );
}


function moStatusChipClass(status: string): string {
  switch (status) {
    case "draft":
      return "bg-ink-100 text-ink-700";
    case "prepared":
    case "approved":
      return "bg-blue-50 text-blue-700";
    case "scheduled":
      return "bg-indigo-50 text-indigo-700";
    case "in_progress":
      return "bg-amber-50 text-amber-800";
    case "completed":
      return "bg-emerald-50 text-emerald-800";
    case "cancelled":
      return "bg-danger/10 text-danger";
    default:
      return "bg-ink-100 text-ink-700";
  }
}
