"use client";

/**
 * First-visit identity modal for the kiosk / public spec-sheet view.
 *
 * The shared link is unauthenticated, so we cannot assume the
 * visitor has a user account. The modal captures a display name +
 * email (required) and an optional company label, hands them to
 * :func:`identifyKioskVisitor`, and then persists an "identified"
 * marker in ``sessionStorage`` so the modal does not re-prompt on
 * every tab reload during the browser session.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  identifyKioskVisitor,
  type KioskIdentityEcho,
} from "@/services/comments/kiosk-api";


interface Props {
  readonly token: string;
  readonly onIdentified: (identity: KioskIdentityEcho) => void;
  readonly onDismiss?: () => void;
  /**
   * Override the default spec-sheet kiosk URL
   * (``/api/public/specifications/<token>``). Callers on the
   * proposal kiosk pass ``/api/public/proposals/<token>`` so the
   * identify POST lands on the matching endpoint.
   */
  readonly basePath?: string;
}


export function KioskIdentityModal({
  token,
  onIdentified,
  onDismiss,
  basePath,
}: Props) {
  const tKiosk = useTranslations("comments.kiosk");
  const tCommon = useTranslations("common");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit =
    !submitting && name.trim().length > 0 && email.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(null);
    setSubmitting(true);
    try {
      const echo = await identifyKioskVisitor(
        token,
        {
          name: name.trim(),
          email: email.trim(),
          company: company.trim() || undefined,
        },
        basePath,
      );
      onIdentified(echo);
    } catch {
      setError(tKiosk("error_generic"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kiosk-identity-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/40 p-4"
    >
      <form
        method="post"
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-2xl bg-ink-0 p-6 shadow-xl ring-1 ring-ink-200"
      >
        <h2
          id="kiosk-identity-title"
          className="text-lg font-semibold text-ink-1000"
        >
          {tKiosk("title")}
        </h2>
        <p className="mt-1 text-sm text-ink-600">{tKiosk("subtitle")}</p>

        <div className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              {tKiosk("name_label")}
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              {tKiosk("email_label")}
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-700">
              {tKiosk("company_label")}{" "}
              <span className="font-normal text-ink-500">
                {tKiosk("optional")}
              </span>
            </span>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              autoComplete="organization"
              className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </label>

          {error ? (
            <p
              role="alert"
              className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
            >
              {error}
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          {onDismiss ? (
            <button
              type="button"
              className="inline-flex h-10 items-center rounded-lg px-4 text-sm font-medium text-ink-600 hover:bg-ink-50"
              onClick={onDismiss}
              disabled={submitting}
            >
              {tCommon("actions.cancel")}
            </button>
          ) : null}
          <button
            type="submit"
            className="inline-flex h-10 items-center rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canSubmit}
          >
            {submitting ? tCommon("states.loading") : tKiosk("submit")}
          </button>
        </div>

        <p className="mt-4 text-[11px] leading-snug text-ink-500">
          {tKiosk("privacy_note")}
        </p>
      </form>
    </div>
  );
}
