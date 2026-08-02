"use client";

/**
 * Puck custom-field wrapper for colour inputs.
 *
 * Renders three things in one compact row:
 *   1. A curated swatch palette (click to pick) so authors don't
 *      have to know hex.
 *   2. The native ``<input type="color">`` for freeform picking.
 *   3. A hex text input as an escape hatch (still accepts direct
 *      typing / paste of a ``#rrggbb`` value).
 *
 * Empty string is a valid state — clears the override so CSS falls
 * back to the browser / parent default. The render helpers in
 * ``./config`` already coerce ``"" -> undefined`` when applying
 * ``color`` / ``backgroundColor`` styles.
 */

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";


// Curated brand-friendly palette. Chosen to give staff useful
// building blocks (backgrounds, text, accent) without the paralysis
// of a full colour wheel. Grouped: neutrals, warms (Vita brand),
// cools, greens, magentas.
const PALETTE: readonly string[] = [
  // Neutrals
  "#ffffff",
  "#faf8f4",
  "#f5f5f5",
  "#e6e6e6",
  "#a3a3a3",
  "#525252",
  "#262626",
  "#000000",
  // Warm / brand
  "#fff7ed",
  "#fed7aa",
  "#fb923c",
  "#ea580c",
  "#c2410c",
  "#7c2d12",
  // Cool
  "#eff6ff",
  "#bfdbfe",
  "#3b82f6",
  "#1d4ed8",
  // Green
  "#ecfdf5",
  "#a7f3d0",
  "#10b981",
  "#065f46",
  // Rose / magenta
  "#fdf2f8",
  "#f9a8d4",
  "#db2777",
  "#831843",
];


// Very forgiving hex normaliser — accepts ``#abc``, ``abc``,
// ``#aabbcc``, ``aabbcc`` and returns the ``#rrggbb`` form. Rejects
// obviously bogus input by returning ``null`` so the caller keeps
// the previous good value.
function normaliseHex(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const stripped = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (/^[0-9a-fA-F]{3}$/.test(stripped)) {
    const [r, g, b] = stripped.split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(stripped)) return `#${stripped.toLowerCase()}`;
  return null;
}


interface ColorFieldProps {
  readonly value?: unknown;
  readonly onChange: (value: string) => void;
  readonly readOnly?: boolean;
}


export function ColorField({ value, onChange, readOnly }: ColorFieldProps) {
  const initial = typeof value === "string" ? value : "";
  // Local ``text`` state so the user can type intermediate values
  // (``#f``, ``#f3``) without us bouncing them back to the last good
  // colour on every keystroke.
  const [text, setText] = useState(initial);

  useEffect(() => {
    setText(initial);
  }, [initial]);

  const pick = useCallback(
    (hex: string) => {
      setText(hex);
      onChange(hex);
    },
    [onChange],
  );

  const clear = useCallback(() => {
    setText("");
    onChange("");
  }, [onChange]);

  const commitText = useCallback(
    (raw: string) => {
      setText(raw);
      const normal = normaliseHex(raw);
      if (normal === null) return; // wait for more keystrokes
      onChange(normal);
    },
    [onChange],
  );

  // The native colour picker always returns a full ``#rrggbb``.
  const currentForPicker = normaliseHex(text) || "#c2410c";

  return (
    <div className="pb-color-field">
      <div className="pb-color-field-row">
        <label
          className="pb-color-field-swatch pb-color-field-swatch-native"
          style={{ background: text || "transparent" }}
          aria-label="Open colour picker"
        >
          <input
            type="color"
            value={currentForPicker}
            disabled={readOnly}
            onChange={(e) => pick(e.currentTarget.value)}
          />
        </label>
        <input
          type="text"
          value={text}
          placeholder="#ffffff"
          readOnly={readOnly}
          onChange={(e) => commitText(e.currentTarget.value)}
          className="pb-color-field-hex"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={clear}
          disabled={readOnly || !text}
          className="pb-color-field-clear"
          title="Clear colour (use default)"
          aria-label="Clear colour"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="pb-color-field-palette" role="listbox">
        {PALETTE.map((hex) => (
          <button
            key={hex}
            type="button"
            onClick={() => pick(hex)}
            disabled={readOnly}
            className={`pb-color-field-chip ${
              text.toLowerCase() === hex ? "is-active" : ""
            }`}
            style={{ background: hex }}
            title={hex}
            aria-label={hex}
          />
        ))}
      </div>
    </div>
  );
}
