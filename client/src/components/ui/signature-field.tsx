"use client";

/**
 * Inline signature capture for forms — a drop-in replacement for
 * the "type your name" text inputs scattered across the labelling
 * + portal workflows.
 *
 * Renders a canvas the user draws on with mouse / finger / stylus
 * and emits a base64-encoded PNG data URL. Unlike
 * :component:`SignatureDialog` (modal handshake), this one sits
 * inline next to the rest of the form fields so a reviewer
 * doesn't have to open a popover to sign.
 *
 * Parent passes ``value`` + ``onChange`` exactly like a controlled
 * input. ``value=""`` means unsigned; any non-empty string is the
 * data URL.
 */

import { useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";

import { SignaturePad, type SignaturePadHandle } from "./signature-pad";


interface Props {
  readonly label: string;
  readonly value: string;
  readonly onChange: (dataUrl: string) => void;
  /** Aria label for screen readers — defaults to ``label``. */
  readonly ariaLabel?: string;
  readonly required?: boolean;
  /** Optional. The underlying ``SignaturePad`` already ships its
   *  own ``Draw your signature above.`` caption, so a top-side
   *  hint is only useful when the calling form needs to add
   *  context the pad can't (e.g. "use your finger on touch
   *  devices"). Leave undefined for the common case. */
  readonly hint?: string;
  /** Tone the surrounding chrome — ``staff`` matches the labelling
   *  workspace cards (neutral ink ring + rounded corners),
   *  ``portal`` matches the brutalist portal style (heavy black
   *  borders + paper background). */
  readonly tone?: "staff" | "portal";
}


export function SignatureField({
  label,
  value,
  onChange,
  ariaLabel,
  required = false,
  hint,
  tone = "staff",
}: Props) {
  const padRef = useRef<SignaturePadHandle | null>(null);

  // If the parent clears ``value`` programmatically (e.g. after a
  // submit error / reset), wipe the canvas so the next stroke
  // starts from a blank slate instead of the previous drawing.
  useEffect(() => {
    if (!value) padRef.current?.clear();
  }, [value]);

  const isPortal = tone === "portal";
  const wrapperClass = isPortal
    ? "border-2 border-black bg-paper p-2"
    : "rounded-lg bg-ink-50 p-1 ring-1 ring-inset ring-ink-200";
  const labelClass = isPortal
    ? "text-xs font-bold uppercase tracking-[0.15em] text-neutral-700"
    : "block text-[10px] font-semibold uppercase tracking-wide text-ink-700";
  const hintClass = isPortal
    ? "mt-1 text-[11px] text-neutral-500"
    : "mt-0.5 text-[10px] text-ink-500";
  // Keep ``Clear`` quiet — it's a recovery action, not a CTA. Both
  // tones get a tone-on-tone text-only treatment so it doesn't
  // compete with the primary submit button visually.
  const clearClass = isPortal
    ? "inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-[0.15em] text-neutral-600 hover:text-black disabled:opacity-30 disabled:hover:text-neutral-600"
    : "inline-flex items-center gap-1 text-[10px] font-medium text-ink-500 hover:text-ink-800 disabled:opacity-30 disabled:hover:text-ink-500";

  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <label className={labelClass}>
          {label}
          {required ? <span className="ml-0.5 text-rose-600">*</span> : null}
        </label>
        <button
          type="button"
          onClick={() => {
            padRef.current?.clear();
            onChange("");
          }}
          disabled={!value}
          className={clearClass}
        >
          <RotateCcw className="h-3 w-3" /> Clear
        </button>
      </div>
      {hint ? <p className={hintClass}>{hint}</p> : null}
      <div className={`mt-1 ${wrapperClass}`}>
        <SignaturePad
          ref={padRef}
          ariaLabel={ariaLabel ?? label}
          onChange={(dataUrl) => onChange(dataUrl ?? "")}
        />
      </div>
    </div>
  );
}
