"use client";

/**
 * Puck custom-field wrapper for pixel-value inputs.
 *
 * The browser's ``<input type="number">`` refuses to hold an empty
 * string when a value is present — you can't easily clear a ``0``
 * to type a new number because the input keeps the digit while the
 * caret moves. Puck's default number field inherits this pain.
 *
 * We render a plain ``<input type="text" inputMode="numeric">``
 * instead. The value round-trips as an empty string when cleared
 * and as a number otherwise. The block render helpers
 * (``toPx`` in ``./config``) already accept either shape so the
 * canvas keeps rendering correctly during editing.
 */

import { useCallback, useEffect, useState } from "react";


interface NumberFieldProps {
  readonly value?: unknown;
  readonly onChange: (value: number | string) => void;
  readonly readOnly?: boolean;
  //: Optional minimum used only for the ``min`` HTML hint and a
  //: soft clamp on blur (we don't hard-block typing so the user
  //: can still delete every character to clear the field).
  readonly min?: number;
  //: Placeholder shown when the field is empty. Used by the
  //: responsive-padding field to hint at inherited breakpoint
  //: values (e.g. "leave blank to inherit '16' from Mobile").
  readonly placeholder?: string;
}


export function NumberField({
  value,
  onChange,
  readOnly,
  min,
  placeholder,
}: NumberFieldProps) {
  const asString =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  const [text, setText] = useState(asString);

  // Sync when the incoming value changes externally (undo,
  // programmatic edit).
  useEffect(() => {
    setText(asString);
  }, [asString]);

  const handleChange = useCallback(
    (raw: string) => {
      // Only digits and minus (for future negative padding /
      // margin support). Everything else is stripped as the user
      // types — no jarring insertion.
      const cleaned = raw.replace(/[^\d-]/g, "");
      setText(cleaned);
      if (cleaned === "" || cleaned === "-") {
        // Empty state — surfaces as ``undefined`` via the render
        // helpers so the block falls back to no padding.
        onChange("");
        return;
      }
      const n = Number(cleaned);
      if (Number.isFinite(n)) onChange(n);
    },
    [onChange],
  );

  const handleBlur = useCallback(() => {
    // Soft clamp: if a minimum is declared and the current value
    // is below it, snap up. Empty stays empty.
    if (text === "" || text === "-") return;
    const n = Number(text);
    if (!Number.isFinite(n)) return;
    if (typeof min === "number" && n < min) {
      setText(String(min));
      onChange(min);
    }
  }, [text, min, onChange]);

  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      readOnly={readOnly}
      placeholder={placeholder}
      onChange={(e) => handleChange(e.currentTarget.value)}
      onBlur={handleBlur}
      className="pb-number-field"
    />
  );
}
