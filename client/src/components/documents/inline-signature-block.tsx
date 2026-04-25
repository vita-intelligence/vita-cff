"use client";

/**
 * Inline signature block rendered at the foot of a contract or spec
 * sheet. Replaces the old modal-based capture — the client signs
 * right on the document they're reading, so there's no context
 * switch and no "did they actually see what they signed?" doubt.
 *
 * Three states drive the UI:
 *
 * 1. ``idle``   — pad visible, waiting for strokes.
 * 2. ``drawing`` — pad has ink, Sign button enabled.
 * 3. ``signed`` — image + timestamp rendered, Resign available.
 *
 * ``onSign`` is invoked with the captured data URL and owns the
 * network call; this component only drives the capture UX and busy
 * state.
 */

import { useRef, useState } from "react";

import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/ui/signature-pad";


interface Props {
  readonly title: string;
  readonly hint?: string;
  readonly signedLabel?: string;
  readonly signedOnLabel?: (iso: string) => string;
  readonly signBtnLabel: string;
  readonly resignBtnLabel: string;
  readonly clearBtnLabel: string;
  readonly busy?: boolean;
  readonly errorMessage?: string | null;
  /** Existing signature — when provided, the component starts in the
   *  ``signed`` state and surfaces the captured artwork. ``null`` or
   *  missing skips straight to the pad. */
  readonly capturedImage?: string | null;
  readonly capturedAt?: string | null;
  readonly capturedName?: string | null;
  /** Hide the Resign button — for documents already pushed past the
   *  signing window (e.g. accepted bundles). */
  readonly locked?: boolean;
  readonly onSign: (dataUrl: string) => Promise<void> | void;
}


export function InlineSignatureBlock({
  title,
  hint,
  signedLabel,
  signedOnLabel,
  signBtnLabel,
  resignBtnLabel,
  clearBtnLabel,
  busy = false,
  errorMessage = null,
  capturedImage,
  capturedAt,
  capturedName,
  locked = false,
  onSign,
}: Props) {
  const padRef = useRef<SignaturePadHandle | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  //: When a signature is already on file, the pad stays collapsed
  //: behind the captured artwork. ``editing`` flips when the user
  //: clicks Resign so they can redraw in place.
  const [editing, setEditing] = useState(false);

  const isSigned = Boolean(capturedImage) && !editing;

  const handleConfirm = async () => {
    if (!dataUrl) return;
    await onSign(dataUrl);
    setEditing(false);
    padRef.current?.clear();
    setDataUrl(null);
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-ink-200 bg-ink-0 p-5 print:border-ink-400 print:p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-wide text-ink-1000">
          {title}
        </h3>
        {isSigned && capturedAt && signedLabel ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1 text-xs font-medium text-success ring-1 ring-inset ring-success/30 print:bg-transparent print:ring-0">
            {signedLabel}
          </span>
        ) : null}
      </header>

      {isSigned ? (
        <div className="flex flex-col gap-2">
          <div className="rounded-xl bg-ink-50 p-3 ring-1 ring-inset ring-ink-200 print:bg-transparent print:p-1 print:ring-0">
            <img
              src={capturedImage!}
              alt={title}
              className="max-h-40 w-full object-contain"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600">
            <div className="flex flex-col gap-0.5">
              {capturedName ? (
                <span className="font-medium text-ink-1000">
                  {capturedName}
                </span>
              ) : null}
              {capturedAt && signedOnLabel ? (
                <span>{signedOnLabel(capturedAt)}</span>
              ) : null}
            </div>
            {!locked ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex h-9 items-center rounded-lg px-3 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50 print:hidden"
                disabled={busy}
              >
                {resignBtnLabel}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {hint ? <p className="text-xs text-ink-500">{hint}</p> : null}
          <SignaturePad
            ref={padRef}
            onChange={setDataUrl}
            ariaLabel={title}
            disabled={busy || locked}
          />
          {errorMessage ? (
            <p
              role="alert"
              className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
            >
              {errorMessage}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 print:hidden">
            <button
              type="button"
              onClick={() => {
                padRef.current?.clear();
                setDataUrl(null);
              }}
              disabled={busy || !dataUrl}
              className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {clearBtnLabel}
            </button>
            {capturedImage && editing ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  padRef.current?.clear();
                  setDataUrl(null);
                }}
                disabled={busy}
                className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-ink-600 hover:bg-ink-50"
              >
                {clearBtnLabel}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy || !dataUrl || locked}
              className="inline-flex h-10 items-center rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {signBtnLabel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
