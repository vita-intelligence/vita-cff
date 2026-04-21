"use client";

/**
 * Stack of initial-only avatars for every currently-watching viewer.
 *
 * Initials are computed client-side from the viewer's ``name`` — we
 * deliberately don't render emails or round-trip profile photos yet.
 * A tooltip on hover reveals the full name so a reader can match the
 * circle to a real person.
 */

import { useMemo } from "react";

import {
  presenceStoreFor,
  type EntityKey,
  type Viewer,
} from "@/services/comments";

import { authorInitials } from "./utils";


interface Props {
  readonly entityKey: EntityKey;
  /** The viewer to suppress from the stack — usually the current
   *  user, since showing our own avatar in the "who's here" strip is
   *  noise. */
  readonly excludeViewerId?: string | null;
  readonly maxVisible?: number;
}


const ACCENT_CLASSES = [
  "bg-orange-100 text-orange-700",
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-pink-100 text-pink-700",
  "bg-amber-100 text-amber-700",
  "bg-teal-100 text-teal-700",
  "bg-rose-100 text-rose-700",
] as const;


export function PresenceAvatars({
  entityKey,
  excludeViewerId,
  maxVisible = 4,
}: Props) {
  const store = presenceStoreFor(entityKey);
  const viewers = store((state) => state.viewers);

  const ordered = useMemo(() => {
    const list = Object.values(viewers).filter(
      (v) => v.id !== excludeViewerId,
    );
    list.sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }, [viewers, excludeViewerId]);

  if (ordered.length === 0) return null;

  const visible = ordered.slice(0, maxVisible);
  const overflow = ordered.length - visible.length;

  return (
    <div className="flex items-center -space-x-2">
      {visible.map((v) => (
        <PresenceAvatar key={v.id} viewer={v} />
      ))}
      {overflow > 0 ? (
        <span
          className="grid h-7 w-7 place-items-center rounded-full bg-ink-100 text-[10px] font-semibold text-ink-700 ring-2 ring-ink-0"
          title={ordered
            .slice(maxVisible)
            .map((v) => v.name)
            .join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}


function PresenceAvatar({ viewer }: { viewer: Viewer }) {
  const accent = useMemo(() => {
    // Stable-per-viewer tint: hash the id so the same user keeps the
    // same colour across re-renders / reconnects.
    let hash = 0;
    for (let i = 0; i < viewer.id.length; i += 1) {
      hash = (hash * 31 + viewer.id.charCodeAt(i)) | 0;
    }
    return ACCENT_CLASSES[Math.abs(hash) % ACCENT_CLASSES.length];
  }, [viewer.id]);

  return (
    <span
      className={`grid h-7 w-7 place-items-center rounded-full text-[10px] font-semibold ring-2 ring-ink-0 ${accent}`}
      title={viewer.name}
      aria-label={viewer.name}
    >
      {authorInitials(viewer.name, viewer.name)}
    </span>
  );
}
