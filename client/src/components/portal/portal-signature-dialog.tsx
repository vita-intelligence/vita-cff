"use client";

/**
 * Brutalist port of :component:`SignatureDialog`.
 *
 * Identical functionality (open → draw → confirm or cancel,
 * confirm button disabled until something has been drawn) so the
 * customer signing flow on the portal works exactly like the
 * staff director-approval flow — only the visual treatment
 * changes:
 *
 * * Full-screen dimmed backdrop (``bg-black/40``) — same as the
 *   staff modal — keeps the surface focused on the signature.
 * * White card with a hard 2px black border + 6/6 offset shadow,
 *   matching every other portal card.
 * * Brutalist buttons via :component:`PortalButton` — black
 *   solid for the confirm action, outlined secondary for cancel.
 * * The :component:`SignaturePad` itself is reused as-is; the
 *   canvas widget is style-neutral.
 *
 * Why a separate component rather than restyling the shared
 * dialog: the staff app's :component:`SignatureDialog` is used
 * by the director-approval flow with HeroUI's modal + branded
 * buttons. Changing it would push portal styling into the staff
 * surface. Cleaner to fork.
 */

import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  PortalButton,
} from "@/components/portal/brutalist";
import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/ui/signature-pad";


interface Props {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly errorMessage?: string | null;
  readonly padLabel?: string;
  readonly extraContent?: ReactNode;
  /** External "can confirm" gate. When provided and ``false``,
   *  the confirm button stays disabled even after a signature
   *  has been drawn. The staff sister component uses this for
   *  the pricing-then-sign director flow; the portal proposal
   *  flow has no equivalent constraint but the prop stays in
   *  the interface for parity. */
  readonly canConfirm?: boolean;
  readonly onConfirm: (dataUrl: string) => Promise<void> | void;
}


export function PortalSignatureDialog({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  errorMessage = null,
  padLabel,
  extraContent,
  canConfirm = true,
  onConfirm,
}: Props) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [signature, setSignature] = useState<string | null>(null);

  // Reset the drawn signature whenever the dialog opens fresh —
  // a customer who closed and re-opened the dialog shouldn't see
  // their previous attempt still on the canvas.
  useEffect(() => {
    if (isOpen) {
      setSignature(null);
      padRef.current?.clear();
    }
  }, [isOpen]);

  // Esc closes — same as the staff modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, busy, onOpenChange]);

  if (!isOpen) return null;

  const canSubmit = Boolean(signature) && canConfirm && !busy;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!signature || !canSubmit) return;
    await onConfirm(signature);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        // Click on backdrop closes — but only when we're not in
        // the middle of submitting (avoids losing a signature
        // mid-network-call).
        if (e.target === e.currentTarget && !busy) {
          onOpenChange(false);
        }
      }}
    >
      <div className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden border-2 border-black bg-white shadow-[6px_6px_0_#000]">
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b-2 border-black px-6 py-4">
          <div className="min-w-0 flex flex-col gap-1">
            <h2 className="text-lg font-black uppercase tracking-tight">
              {title}
            </h2>
            {subtitle ? (
              <p className="text-sm leading-snug">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => !busy && onOpenChange(false)}
            aria-label="Close"
            className="shrink-0 border-2 border-black bg-white p-1.5 hover:bg-neutral-100 disabled:opacity-50"
            disabled={busy}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Body */}
        <form
          onSubmit={onSubmit}
          className="flex flex-1 flex-col gap-4 overflow-y-auto p-6"
        >
          {extraContent}

          <div>
            {padLabel ? (
              <span className="mb-2 block text-xs font-bold uppercase tracking-widest">
                {padLabel}
              </span>
            ) : null}
            <div className="border-2 border-black bg-white">
              <SignaturePad
                ref={padRef}
                onChange={setSignature}
                ariaLabel={padLabel || title}
              />
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  padRef.current?.clear();
                  setSignature(null);
                }}
                className="text-[11px] font-bold uppercase tracking-widest underline opacity-60 hover:opacity-100"
              >
                Clear
              </button>
            </div>
          </div>

          {errorMessage ? (
            <div className="border-2 border-black bg-yellow-200 px-4 py-3 text-sm font-bold uppercase tracking-wide">
              {errorMessage}
            </div>
          ) : null}

          {/* Footer */}
          <footer className="flex flex-col-reverse gap-3 border-t-2 border-black pt-4 sm:flex-row sm:justify-end">
            <PortalButton
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              {cancelLabel}
            </PortalButton>
            <PortalButton type="submit" disabled={!canSubmit}>
              {busy ? "Submitting…" : confirmLabel}
            </PortalButton>
          </footer>
        </form>
      </div>
    </div>
  );
}
