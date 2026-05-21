"use client";

import { CheckCircle2, PenLine } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  Eyebrow,
  PageHeader,
  PortalButton,
  SignedChip,
  StatusPill,
} from "@/components/portal/brutalist";
import { PortalSignatureDialog } from "@/components/portal/portal-signature-dialog";
import { SpecChatPanel } from "@/components/portal/spec-chat-panel";
import { apiClient } from "@/lib/api";
import { portalErrorMessage } from "@/services/portal/errors";
import { fetchSpec, type PortalSpecListItem } from "@/services/portal/api";
import { SpecSheetContent } from "../../../specifications/[id]/specification-sheet-view";


const READ_THRESHOLD = 0.98;


type SpecDetail = PortalSpecListItem & { render_context: unknown };


export function PortalSpecView({ sheetId }: { sheetId: string }) {
  const [spec, setSpec] = useState<SpecDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const [allRead, setAllRead] = useState(false);

  const load = useCallback(async () => {
    try {
      const fresh = await fetchSpec(sheetId);
      setSpec(fresh);
      setLoadError(null);
    } catch (err: unknown) {
      setLoadError(portalErrorMessage(err));
    }
  }, [sheetId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onSign(dataUrl: string) {
    if (!spec?.proposal?.id) return;
    setActionError(null);
    setBusy(true);
    try {
      await apiClient.post(
        `/api/portal/proposals/${spec.proposal.id}/specs/${sheetId}/sign/`,
        { signature_image: dataUrl },
      );
      setPending(false);
      await load();
    } catch (err: unknown) {
      setActionError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <Card>
        <p>{loadError}</p>
        <Link
          href="/portal/specs"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          ← Back to specifications
        </Link>
      </Card>
    );
  }

  if (!spec) return <p>Loading…</p>;

  const canSign =
    !spec.has_signature
    && spec.proposal !== null
    && allRead
    && spec.proposal.status === "sent";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={spec.proposal ? `Proposal ${spec.proposal.code}` : "Specification"}
        title={spec.formulation_name || spec.code || "Specification"}
        subtitle={spec.code ? `Reference: ${spec.code}` : undefined}
        back={
          spec.proposal
            ? {
                href: `/portal/proposals/${spec.proposal.id}`,
                label: `Proposal ${spec.proposal.code}`,
              }
            : { href: "/portal/specs", label: "Specifications" }
        }
        actions={
          <>
            {spec.has_signature ? (
              <SignedChip at={spec.customer_signed_at} />
            ) : (
              <StatusPill status={spec.status} />
            )}
          </>
        }
      />

      {actionError ? <ErrorBanner>{actionError}</ErrorBanner> : null}

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <Eyebrow>Document</Eyebrow>
        </div>
        <ScrollTrackingDiv
          className="max-h-[760px] overflow-y-auto border-2 border-black bg-white p-6 sm:p-8"
          onAllReadChange={setAllRead}
        >
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <SpecSheetContent rendered={spec.render_context as any} />
        </ScrollTrackingDiv>
        {!spec.has_signature ? (
          <div className="mt-6 border-t-2 border-dashed border-black pt-6">
            <PortalButton
              type="button"
              disabled={!canSign}
              onClick={() => setPending(true)}
            >
              <PenLine className="h-4 w-4" />
              Sign this specification
            </PortalButton>
            {!allRead ? (
              <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
                Scroll to the bottom to enable signing.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-6 inline-flex items-center gap-2 border-2 border-black bg-black px-4 py-3 text-sm font-bold uppercase tracking-widest text-white">
            <CheckCircle2 className="h-4 w-4" /> You signed this specification
          </div>
        )}
      </Card>

      <SpecChatPanel sheetId={sheetId} sheetCode={spec.code} />

      <PortalSignatureDialog
        isOpen={pending}
        onOpenChange={(open) => {
          if (!open) {
            setPending(false);
            setActionError(null);
          }
        }}
        title={`Sign — ${spec.code || "specification"}`}
        subtitle="Draw your signature with your mouse, finger or stylus."
        confirmLabel="Submit signature"
        busy={busy}
        errorMessage={actionError}
        onConfirm={onSign}
      />
    </div>
  );
}


function ScrollTrackingDiv({
  className,
  children,
  onAllReadChange,
}: {
  className: string;
  children: React.ReactNode;
  onAllReadChange: (allRead: boolean) => void;
}) {
  const [progress, setProgress] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const allDone = progress >= READ_THRESHOLD;
  const cbRef = useRef(onAllReadChange);
  useEffect(() => {
    cbRef.current = onAllReadChange;
  }, [onAllReadChange]);
  useEffect(() => {
    cbRef.current(allDone);
  }, [allDone]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const el = ref.current;
      if (!el) return;
      const scrollTop = el.scrollTop;
      const clientHeight = el.clientHeight;
      const scrollHeight = el.scrollHeight;
      if (scrollHeight <= 0 || clientHeight <= 0) return;
      const scrollable = Math.max(0, scrollHeight - clientHeight);
      if (scrollable <= 0) {
        setProgress(1);
        return;
      }
      const fraction = scrollTop / scrollable;
      setProgress((prev) =>
        fraction > prev ? Math.min(1, fraction) : prev,
      );
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const pct = Math.round(progress * 100);

  return (
    <div className="flex flex-col gap-2">
      <div ref={ref} className={className}>
        {children}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-bold uppercase tracking-widest">
        <span>Read progress</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 w-full border-2 border-black">
        <div
          className="h-full bg-black transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {pct < 98 ? (
        <button
          type="button"
          onClick={() => setProgress(1)}
          className="mt-1 self-start text-[10px] font-bold uppercase tracking-widest underline opacity-60 hover:opacity-100"
        >
          Mark as read
        </button>
      ) : null}
    </div>
  );
}
