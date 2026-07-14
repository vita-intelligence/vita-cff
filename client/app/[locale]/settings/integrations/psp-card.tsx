"use client";

/**
 * PSP integration settings card.
 *
 * Owner-only. Mirrors :class:`MrpeasyCard` — status badge, form
 * body, Test / Save / Disable buttons, mutual-exclusion banner
 * when MRPEasy is live on the same org (the two integrations
 * share consumer paths; enabling one server-side clears the
 * other, so the FE surface makes that trade-off explicit before
 * the operator hits Save).
 *
 * Fields: base URL + integration token. PSP mints the token on
 * its own settings surface (Companies → Integration tokens) and
 * the operator pastes it here once — Fernet-encrypted at rest.
 */

import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Loader2,
  Server,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useTranslations } from "next-intl";
import type { OrganizationDto } from "@/services/organizations";
import {
  useClearPspConfig,
  usePspConfig,
  useSavePspConfig,
  useTestPspConnection,
} from "@/services/psp";


type Banner =
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | null;


export function PspCard({
  organization,
}: {
  organization: OrganizationDto;
}) {
  const orgId = organization.id;
  const tErrors = useTranslations("errors");

  const configQuery = usePspConfig(orgId);
  const saveMutation = useSavePspConfig(orgId);
  const testMutation = useTestPspConnection(orgId);
  const clearMutation = useClearPspConfig(orgId);

  const [enabled, setEnabled] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    const cfg = configQuery.data;
    if (!cfg) return;
    // Mirror the MRPEasy card's first-setup UX: leave the enable
    // box ticked when nothing has been stored yet so the operator
    // doesn't accidentally save an ``enabled=false`` config on
    // first setup. Only mirror the server flag when a token is on
    // file (something real to toggle against).
    setEnabled(cfg.has_token ? cfg.enabled : true);
    setBaseUrl(cfg.base_url);
    setToken("");
  }, [configQuery.data]);

  const hasStoredToken = Boolean(configQuery.data?.has_token);
  const lastTestedAt = configQuery.data?.last_tested_at ?? null;
  const isConnected = hasStoredToken && Boolean(lastTestedAt);
  // Mutual exclusion — a live MRPEasy config on the same org will
  // be cleared on save. Warn the operator so the trade-off is
  // explicit before they commit.
  const mrpeasyLive = organization.mrpeasy_live;

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    try {
      await saveMutation.mutateAsync({
        enabled,
        base_url: baseUrl.trim(),
        // Empty string is the "keep existing token" sentinel —
        // same UX as MRPEasy / Dynamics. Non-empty rotates.
        integration_token: token,
      });
      setToken("");
      setBanner({
        kind: "success",
        message: "PSP configuration saved.",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: extractApiErrorMessage(err, tErrors),
      });
    }
  };

  const handleTest = async () => {
    setBanner(null);
    try {
      await testMutation.mutateAsync();
      setBanner({
        kind: "success",
        message: "PSP connection verified.",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: extractApiErrorMessage(err, tErrors),
      });
    }
  };

  const handleDisable = async () => {
    if (
      !window.confirm(
        "Disconnect PSP? Formulation builder pickers and price hints will fall back to local catalogues / manual entry.",
      )
    )
      return;
    setBanner(null);
    try {
      await clearMutation.mutateAsync();
      setToken("");
      setBanner({
        kind: "success",
        message: "PSP integration cleared.",
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message: extractApiErrorMessage(err, tErrors),
      });
    }
  };

  const isBusy =
    saveMutation.isPending ||
    testMutation.isPending ||
    clearMutation.isPending;

  return (
    <article className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-orange-700 ring-1 ring-inset ring-orange-200">
            <Server className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <h2 className="text-base font-semibold text-ink-1000">
              PSP integration
            </h2>
            <p className="mt-0.5 text-xs leading-snug text-ink-500">
              Vita&apos;s own production platform. When live, item
              pickers + price hints read from PSP directly and MRPEasy
              is disabled.
            </p>
          </div>
        </div>
        <PspStatusBadge
          isConnected={isConnected}
          hasStoredToken={hasStoredToken}
        />
      </header>

      {mrpeasyLive && enabled ? (
        <div className="mt-5 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-inset ring-amber-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            MRPEasy is currently live on this workspace. Saving PSP
            with <span className="font-semibold">Enabled</span> ticked
            will disconnect MRPEasy — the two integrations share the
            same consumer paths and can&apos;t run simultaneously.
          </span>
        </div>
      ) : null}

      <form onSubmit={handleSave} className="mt-6 flex flex-col gap-5">
        <label className="flex items-center gap-2 text-xs font-medium text-ink-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-orange-500"
          />
          Enabled — pickers, price hints, and item lookups route to PSP
        </label>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-700">
              Base URL
            </label>
            <input
              type="url"
              required={enabled}
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://psp.internal"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm"
            />
            <p className="text-[11px] text-ink-500">
              Root URL where PSP is reachable — e.g.{" "}
              <span className="font-mono">https://psp.internal</span> in
              prod, <span className="font-mono">http://localhost:4000</span>{" "}
              in dev. No trailing slash needed.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-700">
              Integration token
            </label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                hasStoredToken
                  ? "••••••••••••••  (stored — leave blank to keep)"
                  : "psp_live_…"
              }
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm font-mono"
            />
            <p className="text-[11px] text-ink-500">
              Mint on PSP → Settings → Integration tokens. Grant the{" "}
              <span className="font-mono">item:read</span> scope so
              NPD can list items. Never leaves this device — encrypted
              at rest and only decrypted server-side on outbound calls.
            </p>
          </div>
        </div>

        {banner ? (
          <p
            role="alert"
            className={`flex items-start gap-2 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset ${
              banner.kind === "success"
                ? "bg-success/10 text-success ring-success/20"
                : "bg-danger/10 text-danger ring-danger/20"
            }`}
          >
            {banner.kind === "success" ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            )}
            <span>{banner.message}</span>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {hasStoredToken ? (
            <button
              type="button"
              onClick={() => void handleDisable()}
              disabled={isBusy}
              className="rounded-lg px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/5 disabled:opacity-60"
            >
              Disconnect
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={isBusy || !hasStoredToken}
            title={
              hasStoredToken
                ? "Round-trip PSP's health endpoint to verify the token"
                : "Save a token first, then test the connection"
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            Test connection
          </button>
          <button
            type="submit"
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-xs font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-60"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            Save
          </button>
        </div>
      </form>
    </article>
  );
}


function PspStatusBadge({
  isConnected,
  hasStoredToken,
}: {
  isConnected: boolean;
  hasStoredToken: boolean;
}) {
  if (isConnected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connected
      </span>
    );
  }
  if (hasStoredToken) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        Saved — test needed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-ink-600">
      Not connected
    </span>
  );
}
