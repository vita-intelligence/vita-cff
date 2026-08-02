"use client";

/**
 * Puck custom-field wrapper around our TipTap ``RichTextEditor``.
 *
 * Puck lets you plug any React component into a field slot via
 * ``type: "custom"``. This wrapper adapts the editor's ``value /
 * onChange (html: string)`` API onto Puck's ``value / onChange
 * (value: T)`` field API. Every Text-style block that wants inline
 * rich formatting registers this component instead of a plain
 * textarea.
 *
 * The generic type is loose (``any``) because Puck's field render
 * signature is intentionally untyped — Puck's own field components
 * (text, textarea, number) all take the same shape.
 */

import { RichTextEditor } from "@/components/forms/rich-text-editor";


// Puck calls this with ``{ name, field, value, onChange, id,
// readOnly }`` — we only need value + onChange + readOnly. The
// component is cast to ``any`` at the config site because Puck's
// custom-render generic wants a ``children`` prop even though it
// doesn't pass one.
interface RichTextFieldProps {
  readonly value?: unknown;
  readonly onChange: (value: string) => void;
  readonly readOnly?: boolean;
}

export function RichTextField({
  value,
  onChange,
  readOnly,
}: RichTextFieldProps) {
  const html = typeof value === "string" ? value : "";
  return (
    <div className="pb-rich-field">
      <RichTextEditor
        value={html}
        onChange={onChange}
        disabled={readOnly}
        placeholder="Type here…"
        minHeight="12rem"
      />
    </div>
  );
}
