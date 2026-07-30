"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Plug,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useClearDynamicsConfig,
  useDynamicsConfig,
  useSaveDynamicsConfig,
  useTestDynamicsConnection,
} from "@/services/customers";
import {
  useClearMrpeasyConfig,
  useMrpeasyConfig,
  useSaveMrpeasyConfig,
  useTestMrpeasyConnection,
} from "@/services/mrpeasy";
import { PspCard } from "./psp-card";
import { PspTokensCard } from "./psp-tokens-card";
import {
  useClearWixCFFConfig,
  useSaveWixCFFConfig,
  useTestWixCFFConnection,
  useWixCFFConfig,
} from "@/services/cff-submissions";
import type { OrganizationDto } from "@/services/organizations/types";


type Banner =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | null;


/**
 * Settings → Integrations.
 *
 * Surfaces every third-party integration as its own card. Today we
 * ship Microsoft Dynamics 365 (Sales / CE); future integrations
 * (Business Central, MailerLite, etc.) drop in next to it without
 * disturbing the existing one.
 *
 * Owner-only — the page filter hides the tab from non-owners and
 * the API re-checks server-side. The Dynamics card itself does
 * NOT render the plaintext client secret back to the user: the
 * config payload carries a ``has_secret`` boolean and the form
 * shows a "●●●●●●●" placeholder until the admin rotates it.
 */
export function IntegrationsTab({
  organization,
}: {
  organization: OrganizationDto | null;
}) {
  const tSettings = useTranslations("settings.integrations");

  if (!organization) {
    return (
      <p className="rounded-2xl bg-ink-50 p-6 text-sm text-ink-600 ring-1 ring-inset ring-ink-200">
        {tSettings("no_org")}
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-6">
      <DynamicsCard orgId={organization.id} />
      {/* PSP + MRPEasy are mutually exclusive on the same org; both
          cards render so the operator can see the current state and
          switch lanes intentionally. Enabling one clears the other
          server-side. */}
      <PspCard organization={organization} />
      {/* Reverse direction — PSP calls NPD. Mint tokens here that PSP
          admins paste into their own R&D integration settings card. */}
      <PspTokensCard organization={organization} />
      <MrpeasyCard orgId={organization.id} />
      <WixCFFCard orgId={organization.id} />
    </section>
  );
}


/**
 * Wix CFF intake card.
 *
 * Connect / disconnect the public Custom Formulation Request form
 * hosted on the org's Wix site. Same shape as the Dynamics and
 * MRPEasy cards: plaintext API key is never round-tripped — the
 * form shows ``has_api_key`` as a "●●●●●●●" placeholder so an
 * admin who only wants to flip ``enabled`` or change the form id
 * doesn't have to re-paste the credential.
 */
function WixCFFCard({ orgId }: { orgId: string }) {
  const tSettings = useTranslations("cff.settings");
  const tErrors = useTranslations("errors");

  const configQuery = useWixCFFConfig(orgId);
  const saveMutation = useSaveWixCFFConfig(orgId);
  const testMutation = useTestWixCFFConnection(orgId);
  const clearMutation = useClearWixCFFConfig(orgId);

  const [enabled, setEnabled] = useState(true);
  const [siteId, setSiteId] = useState("");
  const [formId, setFormId] = useState("");
  const [namespace, setNamespace] = useState("wix.form_app.form");
  const [apiKey, setApiKey] = useState("");
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    const cfg = configQuery.data;
    if (!cfg) return;
    // First-setup UX matches the MRPEasy card: leave Enabled
    // checked when nothing is stored yet so the operator's first
    // Save doesn't silently flip the box off.
    setEnabled(cfg.has_api_key ? cfg.enabled : true);
    setSiteId(cfg.site_id);
    setFormId(cfg.form_id);
    setNamespace(cfg.namespace || "wix.form_app.form");
    setApiKey("");
  }, [configQuery.data]);

  const hasStoredKey = Boolean(configQuery.data?.has_api_key);
  const lastTestedAt = configQuery.data?.last_tested_at ?? null;
  const isConnected = hasStoredKey && Boolean(lastTestedAt);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    try {
      await saveMutation.mutateAsync({
        enabled,
        site_id: siteId.trim(),
        form_id: formId.trim(),
        namespace: namespace.trim() || "wix.form_app.form",
        // Empty string = "keep existing key" sentinel. Non-empty
        // rotates and clears ``last_tested_at`` server-side.
        api_key: apiKey,
      });
      setApiKey("");
      setBanner({ kind: "success", message: tSettings("saved") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
    }
  };

  const handleTest = async () => {
    setBanner(null);
    try {
      const result = await testMutation.mutateAsync();
      const count = result.total_submissions ?? 0;
      setBanner({
        kind: "success",
        message: tSettings("test_success", { count }),
      });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
    }
  };

  const handleDisable = async () => {
    if (!window.confirm(tSettings("confirm_clear_body"))) return;
    setBanner(null);
    try {
      await clearMutation.mutateAsync();
      setApiKey("");
      setBanner({ kind: "success", message: tSettings("cleared") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
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
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200">
            <Plug className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <h2 className="text-base font-semibold text-ink-1000">
              {tSettings("title")}
            </h2>
            <p className="mt-0.5 max-w-prose text-xs leading-snug text-ink-500">
              {tSettings("description")}
            </p>
          </div>
        </div>
        <WixCFFStatusBadge
          enabled={enabled}
          hasStoredKey={hasStoredKey}
          isConnected={isConnected}
          tSettings={tSettings}
        />
      </header>

      <form onSubmit={handleSave} className="mt-6 flex flex-col gap-5">
        <label className="flex items-center gap-2 text-xs font-medium text-ink-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-orange-500"
          />
          {tSettings("enabled_label")}
        </label>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label={tSettings("site_id_label")}
            value={siteId}
            onChange={setSiteId}
            placeholder="c0d9135f-baa5-4029-baec-42521e033385"
            hint={tSettings("site_id_help")}
          />
          <Field
            label={tSettings("form_id_label")}
            value={formId}
            onChange={setFormId}
            placeholder="bec673ee-0020-4c34-a09a-8332356548af"
            hint={tSettings("form_id_help")}
          />
          <Field
            label={tSettings("namespace_label")}
            value={namespace}
            onChange={setNamespace}
            placeholder="wix.form_app.form"
            hint={tSettings("namespace_help")}
          />
          <Field
            label={tSettings("api_key_label")}
            value={apiKey}
            onChange={setApiKey}
            placeholder={
              hasStoredKey
                ? "••••••••  (stored — leave blank to keep)"
                : tSettings("api_key_placeholder")
            }
            hint={tSettings("api_key_help")}
            type="password"
          />
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
          {hasStoredKey ? (
            <button
              type="button"
              onClick={() => void handleDisable()}
              disabled={isBusy}
              className="rounded-lg px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/5 disabled:opacity-60"
            >
              {clearMutation.isPending
                ? tSettings("clearing")
                : tSettings("clear")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={isBusy || !hasStoredKey}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {testMutation.isPending
              ? tSettings("testing")
              : tSettings("test")}
          </button>
          <button
            type="submit"
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-xs font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-60"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {saveMutation.isPending
              ? tSettings("saving")
              : tSettings("save")}
          </button>
        </div>
      </form>
    </article>
  );
}


function WixCFFStatusBadge({
  enabled,
  hasStoredKey,
  isConnected,
  tSettings,
}: {
  enabled: boolean;
  hasStoredKey: boolean;
  isConnected: boolean;
  tSettings: (key: string) => string;
}) {
  if (isConnected && enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success ring-1 ring-inset ring-success/20">
        <CheckCircle2 className="h-3 w-3" />
        {tSettings("status_connected")}
      </span>
    );
  }
  if (!enabled && hasStoredKey) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-600">
        <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />
        {tSettings("status_disabled")}
      </span>
    );
  }
  if (hasStoredKey) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/20">
        <AlertTriangle className="h-3 w-3" />
        {tSettings("status_untested")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-600">
      <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />
      {tSettings("status_incomplete")}
    </span>
  );
}


function DynamicsCard({ orgId }: { orgId: string }) {
  const tSettings = useTranslations("settings.integrations.dynamics");
  const tErrors = useTranslations("errors");

  const configQuery = useDynamicsConfig(orgId);
  const saveMutation = useSaveDynamicsConfig(orgId);
  const testMutation = useTestDynamicsConnection(orgId);
  const clearMutation = useClearDynamicsConfig(orgId);

  const [enabled, setEnabled] = useState(true);
  const [dataverseUrl, setDataverseUrl] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [banner, setBanner] = useState<Banner>(null);

  // Seed the form with whatever the server has on disk. ``has_secret``
  // tells us a previous value exists; the form leaves the secret
  // input blank but renders a placeholder so the admin knows they
  // can edit other fields without re-pasting it.
  useEffect(() => {
    const cfg = configQuery.data;
    if (!cfg) return;
    setEnabled(cfg.enabled);
    setDataverseUrl(cfg.dataverse_url);
    setTenantId(cfg.tenant_id);
    setClientId(cfg.client_id);
    setClientSecret("");
  }, [configQuery.data]);

  const hasStoredSecret = Boolean(configQuery.data?.has_secret);
  const lastTestedAt = configQuery.data?.last_tested_at ?? null;
  const isConnected = hasStoredSecret && Boolean(lastTestedAt);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    try {
      await saveMutation.mutateAsync({
        enabled,
        dataverse_url: dataverseUrl.trim(),
        tenant_id: tenantId.trim(),
        client_id: clientId.trim(),
        // Empty string = "keep existing secret". Non-empty rotates.
        client_secret: clientSecret,
      });
      setClientSecret("");
      setBanner({ kind: "success", message: tSettings("saved") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
    }
  };

  const handleTest = async () => {
    setBanner(null);
    try {
      await testMutation.mutateAsync();
      setBanner({ kind: "success", message: tSettings("test_ok") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
    }
  };

  const handleDisable = async () => {
    if (!window.confirm(tSettings("disable_confirm"))) return;
    setBanner(null);
    try {
      await clearMutation.mutateAsync();
      setClientSecret("");
      setBanner({ kind: "success", message: tSettings("disabled") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
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
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200">
            <Plug className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <h2 className="text-base font-semibold text-ink-1000">
              {tSettings("title")}
            </h2>
            <p className="mt-0.5 text-xs leading-snug text-ink-500">
              {tSettings("subtitle")}
            </p>
          </div>
        </div>
        <StatusBadge
          isConnected={isConnected}
          hasStoredSecret={hasStoredSecret}
          tSettings={tSettings}
        />
      </header>

      <form
        onSubmit={handleSave}
        className="mt-6 flex flex-col gap-5"
      >
        <label className="flex items-center gap-2 text-xs font-medium text-ink-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-orange-500"
          />
          {tSettings("enabled_label")}
        </label>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label={tSettings("dataverse_url_label")}
            value={dataverseUrl}
            onChange={setDataverseUrl}
            placeholder="https://contoso.crm.dynamics.com"
            hint={tSettings("dataverse_url_hint")}
          />
          <Field
            label={tSettings("tenant_id_label")}
            value={tenantId}
            onChange={setTenantId}
            placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
            hint={tSettings("tenant_id_hint")}
          />
          <Field
            label={tSettings("client_id_label")}
            value={clientId}
            onChange={setClientId}
            placeholder="11111111-2222-3333-4444-555555555555"
            hint={tSettings("client_id_hint")}
          />
          <Field
            label={tSettings("client_secret_label")}
            value={clientSecret}
            onChange={setClientSecret}
            placeholder={
              hasStoredSecret
                ? "••••••••••••••••  (stored — leave blank to keep)"
                : tSettings("client_secret_placeholder")
            }
            hint={tSettings("client_secret_hint")}
            type="password"
          />
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
          {hasStoredSecret ? (
            <button
              type="button"
              onClick={() => void handleDisable()}
              disabled={isBusy}
              className="rounded-lg px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/5 disabled:opacity-60"
            >
              {tSettings("disable")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={isBusy || !hasStoredSecret}
            title={
              hasStoredSecret
                ? tSettings("test_button_hint")
                : tSettings("test_button_disabled_hint")
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {tSettings("test_button")}
          </button>
          <button
            type="submit"
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-xs font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-60"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {tSettings("save_button")}
          </button>
        </div>
      </form>

      <p className="mt-6 border-t border-ink-100 pt-4 text-[11px] leading-snug text-ink-500">
        {tSettings("footer_note")}
      </p>
    </article>
  );
}


/**
 * MRPEasy card. Mirrors :func:`DynamicsCard` but with a simpler
 * form (two fields: API key + API secret) because MRPEasy's REST
 * auth is HTTP Basic against a fixed base URL — no per-org
 * subdomain / tenant / OAuth flow to configure. Owner-only by
 * the same backend permission class.
 */
function MrpeasyCard({ orgId }: { orgId: string }) {
  const tSettings = useTranslations("settings.integrations.mrpeasy");
  const tErrors = useTranslations("errors");

  const configQuery = useMrpeasyConfig(orgId);
  const saveMutation = useSaveMrpeasyConfig(orgId);
  const testMutation = useTestMrpeasyConnection(orgId);
  const clearMutation = useClearMrpeasyConfig(orgId);

  const [enabled, setEnabled] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [banner, setBanner] = useState<Banner>(null);

  useEffect(() => {
    const cfg = configQuery.data;
    if (!cfg) return;
    // First-setup UX: when nothing has been stored yet, leave the
    // ``Enable`` box ticked (the ``useState(true)`` default). The
    // server's ``cfg.enabled`` is false for an unconfigured org,
    // and seeding from it would silently flip the box off — so the
    // operator types credentials, clicks Save, and is then puzzled
    // when the Test button reports "not configured" because
    // ``enabled`` rode false through the save. Only mirror the
    // server's flag when there's actually a stored secret to
    // toggle against.
    setEnabled(cfg.has_secret ? cfg.enabled : true);
    setApiKey(cfg.api_key);
    setApiSecret("");
  }, [configQuery.data]);

  const hasStoredSecret = Boolean(configQuery.data?.has_secret);
  const lastTestedAt = configQuery.data?.last_tested_at ?? null;
  const isConnected = hasStoredSecret && Boolean(lastTestedAt);

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBanner(null);
    try {
      await saveMutation.mutateAsync({
        enabled,
        api_key: apiKey.trim(),
        // Empty string = "keep existing secret" (same UX as
        // Dynamics). Non-empty rotates.
        api_secret: apiSecret,
      });
      setApiSecret("");
      setBanner({ kind: "success", message: tSettings("saved") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
    }
  };

  const handleTest = async () => {
    setBanner(null);
    try {
      await testMutation.mutateAsync();
      setBanner({ kind: "success", message: tSettings("test_ok") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
    }
  };

  const handleDisable = async () => {
    if (!window.confirm(tSettings("disable_confirm"))) return;
    setBanner(null);
    try {
      await clearMutation.mutateAsync();
      setApiSecret("");
      setBanner({ kind: "success", message: tSettings("disabled") });
    } catch (err) {
      setBanner({ kind: "error", message: extractError(err, tErrors) });
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
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200">
            <Plug className="h-5 w-5" />
          </div>
          <div className="flex flex-col">
            <h2 className="text-base font-semibold text-ink-1000">
              {tSettings("title")}
            </h2>
            <p className="mt-0.5 text-xs leading-snug text-ink-500">
              {tSettings("subtitle")}
            </p>
          </div>
        </div>
        <StatusBadge
          isConnected={isConnected}
          hasStoredSecret={hasStoredSecret}
          tSettings={tSettings}
        />
      </header>

      <form onSubmit={handleSave} className="mt-6 flex flex-col gap-5">
        <label className="flex items-center gap-2 text-xs font-medium text-ink-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-orange-500"
          />
          {tSettings("enabled_label")}
        </label>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field
            label={tSettings("api_key_label")}
            value={apiKey}
            onChange={setApiKey}
            placeholder="z1g41b3d0a7c2"
            hint={tSettings("api_key_hint")}
          />
          <Field
            label={tSettings("api_secret_label")}
            value={apiSecret}
            onChange={setApiSecret}
            placeholder={
              hasStoredSecret
                ? "••••••••••••••••  (stored — leave blank to keep)"
                : tSettings("api_secret_placeholder")
            }
            hint={tSettings("api_secret_hint")}
            type="password"
          />
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
          {hasStoredSecret ? (
            <button
              type="button"
              onClick={() => void handleDisable()}
              disabled={isBusy}
              className="rounded-lg px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/30 hover:bg-danger/5 disabled:opacity-60"
            >
              {tSettings("disable")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleTest()}
            disabled={isBusy || !hasStoredSecret}
            title={
              hasStoredSecret
                ? tSettings("test_button_hint")
                : tSettings("test_button_disabled_hint")
            }
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {tSettings("test_button")}
          </button>
          <button
            type="submit"
            disabled={isBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-xs font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-60"
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {tSettings("save_button")}
          </button>
        </div>
      </form>

      <p className="mt-6 border-t border-ink-100 pt-4 text-[11px] leading-snug text-ink-500">
        {tSettings("footer_note")}
      </p>
    </article>
  );
}


function StatusBadge({
  isConnected,
  hasStoredSecret,
  tSettings,
}: {
  isConnected: boolean;
  hasStoredSecret: boolean;
  // Loosened from the Dynamics-specific namespace so the MRPEasy
  // card can reuse this same badge. Both translation namespaces
  // expose ``status_connected`` / ``status_untested`` /
  // ``status_not_connected`` keys with identical labels — the
  // type widens to ``string`` so the function signature accepts
  // either.
  tSettings: (key: string) => string;
}) {
  if (isConnected) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success ring-1 ring-inset ring-success/20">
        <CheckCircle2 className="h-3 w-3" />
        {tSettings("status_connected")}
      </span>
    );
  }
  if (hasStoredSecret) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/20">
        <AlertTriangle className="h-3 w-3" />
        {tSettings("status_untested")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-ink-100 px-2.5 py-1 text-[11px] font-medium text-ink-600">
      <span className="h-1.5 w-1.5 rounded-full bg-ink-300" />
      {tSettings("status_not_connected")}
    </span>
  );
}


function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  type?: "text" | "password";
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
      />
      {hint ? <span className="text-[11px] text-ink-500">{hint}</span> : null}
    </label>
  );
}


function extractError(
  err: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (err instanceof ApiError) {
    const detail = err.fieldErrors.detail;
    const code =
      Array.isArray(detail) && detail.length > 0 ? String(detail[0]) : "";
    if (code) return translateCode(tErrors, code);
    const message = err.message;
    if (message) return message;
  }
  return "Something went wrong. Please try again.";
}
