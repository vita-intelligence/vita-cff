"use client";

/**
 * Puck custom-field wrapper around our TipTap ``RichTextEditor``.
 *
 * Puck's sidebar is ~320px wide — way too narrow to sensibly hold
 * TipTap's toolbar (which wraps to four rows). Instead the field
 * renders a small preview + an "Edit content" button that opens a
 * fullscreen modal where TipTap has the entire viewport to breathe.
 *
 * The modal edits an internal draft; changes commit back to Puck's
 * ``onChange`` on close (via the modal's Save action or backdrop /
 * Esc dismissal) so the block's ``html`` prop stays authoritative.
 */

import { useCallback, useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";

import { RichTextEditor } from "@/components/forms/rich-text-editor";


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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(html);

  // Keep the local draft in sync when the incoming value changes
  // externally (e.g. an undo from Puck's own history stack).
  useEffect(() => {
    setDraft(html);
  }, [html]);

  // Body scroll lock while the modal is open — Puck's own sidebar
  // otherwise scrolls behind the overlay.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const commit = useCallback(() => {
    if (draft !== html) onChange(draft);
    setOpen(false);
  }, [draft, html, onChange]);

  const cancel = useCallback(() => {
    setDraft(html);
    setOpen(false);
  }, [html]);

  // ``Esc`` closes without committing so an accidental modal open
  // never mutates the underlying value.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, cancel]);

  return (
    <>
      <div className="pb-rich-field">
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={readOnly}
          className="pb-rich-field-open"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          <span>Edit content in fullscreen</span>
        </button>
        <div
          className="pb-rich-field-preview rich-content"
          aria-hidden={html ? undefined : true}
          dangerouslySetInnerHTML={{
            __html:
              html ||
              '<p style="color:#999">No content yet. Click <strong>Edit content</strong> to write.</p>',
          }}
        />
      </div>
      {open ? (
        <div
          className="pb-rich-modal-backdrop"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            // Only dismiss when clicking the backdrop itself, not
            // a child element that happens to bubble.
            if (e.target === e.currentTarget) cancel();
          }}
        >
          <div className="pb-rich-modal">
            <header className="pb-rich-modal-header">
              <div>
                <p className="pb-rich-modal-eyebrow">Rich text block</p>
                <h2 className="pb-rich-modal-title">Edit content</h2>
              </div>
              <div className="pb-rich-modal-actions">
                <button
                  type="button"
                  onClick={cancel}
                  className="pb-rich-modal-btn pb-rich-modal-btn-ghost"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={commit}
                  className="pb-rich-modal-btn pb-rich-modal-btn-primary"
                  disabled={readOnly}
                >
                  Done
                </button>
              </div>
            </header>
            <div className="pb-rich-modal-body">
              <RichTextEditor
                value={draft}
                onChange={setDraft}
                disabled={readOnly}
                placeholder="Type here — the toolbar has room to breathe now."
                minHeight="60vh"
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
