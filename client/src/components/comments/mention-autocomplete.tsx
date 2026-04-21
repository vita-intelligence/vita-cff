"use client";

/**
 * @-mention autocomplete.
 *
 * Consumes ``useMentionableMembers`` so filtering hits the backend —
 * the server's prefix search is cheap and keeps us consistent with
 * the source of truth for org membership. The component renders a
 * small floating panel positioned relative to the composer's
 * textarea when a ``@`` token is the current word at the caret.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  useMentionableMembers,
  type MentionableMemberDto,
} from "@/services/comments";

interface Props {
  readonly orgId: string;
  readonly query: string;
  readonly anchorRect: DOMRect | null;
  readonly open: boolean;
  readonly onSelect: (member: MentionableMemberDto) => void;
  readonly onClose: () => void;
}

export function MentionAutocomplete({
  orgId,
  query,
  anchorRect,
  open,
  onSelect,
  onClose,
}: Props) {
  const debouncedQuery = useDebouncedValue(query, 150);
  const { data, isLoading } = useMentionableMembers(
    orgId,
    debouncedQuery,
    { enabled: open },
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(
    () => (data?.results ?? []).slice(0, 8),
    [data],
  );

  // Keep the highlighted row inside the visible window as the user
  // arrows through — without this a long list scrolls the focus out.
  useEffect(() => {
    setActiveIndex(0);
  }, [debouncedQuery, open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) =>
          results.length === 0 ? 0 : (i + 1) % results.length,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) =>
          results.length === 0
            ? 0
            : (i - 1 + results.length) % results.length,
        );
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (results.length > 0) {
          e.preventDefault();
          onSelect(results[activeIndex]!);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    // Capture phase: we need to beat the textarea's own submit-on-
    // Enter so @mentions insert cleanly.
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, results, activeIndex, onSelect, onClose]);

  if (!open || !anchorRect) return null;
  // ``position: fixed`` uses viewport coordinates, so
  // ``DOMRect.bottom`` is already what we want — adding
  // ``window.scrollY`` shifts the picker below the viewport on any
  // scrolled page, which is why the list was "invisible" in practice.
  const top = anchorRect.bottom + 4;
  const left = anchorRect.left;

  return (
    <div
      role="listbox"
      aria-label="Mention picker"
      className="fixed z-50 min-w-56 overflow-hidden rounded-xl bg-ink-0 shadow-lg ring-1 ring-ink-200"
      style={{ top, left }}
    >
      <ul
        ref={listRef}
        className="max-h-64 overflow-y-auto py-1 text-sm"
      >
        {isLoading && results.length === 0 ? (
          <li className="px-3 py-2 text-xs text-ink-500">Searching…</li>
        ) : results.length === 0 ? (
          <li className="px-3 py-2 text-xs text-ink-500">
            No matching members.
          </li>
        ) : (
          results.map((member, index) => (
            <li key={member.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(e) => {
                  // Keep textarea focus — don't blur before we insert.
                  e.preventDefault();
                  onSelect(member);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left ${
                  index === activeIndex
                    ? "bg-orange-50 text-ink-1000"
                    : "text-ink-700 hover:bg-ink-50"
                }`}
              >
                <span className="font-medium">{member.name}</span>
                <span className="text-[11px] text-ink-500">
                  {member.email}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}


function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return debounced;
}
