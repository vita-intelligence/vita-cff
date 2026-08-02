"use client";

/**
 * Puck-based visual page builder.
 *
 * Wraps ``<Puck>`` with our block library (see ``./config``) and
 * exposes a Save button hooked into the caller's save handler.
 * The editor is a full-height layout on its own — mount it inside
 * a route that owns the whole viewport, not a card on a stack.
 */

import { useCallback, useMemo, useState } from "react";
import { Puck } from "@puckeditor/core";
import "@puckeditor/core/puck.css";

import { pageBuilderConfig, pageBuilderStarter } from "./config";


interface Props {
  //: JSON blob loaded from the server. ``null`` means the SKU has
  //: never been authored in the page builder — we hydrate from the
  //: starter template so the canvas isn't a scary void.
  readonly initialData: unknown | null;
  readonly onSave: (data: unknown) => Promise<void>;
  //: Rendered above the toolbar so authors know which SKU they're
  //: editing without leaving the builder.
  readonly title?: string;
  readonly disabled?: boolean;
}


export function PageBuilderEditor({
  initialData,
  onSave,
  title,
  disabled = false,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seededData = useMemo(() => {
    if (initialData && typeof initialData === "object") {
      return initialData as Parameters<typeof Puck>[0]["data"];
    }
    return pageBuilderStarter as unknown as Parameters<
      typeof Puck
    >[0]["data"];
  }, [initialData]);

  const handlePublish = useCallback(
    async (data: unknown) => {
      setError(null);
      setSaving(true);
      try {
        await onSave(data);
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : "Something went wrong saving the page.",
        );
      } finally {
        setSaving(false);
      }
    },
    [onSave],
  );

  return (
    <div className="page-builder-shell">
      <Puck
        config={pageBuilderConfig}
        data={seededData}
        onPublish={handlePublish}
        // Puck emits a "publish" button in its own header; we
        // customise the header renderActions so the button shows
        // save state + the SKU title.
        headerTitle={title || "Product page"}
      />
      {saving ? (
        <div className="page-builder-toast">Saving…</div>
      ) : null}
      {error ? (
        <div className="page-builder-toast page-builder-toast-error">
          {error}
        </div>
      ) : null}
      {disabled ? (
        <div className="page-builder-shield" aria-hidden />
      ) : null}
    </div>
  );
}
