"use client";

/**
 * PSP-facing access tokens card.
 *
 * The mirror of PSP's own outbound integration-tokens workbench: an
 * admin mints tokens here that PSP will present on the reverse
 * integration surface (``/api/psp-integration/*``). The raw token
 * appears exactly once in a copy-once modal on mint; every list read
 * only ever shows the prefix.
 *
 * Owner-only. Sits next to :class:`PspCard` on the Integrations tab
 * so both directions of the PSP↔NPD pipe are configured in one place.
 */

import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  useMintPspAccessToken,
  usePspAccessTokens,
  useRevokePspAccessToken,
  type PspAccessTokenDto,
} from "@/services/psp";
import type { OrganizationDto } from "@/services/organizations";


type Banner =
  | { readonly kind: "success"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | null;


export function PspTokensCard({
  organization,
}: {
  organization: OrganizationDto;
}) {
  const orgId = organization.id;
  const tokensQuery = usePspAccessTokens(orgId);
  const mintMutation = useMintPspAccessToken(orgId);
  const revokeMutation = useRevokePspAccessToken(orgId);

  const [newName, setNewName] = useState("");
  const [banner, setBanner] = useState<Banner>(null);
  const [freshToken, setFreshToken] = useState<{
    readonly name: string;
    readonly raw: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<PspAccessTokenDto | null>(
    null,
  );

  // Auto-hide the "copied" flash after a beat so subsequent copies
  // give the operator fresh visual feedback.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const tokens = tokensQuery.data?.items ?? [];

  const onMint = async () => {
    setBanner(null);
    const name = newName.trim();
    if (!name) {
      setBanner({ kind: "error", message: "Give the token a name first." });
      return;
    }
    try {
      const result = await mintMutation.mutateAsync({ name });
      setFreshToken({ name: result.record.name, raw: result.token });
      setNewName("");
      setBanner({ kind: "success", message: `Token “${name}” created.` });
    } catch (error) {
      // 409 name conflict / 400 name required all bubble up as ApiError
      // with a translated code — surface a short message for the common
      // ones and fall back to the raw string otherwise.
      const message = error instanceof Error ? error.message : "Mint failed";
      setBanner({
        kind: "error",
        message: message.includes("name_conflict")
          ? "A token with that name already exists."
          : message,
      });
    }
  };

  const onCopy = async (raw: string) => {
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
    } catch {
      // Best-effort — leave the raw visible in the modal so the
      // operator can select + copy manually if clipboard perms are
      // denied.
    }
  };

  const onRevoke = async (row: PspAccessTokenDto) => {
    setBanner(null);
    try {
      await revokeMutation.mutateAsync({ tokenId: row.id });
      setBanner({ kind: "success", message: `“${row.name}” revoked.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Revoke failed";
      setBanner({ kind: "error", message });
    } finally {
      setRevokeConfirm(null);
    }
  };

  return (
    <section className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-inset ring-ink-200">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold text-ink-1000">
            <KeyRound className="h-4 w-4 text-orange-600" />
            PSP-facing tokens
          </h2>
          <p className="text-xs text-ink-600">
            Bearer tokens PSP presents when calling NPD (the reverse of
            the PSP integration above — used for the R&amp;D column on
            PSP&rsquo;s <code className="rounded bg-ink-50 px-1 py-0.5 text-[10px]">/projects</code>).
            The raw token appears once on create; only the prefix is
            stored plaintext for display afterwards.
          </p>
        </div>
      </div>

      {/* ---------- Mint form ---------- */}
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <div className="min-w-[200px] flex-1">
          <label
            htmlFor="psp-token-name"
            className="block text-xs font-medium uppercase tracking-wide text-ink-500"
          >
            New token name
          </label>
          <input
            id="psp-token-name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Production PSP"
            className="mt-1 w-full rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            disabled={mintMutation.isPending}
          />
        </div>
        <button
          type="button"
          onClick={onMint}
          disabled={mintMutation.isPending || newName.trim() === ""}
          className="inline-flex items-center gap-1.5 rounded-xl bg-ink-1000 px-3 py-2 text-sm font-semibold text-ink-0 shadow-sm hover:bg-ink-900 disabled:cursor-not-allowed disabled:bg-ink-300"
        >
          {mintMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Create token
        </button>
      </div>

      {banner ? (
        <p
          className={`mt-3 rounded-xl px-3 py-2 text-xs ${
            banner.kind === "success"
              ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200"
              : "bg-danger/10 text-danger ring-1 ring-inset ring-danger/20"
          }`}
        >
          {banner.message}
        </p>
      ) : null}

      {/* ---------- Token list ---------- */}
      <div className="mt-5">
        {tokensQuery.isLoading ? (
          <p className="text-xs text-ink-500">Loading tokens…</p>
        ) : tokens.length === 0 ? (
          <p className="rounded-xl bg-ink-50 px-3 py-3 text-xs text-ink-600 ring-1 ring-inset ring-ink-100">
            No tokens yet. Create one above, then paste it into PSP&rsquo;s
            R&amp;D integration settings.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-ink-100 rounded-xl bg-ink-50/60 ring-1 ring-inset ring-ink-100">
            {tokens.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink-1000">
                      {row.name}
                    </span>
                    {row.is_active ? (
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-700 ring-1 ring-inset ring-ink-200">
                        Revoked
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-500">
                    <span className="font-mono">{row.prefix}…</span>
                    {row.created_at ? (
                      <span>
                        Created {formatShortDate(row.created_at)}
                        {row.created_by_name ? ` · ${row.created_by_name}` : ""}
                      </span>
                    ) : null}
                    {row.last_used_at ? (
                      <span>Last used {formatShortDate(row.last_used_at)}</span>
                    ) : null}
                  </div>
                </div>
                {row.is_active ? (
                  <button
                    type="button"
                    onClick={() => setRevokeConfirm(row)}
                    disabled={revokeMutation.isPending}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ShieldOff className="h-3.5 w-3.5" />
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---------- Fresh-token copy-once modal ---------- */}
      {freshToken ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-lg rounded-2xl bg-ink-0 p-5 shadow-2xl ring-1 ring-inset ring-ink-200">
            <h3 className="text-sm font-semibold text-ink-1000">
              Copy “{freshToken.name}” now
            </h3>
            <p className="mt-1 text-xs text-ink-600">
              This is the only time NPD will show the raw token. Paste
              it into PSP&rsquo;s <em>R&amp;D (NPD) integration</em>{" "}
              settings, then close this dialog. If you lose it, revoke
              this token here and mint a fresh one.
            </p>
            <div className="mt-3 rounded-xl bg-ink-50 p-3 font-mono text-[11px] break-all text-ink-1000 ring-1 ring-inset ring-ink-100">
              {freshToken.raw}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => onCopy(freshToken.raw)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-ink-1000 px-3 py-2 text-xs font-semibold text-ink-0 shadow-sm hover:bg-ink-900"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy to clipboard"}
              </button>
              <button
                type="button"
                onClick={() => setFreshToken(null)}
                className="rounded-xl px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------- Revoke confirmation ---------- */}
      {revokeConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-md rounded-2xl bg-ink-0 p-5 shadow-2xl ring-1 ring-inset ring-ink-200">
            <h3 className="text-sm font-semibold text-ink-1000">
              Revoke “{revokeConfirm.name}”?
            </h3>
            <p className="mt-1 text-xs text-ink-600">
              PSP won&rsquo;t be able to fetch R&amp;D projects with
              this token any more. Revocation is immediate and can&rsquo;t
              be undone — mint a new token if you need one afterwards.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRevokeConfirm(null)}
                className="rounded-xl px-3 py-2 text-xs font-medium text-ink-600 hover:bg-ink-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => onRevoke(revokeConfirm)}
                disabled={revokeMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-xl bg-danger px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {revokeMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldOff className="h-3.5 w-3.5" />
                )}
                Revoke token
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}


function formatShortDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}
