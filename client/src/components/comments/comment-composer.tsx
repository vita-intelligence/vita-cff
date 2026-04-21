"use client";

/**
 * Comment composer — textarea + send button + @-mention autocomplete.
 *
 * The mention flow tracks the current ``@``-prefixed word at the
 * caret. When one is detected we pop the autocomplete, and selecting
 * a member replaces the token with ``@<email>`` in place. This
 * matches the server's parser convention in
 * ``apps.comments.mentions``: the wire body carries ``@<email>``, the
 * UI renders it nicely on read.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/button-styles";
import type { MentionableMemberDto } from "@/services/comments";

import { MentionAutocomplete } from "./mention-autocomplete";

interface Props {
  readonly orgId: string;
  readonly submitLabel: string;
  readonly placeholder: string;
  readonly cancelLabel?: string;
  readonly initialValue?: string;
  readonly disabled?: boolean;
  readonly isSubmitting?: boolean;
  readonly onSubmit: (body: string) => void | Promise<void>;
  readonly onCancel?: () => void;
  readonly autoFocus?: boolean;
  /** Emitted when the user starts / stops typing. The panel forwards
   *  these to the WebSocket so peers see a "X is typing…" line.
   *  Optional so composers mounted outside a WS-enabled surface (e.g.
   *  unit tests, future kiosk view) still render cleanly. */
  readonly onTypingChange?: (isTyping: boolean) => void;
}

export function CommentComposer({
  orgId,
  submitLabel,
  placeholder,
  cancelLabel,
  initialValue = "",
  disabled = false,
  isSubmitting = false,
  onSubmit,
  onCancel,
  autoFocus = false,
  onTypingChange,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Edge-triggered typing signals — only emit on transition so the
  // server bus stays quiet while the user is hammering keys. A
  // ``useRef`` makes the last-known state readable without a
  // re-render cycle.
  const isTypingRef = useRef(false);
  const typingIdleTimer = useRef<number | null>(null);

  const mentionState = useMentionCaret(value, textareaRef);
  const trimmed = value.trim();
  const canSubmit = !disabled && !isSubmitting && trimmed.length > 0;

  const pulseTyping = useCallback(
    (nowTyping: boolean) => {
      if (!onTypingChange) return;
      if (nowTyping) {
        // Start: fire once per transition. Keep a rolling idle timer
        // so the server sees ``stop`` when the user walks away
        // without needing the browser unload event.
        if (!isTypingRef.current) {
          isTypingRef.current = true;
          onTypingChange(true);
        }
        if (typingIdleTimer.current !== null) {
          window.clearTimeout(typingIdleTimer.current);
        }
        typingIdleTimer.current = window.setTimeout(() => {
          isTypingRef.current = false;
          onTypingChange(false);
          typingIdleTimer.current = null;
        }, 3_500);
      } else {
        if (typingIdleTimer.current !== null) {
          window.clearTimeout(typingIdleTimer.current);
          typingIdleTimer.current = null;
        }
        if (isTypingRef.current) {
          isTypingRef.current = false;
          onTypingChange(false);
        }
      }
    },
    [onTypingChange],
  );

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    void Promise.resolve(onSubmit(trimmed)).then(() => {
      setValue("");
      pulseTyping(false);
    });
  }, [canSubmit, onSubmit, trimmed, pulseTyping]);

  // Close any lingering typing state when the composer unmounts. A
  // user who closes the tab mid-sentence should not leave a stale
  // "X is typing…" line on every other viewer's screen.
  useEffect(() => {
    return () => {
      if (typingIdleTimer.current !== null) {
        window.clearTimeout(typingIdleTimer.current);
        typingIdleTimer.current = null;
      }
      if (isTypingRef.current && onTypingChange) {
        isTypingRef.current = false;
        onTypingChange(false);
      }
    };
    // ``onTypingChange`` changes on panel remount; we want the
    // latest reference when the effect runs, not the first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKey = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ⌘/Ctrl+Enter submits even while the mention picker is open.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  const insertMention = useCallback(
    (member: MentionableMemberDto) => {
      if (!mentionState.active) return;
      const { start, end } = mentionState;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const insertion = `@${member.email} `;
      const next = `${before}${insertion}${after}`;
      setValue(next);
      // Restore caret position after React commits the new value.
      window.requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        const caret = start + insertion.length;
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [mentionState, value],
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            setValue(next);
            // A non-empty textarea body after a change = user is
            // still typing. An emptied textarea = user deleted
            // everything → stop.
            pulseTyping(next.trim().length > 0);
          }}
          onBlur={() => pulseTyping(false)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          disabled={disabled || isSubmitting}
          autoFocus={autoFocus}
          rows={3}
          className="w-full resize-y rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none placeholder:text-ink-500 focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
        />
        <MentionAutocomplete
          orgId={orgId}
          query={mentionState.query}
          anchorRect={mentionState.anchorRect}
          open={mentionState.active}
          onSelect={insertMention}
          onClose={() => textareaRef.current?.focus()}
        />
      </div>
      <div className="flex justify-end gap-2">
        {onCancel && cancelLabel ? (
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            onClick={onCancel}
            disabled={isSubmitting}
          >
            {cancelLabel}
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass("primary", "sm")}
          onClick={handleSubmit}
          disabled={!canSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Mention caret tracking
// ---------------------------------------------------------------------------


interface MentionState {
  readonly active: boolean;
  readonly query: string;
  readonly start: number;
  readonly end: number;
  readonly anchorRect: DOMRect | null;
}


function useMentionCaret(
  value: string,
  textareaRef: React.RefObject<HTMLTextAreaElement | null>,
): MentionState {
  // Recompute on every render — cheap and avoids stale caret state.
  return useMemo(() => {
    const el = textareaRef.current;
    if (!el) {
      return {
        active: false,
        query: "",
        start: 0,
        end: 0,
        anchorRect: null,
      };
    }
    const caret = el.selectionStart ?? 0;
    const upto = value.slice(0, caret);
    // Walk back to the nearest whitespace. Anything between the
    // whitespace and the caret is the active token.
    const wsIndex = Math.max(
      upto.lastIndexOf(" "),
      upto.lastIndexOf("\n"),
      upto.lastIndexOf("\t"),
    );
    const tokenStart = wsIndex + 1;
    const token = upto.slice(tokenStart);
    if (!token.startsWith("@")) {
      return {
        active: false,
        query: "",
        start: 0,
        end: 0,
        anchorRect: null,
      };
    }
    const query = token.slice(1);
    // Stay conservative: only trigger once the user has typed at
    // least one letter. An empty ``@`` pops the picker too early
    // and flashes it while autosuggest is usually wrong.
    if (query.length === 0) {
      return {
        active: true,
        query: "",
        start: tokenStart,
        end: caret,
        anchorRect: el.getBoundingClientRect(),
      };
    }
    // If the token already contains an ``@`` sign it's a completed
    // email — stop showing the picker. The user will hit space.
    if (query.includes("@")) {
      return {
        active: false,
        query: "",
        start: 0,
        end: 0,
        anchorRect: null,
      };
    }
    return {
      active: true,
      query,
      start: tokenStart,
      end: caret,
      anchorRect: el.getBoundingClientRect(),
    };
    // ``textareaRef`` is mutable but the DOM rect + selection change
    // on every keystroke, so depending on ``value`` alone is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}
