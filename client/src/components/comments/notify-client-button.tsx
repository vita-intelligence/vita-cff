"use client";

/**
 * "Notify client" action surfaced on a spec-sheet chat.
 *
 * Renders as a compact button in the CommentsPanel header. Clicking
 * opens a small dialog where the team member can optionally add a
 * note, then confirms; the backend emails every identified kiosk
 * customer for the sheet (subject to a 5-minute cooldown per
 * recipient so a double-click never sends a second email).
 *
 * The button only mounts for spec-sheet chats — formulations have
 * no customer-facing surface to notify. It also self-disables when
 * there are no identified clients yet, with a tooltip explaining
 * why.
 */

import {
  Bell,
  CheckCircle2,
  Loader2,
  Send,
  X,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import {
  useNotifyClient,
  useNotifyClientSummary,
  type NotifyClientResponseDto,
} from "@/services/comments";


type ToastShape =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string };


export interface NotifyClientButtonProps {
  readonly orgId: string;
  readonly sheetId: string;
}


export function NotifyClientButton({
  orgId,
  sheetId,
}: NotifyClientButtonProps) {
  const t = useTranslations("comments.notify_client");
  const summary = useNotifyClientSummary(orgId, sheetId);
  const mutation = useNotifyClient(orgId, sheetId);
  const formatter = useFormatter();

  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [toast, setToast] = useState<ToastShape | null>(null);

  // Auto-dismiss the inline toast after 5s.
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const recipientCount = summary.data?.recipient_count ?? 0;
  const hasClients = recipientCount > 0;
  const maxLength = summary.data?.custom_note_max_length ?? 1000;
  const remaining = Math.max(0, maxLength - note.length);

  const lastSentLabel = useMemo(() => {
    const sentAt = summary.data?.last_alert?.sent_at;
    if (!sentAt) return null;
    return formatter.relativeTime(new Date(sentAt), new Date());
  }, [summary.data, formatter]);

  const handleSubmit = async () => {
    try {
      const result = await mutation.mutateAsync({ note: note.trim() });
      setToast({ kind: "success", message: formatResult(t, result) });
      setOpen(false);
      setNote("");
    } catch (error) {
      const apiError = error as { payload?: { detail?: string } };
      const code = apiError?.payload?.detail;
      if (code === "no_identified_clients") {
        setToast({ kind: "error", message: t("error_no_clients") });
      } else if (code === "custom_note_too_long") {
        setToast({ kind: "error", message: t("error_note_too_long") });
      } else {
        setToast({ kind: "error", message: t("error_generic") });
      }
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!hasClients || summary.isLoading}
        title={
          hasClients
            ? t("button")
            : t("button_disabled_no_clients")
        }
        className="
          inline-flex items-center gap-1.5 rounded-full
          bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800
          ring-1 ring-inset ring-blue-200 transition-colors
          hover:bg-blue-100 hover:text-blue-900
          disabled:cursor-not-allowed disabled:bg-ink-100
          disabled:text-ink-500 disabled:ring-ink-200
        "
      >
        <Bell className="h-3.5 w-3.5" aria-hidden />
        <span>{t("button")}</span>
      </button>

      {summary.data ? (
        <p className="text-[10px] text-ink-500">
          {lastSentLabel
            ? t("hint_last_sent", { when: lastSentLabel })
            : t("hint_never")}
        </p>
      ) : null}

      {open ? (
        <NotifyClientDialog
          recipientCount={recipientCount}
          note={note}
          remaining={remaining}
          maxLength={maxLength}
          isSubmitting={mutation.isPending}
          onChangeNote={setNote}
          onCancel={() => {
            if (mutation.isPending) return;
            setOpen(false);
            setNote("");
          }}
          onConfirm={handleSubmit}
        />
      ) : null}

      {toast ? (
        <div
          role={toast.kind === "error" ? "alert" : "status"}
          className={
            "fixed bottom-6 right-6 z-50 inline-flex items-start gap-2 " +
            "rounded-lg px-4 py-3 text-sm shadow-lg ring-1 ring-inset " +
            (toast.kind === "success"
              ? "bg-success/10 text-success ring-success/30"
              : toast.kind === "error"
                ? "bg-red-50 text-red-800 ring-red-200"
                : "bg-ink-100 text-ink-800 ring-ink-200")
          }
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-current/70 hover:text-current"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------


interface DialogProps {
  readonly recipientCount: number;
  readonly note: string;
  readonly remaining: number;
  readonly maxLength: number;
  readonly isSubmitting: boolean;
  readonly onChangeNote: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}


function NotifyClientDialog({
  recipientCount,
  note,
  remaining,
  maxLength,
  isSubmitting,
  onChangeNote,
  onCancel,
  onConfirm,
}: DialogProps) {
  const t = useTranslations("comments.notify_client");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSubmitting) {
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isSubmitting, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="notify-client-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isSubmitting) {
          onCancel();
        }
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-blue-700" aria-hidden />
            <h2
              id="notify-client-title"
              className="text-sm font-semibold text-ink-1000"
            >
              {t("dialog_title")}
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            aria-label={t("dialog_cancel")}
            className="rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-4 text-sm text-ink-800">
          <p>{t("dialog_body")}</p>
          <p className="mt-2 text-xs font-medium text-ink-600">
            {recipientCount === 1
              ? t("dialog_recipients_singular", { count: recipientCount })
              : t("dialog_recipients_plural", { count: recipientCount })}
          </p>

          <label className="mt-4 block">
            <span className="block text-xs font-semibold uppercase tracking-wider text-ink-600">
              {t("dialog_note_label")}
            </span>
            <textarea
              value={note}
              onChange={(event) =>
                onChangeNote(event.target.value.slice(0, maxLength))
              }
              placeholder={t("dialog_note_placeholder")}
              rows={4}
              maxLength={maxLength}
              disabled={isSubmitting}
              className="
                mt-1 w-full resize-y rounded-lg border border-ink-200
                bg-white px-3 py-2 text-sm text-ink-1000
                placeholder:text-ink-500
                focus:border-blue-400 focus:outline-none focus:ring-2
                focus:ring-blue-200 disabled:cursor-not-allowed
                disabled:bg-ink-50
              "
            />
            <span className="mt-1 block text-[10px] text-ink-500">
              {t("dialog_note_remaining", { remaining })}
            </span>
          </label>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-ink-100 bg-ink-50 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSubmitting}
            className="
              rounded-lg px-3 py-1.5 text-sm font-medium text-ink-700
              transition-colors hover:bg-white disabled:opacity-50
            "
          >
            {t("dialog_cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isSubmitting || recipientCount === 0}
            className="
              inline-flex items-center gap-1.5 rounded-lg
              bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white
              transition-colors hover:bg-blue-700
              disabled:cursor-not-allowed disabled:bg-ink-400
            "
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("dialog_sending")}
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                {t("dialog_send")}
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Toast-message composition
// ---------------------------------------------------------------------------


function formatResult(
  t: ReturnType<typeof useTranslations>,
  result: NotifyClientResponseDto,
): string {
  const sent = result.sent_emails.length;
  const skipped = result.skipped_emails.length;
  const total = sent + skipped + result.failed_emails.length;

  if (result.failed_emails.length === total && total > 0) {
    return t("toast_failed");
  }
  if (sent === 0 && skipped > 0) {
    return t("toast_all_skipped");
  }
  if (sent > 0 && skipped === 0) {
    return sent === 1
      ? t("toast_sent_singular", { count: sent })
      : t("toast_sent_plural", { count: sent });
  }
  return t("toast_partial", { sent, total, skipped });
}
