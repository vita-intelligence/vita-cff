"use client";

/**
 * Bottom-right docked stack of floating chat windows.
 *
 * Multiple panels can be open at once (VK-style). On wide screens
 * they sit side-by-side along the bottom edge. When the count
 * exceeds the viewport width, the row becomes horizontally scrollable
 * so an enthusiast user with 6 chats open can still reach the
 * oldest one. On narrow viewports (<640px) the layout collapses to
 * a single full-width panel showing only the most-recently-opened
 * window — stacking three 340px panels on mobile would push the
 * primary surface off-screen.
 *
 * Mounted once at the app shell so it persists across route
 * navigation — the user can be reading a project, open a spec-sheet
 * chat in the dock, then navigate to a different project without
 * losing the dock state.
 */

import { useEffect, useState } from "react";

import { FloatingChatPanel } from "./floating-chat-panel";
import { useMessengerStore } from "./messenger-store";


export function FloatingChatStack() {
  const windows = useMessengerStore((s) => s.openWindows);
  const [isNarrow, setIsNarrow] = useState(false);

  // Track the narrow-viewport threshold purely client-side so the
  // collapse decision uses the live viewport, not a stale SSR guess.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setIsNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  if (windows.length === 0) return null;

  if (isNarrow) {
    // Phone: only the newest panel renders, full width. Older panels
    // stay in the store so the user can reopen them via the bell.
    // The early-return above guarantees ``windows.length > 0``; the
    // explicit guard satisfies ``noUncheckedIndexedAccess``.
    const latest = windows[windows.length - 1];
    if (!latest) return null;
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 px-2 pb-2">
        <FloatingChatPanel window={latest} />
      </div>
    );
  }

  return (
    <div
      className="
        fixed bottom-0 right-4 z-40 flex max-w-[calc(100vw-2rem)]
        items-end gap-3 overflow-x-auto overflow-y-hidden
        pb-0 pl-2
      "
      role="region"
      aria-label="Open chats"
    >
      {windows.map((w) => (
        <div key={`${w.entityKind}:${w.entityId}`} className="flex-shrink-0">
          <FloatingChatPanel window={w} />
        </div>
      ))}
    </div>
  );
}
