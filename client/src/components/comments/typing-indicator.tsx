"use client";

/**
 * Animated "Alice is typing…" line.
 *
 * Subscribes to the presence store so the list updates instantly
 * when a ``typing.start`` lands or the 5-second TTL expires.
 */

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import {
  presenceStoreFor,
  type EntityKey,
} from "@/services/comments";


interface Props {
  readonly entityKey: EntityKey;
  /** Filter out the current user so self-typing never renders in
   *  the local UI — we already see our own textarea. */
  readonly excludeViewerId?: string | null;
}


export function TypingIndicator({ entityKey, excludeViewerId }: Props) {
  const tComments = useTranslations("comments");
  const store = presenceStoreFor(entityKey);
  // Subscribe to the raw list so zustand's ``Object.is`` check hits
  // the stable reference the store holds. Filtering inside the
  // selector would allocate a fresh array every render, breaking
  // ``useSyncExternalStore``'s caching and triggering the "getSnapshot
  // should be cached" infinite-loop detector.
  const typistsRaw = store((state) => state.typists);
  const typists = useMemo(
    () => typistsRaw.filter((v) => v.id !== excludeViewerId),
    [typistsRaw, excludeViewerId],
  );

  if (typists.length === 0) return null;

  const label = tComments("typing.template", {
    count: typists.length,
    first: typists[0]!.name,
    second: typists[1]?.name ?? "",
    rest: typists.length - 2,
  });

  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 px-4 py-1.5 text-xs text-ink-500"
    >
      <span className="flex items-center gap-0.5" aria-hidden>
        <TypingDot delay="0" />
        <TypingDot delay="0.15s" />
        <TypingDot delay="0.3s" />
      </span>
      <span>{label}</span>
    </div>
  );
}


function TypingDot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400"
      style={{ animationDelay: delay, animationDuration: "1s" }}
    />
  );
}
