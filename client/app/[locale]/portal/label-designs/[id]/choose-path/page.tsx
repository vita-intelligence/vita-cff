"use client";

import { use, useState } from "react";
import { AlertTriangle, Ban, Check, Paintbrush, Pencil } from "lucide-react";

import {
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { PortalModal } from "@/components/portal/portal-modal";
import { useRouter } from "@/i18n/navigation";
import {
  usePortalChoosePath,
  usePortalLabelDesign,
} from "@/services/label-design";


type PathKey = "design_by_us" | "design_by_customer" | "no_label";


const PATH_LABELS: Record<PathKey, string> = {
  design_by_us: "Vita designs it for me",
  design_by_customer: "I’ll design it myself",
  no_label: "I don’t want a label",
};


export default function ChoosePathPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const choose = usePortalChoosePath(id);
  // Pull the LabelDesign so we know which project's journey page to
  // link back to. While this loads we fall back to ``/portal/products``
  // so the back button never points at a dead URL.
  const ld = usePortalLabelDesign(id);
  const projectHref = ld.data?.formulation
    ? `/portal/products/${ld.data.formulation}`
    : "/portal/products";
  // Design-fee headline for the "Vita designs" card. Zero → "Free";
  // non-zero renders as "£X" (or the org's currency).
  const feeAmount = Number.parseFloat(ld.data?.design_by_us_fee_amount || "0");
  const feeCurrency = (ld.data?.design_by_us_fee_currency || "GBP").toUpperCase();
  const hasFee = Number.isFinite(feeAmount) && feeAmount > 0;
  const feeDisplay = hasFee ? formatFee(feeAmount, feeCurrency) : "";
  const [selected, setSelected] = useState<PathKey | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!selected) return;
    setError(null);
    try {
      await choose.mutateAsync(selected);
      router.replace(`/portal/label-designs/${id}`);
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "Could not save your choice.";
      setError(detail);
      setShowConfirm(false);
    }
  };

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="LABEL DESIGN"
        title="How would you like to design the label?"
        subtitle="Pick whichever fits — you can paste our spec-derived content block into any tool, or hand the brief to our team."
        back={{ href: projectHref, label: "Back to project" }}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <PathOption
          icon={<Paintbrush className="h-7 w-7 text-black" />}
          title={PATH_LABELS.design_by_us}
          body="Fill in a short preferences form (brand colours, design style, inspirational examples) and our team will produce the artwork. You’ll review and approve the final design."
          nextStep="Next: brief us →"
          priceLabel={hasFee ? `${feeDisplay} design fee` : "No extra cost"}
          selected={selected === "design_by_us"}
          onSelect={() => setSelected("design_by_us")}
        />
        <PathOption
          icon={<Pencil className="h-7 w-7 text-black" />}
          title={PATH_LABELS.design_by_customer}
          body="Use our spec-derived content block (PDF / PNG / text) in your tool of choice — Canva, Illustrator, Figma — then upload the finished artwork for our compliance review."
          nextStep="Next: get the content block →"
          priceLabel="Free"
          selected={selected === "design_by_customer"}
          onSelect={() => setSelected("design_by_customer")}
        />
        <PathOption
          icon={<Ban className="h-7 w-7 text-black" />}
          title={PATH_LABELS.no_label}
          body="Manufacture and dispatch the product unlabelled. Suits bulk / warehouse-only orders and customers who label downstream themselves."
          nextStep="Next: closes the workflow →"
          priceLabel="Free"
          selected={selected === "no_label"}
          onSelect={() => setSelected("no_label")}
        />
      </div>

      {hasFee ? (
        <p className="mt-4 border-2 border-black bg-amber-100 p-3 text-xs">
          Picking &ldquo;{PATH_LABELS.design_by_us}&rdquo; adds a{" "}
          <span className="font-bold">{feeDisplay}</span> design invoice to your
          account. Our finance team approves it before the design work starts.
        </p>
      ) : null}

      {/* Sticky-style confirm bar at the bottom of the page. Activates
          only once a card is selected, so an accidental tap on the
          wrong card is recoverable until the user explicitly clicks
          "Confirm choice" and clears the modal. */}
      <div className="mt-6 flex flex-col gap-3 border-2 border-black bg-paper p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-600">
            Your choice
          </p>
          <p className="mt-1 text-base font-bold">
            {selected ? PATH_LABELS[selected] : "Pick an option above"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!selected) return;
            setError(null);
            setShowConfirm(true);
          }}
          disabled={!selected || choose.isPending}
          className="inline-flex items-center gap-2 border-2 border-black bg-black px-5 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white transition-all hover:bg-neutral-800 active:translate-y-px disabled:cursor-not-allowed disabled:bg-neutral-300 disabled:text-neutral-500"
        >
          <Check className="h-4 w-4" />
          Confirm choice
        </button>
      </div>

      {error ? (
        <p className="mt-4 text-sm text-red-700">{error}</p>
      ) : null}

      {showConfirm && selected ? (
        <ConfirmDialog
          choice={PATH_LABELS[selected]}
          isPending={choose.isPending}
          onCancel={() => setShowConfirm(false)}
          onConfirm={confirm}
        />
      ) : null}
    </PortalShell>
  );
}


function PathOption({
  icon,
  title,
  body,
  nextStep,
  priceLabel,
  selected,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  nextStep: string;
  priceLabel: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group text-left transition-all ${
        selected
          ? "translate-y-[-2px]"
          : "hover:translate-y-[-2px] active:translate-y-0"
      }`}
    >
      <div
        className={`relative h-full border-2 p-5 transition-all ${
          selected
            ? "border-orange-500 bg-orange-500 text-black shadow-[6px_6px_0_0_black]"
            : "border-black bg-white text-black group-hover:shadow-[6px_6px_0_0_black]"
        }`}
      >
        {selected ? (
          <span className="absolute right-3 top-3 inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-black bg-black text-white">
            <Check className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <span
          className={`inline-block border-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.15em] ${
            selected
              ? "border-black bg-white text-black"
              : "border-black bg-paper text-black"
          }`}
        >
          {priceLabel}
        </span>
        <div className="mt-3">{icon}</div>
        <h3 className="mt-3 text-lg font-bold">{title}</h3>
        <p
          className={`mt-2 text-sm ${
            selected ? "text-black/80" : "text-neutral-600"
          }`}
        >
          {body}
        </p>
        <p
          className={`mt-3 text-[11px] font-bold uppercase tracking-[0.18em] ${
            selected ? "text-black/70" : "text-neutral-500"
          }`}
        >
          {nextStep}
        </p>
      </div>
    </button>
  );
}

/** Render a decimal price with the org's currency, formatted for
 *  the en-GB locale (portal is single-locale today). Kept local so
 *  this page doesn't reach into the heavier company-format helpers
 *  for what is a single line of copy. */
function formatFee(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: (currency || "GBP").toUpperCase(),
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${(currency || "GBP").toUpperCase()} ${amount}`;
  }
}


function ConfirmDialog({
  choice,
  isPending,
  onCancel,
  onConfirm,
}: {
  choice: string;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <PortalModal
      onClose={onCancel}
      ariaLabel="Confirm label design path"
      locked={isPending}
    >
      <PortalModal.Header>
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center border-2 border-black bg-amber-300">
            <AlertTriangle className="h-5 w-5 text-black" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-700">
              Final choice
            </p>
            <h2 className="mt-1 truncate text-lg font-bold">
              Lock in &ldquo;{choice}&rdquo;?
            </h2>
          </div>
        </div>
      </PortalModal.Header>
      <PortalModal.Body>
        <p className="text-sm text-neutral-700">
          Once confirmed you can&apos;t switch design paths for this
          product. If you need to change later, our team will have to
          reopen the workflow manually.
        </p>
      </PortalModal.Body>
      <PortalModal.Footer>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            className="inline-flex items-center justify-center border-2 border-black bg-white px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-black transition-colors hover:bg-neutral-100 disabled:opacity-50"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isPending}
            className="inline-flex items-center justify-center gap-2 border-2 border-black bg-black px-4 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            {isPending ? "Saving…" : "Confirm choice"}
          </button>
        </div>
      </PortalModal.Footer>
    </PortalModal>
  );
}
