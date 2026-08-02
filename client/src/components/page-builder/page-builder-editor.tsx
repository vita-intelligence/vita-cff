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
  //: Fired after a successful save so the parent can navigate away
  //: from the builder route. Optional — omit to stay in the editor.
  readonly onAfterSave?: () => void;
  //: Rendered above the toolbar so authors know which SKU they're
  //: editing without leaving the builder.
  readonly title?: string;
  readonly disabled?: boolean;
}


type Toast =
  | { kind: "saving" }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | null;


export function PageBuilderEditor({
  initialData,
  onSave,
  onAfterSave,
  title,
  disabled = false,
}: Props) {
  const [toast, setToast] = useState<Toast>(null);

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
      setToast({ kind: "saving" });
      try {
        await onSave(data);
        setToast({ kind: "success", message: "Page saved" });
        // Give the user a beat to see the confirmation, then bounce
        // back to whatever the parent wants (usually the RTG
        // project overview).
        window.setTimeout(() => {
          setToast(null);
          onAfterSave?.();
        }, 1200);
      } catch (e) {
        setToast({
          kind: "error",
          message:
            e instanceof Error
              ? e.message
              : "Something went wrong saving the page.",
        });
      }
    },
    [onSave, onAfterSave],
  );

  return (
    <div className="page-builder-shell">
      <Puck
        config={pageBuilderConfig}
        data={seededData}
        onPublish={handlePublish}
        headerTitle={title || "Product page"}
      />
      {toast ? (
        <div
          className={`page-builder-toast page-builder-toast-${toast.kind}`}
          role={toast.kind === "error" ? "alert" : "status"}
        >
          {toast.kind === "saving" ? (
            <>
              <span className="page-builder-toast-spinner" aria-hidden />
              Saving…
            </>
          ) : toast.kind === "success" ? (
            <>
              <span className="page-builder-toast-check" aria-hidden>
                ✓
              </span>
              {toast.message}
            </>
          ) : (
            <>
              <span className="page-builder-toast-cross" aria-hidden>
                !
              </span>
              <span>{toast.message}</span>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="page-builder-toast-dismiss"
                aria-label="Dismiss"
              >
                ×
              </button>
            </>
          )}
        </div>
      ) : null}
      {disabled ? (
        <div className="page-builder-shield" aria-hidden />
      ) : null}
    </div>
  );
}
