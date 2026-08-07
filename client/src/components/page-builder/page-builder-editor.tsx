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
import { Maximize2, Monitor, Smartphone, Tablet } from "lucide-react";

import { pageBuilderConfig, pageBuilderStarter } from "./config";


// The set of preview widths the viewport toolbar switches between.
// ``full`` = no width cap (fills the canvas panel); everything else
// constrains the ``.page-builder-root`` wrapper via CSS attribute
// selectors in ``globals.css``. Widths mirror common device edges
// (iPhone 12 / iPad / small desktop) — close enough that authors
// can spot layout bugs without matching pixel-perfect device
// dimensions.
type Viewport = "full" | "desktop" | "tablet" | "mobile";

const VIEWPORT_META: Record<
  Viewport,
  { label: string; icon: typeof Maximize2; width: string }
> = {
  full:    { label: "Full",    icon: Maximize2,  width: "auto" },
  desktop: { label: "Desktop", icon: Monitor,    width: "1280px" },
  tablet:  { label: "Tablet",  icon: Tablet,     width: "768px" },
  mobile:  { label: "Mobile",  icon: Smartphone, width: "390px" },
};


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
  // Custom viewport toggle — Puck's built-in mobile/tablet/desktop
  // preview only exists inside the iframe canvas, which we disabled
  // to avoid a v0.22 bug that truncated tall single blocks. This
  // toggle constrains ``.page-builder-root`` via CSS instead, and
  // works with the responsive-padding container queries so blocks
  // actually re-flow when previewing narrow widths.
  const [viewport, setViewport] = useState<Viewport>("full");

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
    <div className="page-builder-shell" data-viewport={viewport}>
      <div className="page-builder-vp-toolbar" role="toolbar" aria-label="Preview viewport">
        {(Object.keys(VIEWPORT_META) as Viewport[]).map((vp) => {
          const Meta = VIEWPORT_META[vp];
          const Icon = Meta.icon;
          const isActive = viewport === vp;
          return (
            <button
              key={vp}
              type="button"
              onClick={() => setViewport(vp)}
              className="page-builder-vp-btn"
              data-active={isActive || undefined}
              aria-pressed={isActive}
              title={
                vp === "full"
                  ? "Full width (canvas edge to edge)"
                  : `Preview at ${Meta.width}`
              }
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{Meta.label}</span>
            </button>
          );
        })}
        {viewport !== "full" ? (
          <span className="page-builder-vp-hint">
            {VIEWPORT_META[viewport].width} preview — responsive padding kicks
            in via container queries.
          </span>
        ) : null}
      </div>
      <div className="page-builder-canvas-wrap">
        <Puck
          config={pageBuilderConfig}
          data={seededData}
          onPublish={handlePublish}
          headerTitle={title || "Product page"}
          // Render blocks in the same document as the editor (no
          // iframe). Puck's default iframe canvas has a subtle bug
          // where very tall single blocks (long rich-text pastes,
          // article-length paragraphs) get clipped past a few
          // thousand pixels — the iframe's height doesn't grow to
          // match content, so scrolling reveals white space instead
          // of the rest of the block. Rendering in-document lets the
          // browser's natural scroll handle any block height. The
          // trade-off (losing Puck's built-in viewport switcher) is
          // covered by the custom toolbar above.
          iframe={{ enabled: false }}
        />
      </div>
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
