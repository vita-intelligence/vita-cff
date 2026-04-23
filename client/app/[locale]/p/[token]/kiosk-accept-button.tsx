"use client";

/**
 * Kiosk sign-off entry point.
 *
 * Renders on the public preview page and is responsible for the
 * customer's acceptance signature on a ``sent`` spec sheet.
 *
 * Flow:
 *   1. Visitor opens the public link.
 *   2. If they have not identified yet (no localStorage marker +
 *      no session cookie), the kiosk comments panel already forces
 *      the identity modal to appear. Once they've identified, the
 *      ``name`` localStorage marker is present and we can sign.
 *   3. Clicking "Sign and accept" opens the reusable signature
 *      dialog. On confirm, we POST to the public accept endpoint.
 *   4. A successful response transitions the sheet to ``accepted``
 *      and ``router.refresh()`` re-fetches the render payload so
 *      the sheet re-paints with the captured signature + new
 *      status.
 *
 * The component intentionally has no authentication logic — the
 * server enforces both "you must have a kiosk session cookie" and
 * "your session's name must match the signer name", so the client
 * can stay dumb.
 */

import { Button } from "@heroui/react";
import { CheckCircle2, PenLine } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { KioskIdentityModal } from "@/components/comments/kiosk/kiosk-identity-modal";
import { SignatureDialog } from "@/components/ui/signature-dialog";
import { acceptKioskSpecification } from "@/services/comments";
import type { KioskIdentityEcho } from "@/services/comments/kiosk-api";


interface Props {
  readonly token: string;
  readonly sheetStatus: string;
  readonly customerName: string;
  readonly customerSignedAt: string | null;
  readonly customerSignatureImage: string;
  /** When true, accepting the spec sheet also marks the attached
   *  proposal as accepted — the button surfaces that so the
   *  customer knows what they're signing. */
  readonly hasProposal?: boolean;
}


interface KioskMarker {
  readonly name: string;
  readonly email: string;
  readonly company?: string;
}


// Must stay in sync with ``identifiedKey`` inside
// ``kiosk-comments-panel.tsx`` — the same marker gates both the
// comments flow and this accept flow, so a visitor who has
// introduced themselves on the comments panel can immediately sign
// without re-entering their name.
function readIdentityMarker(token: string): KioskMarker | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(
      `vita_kiosk_${token}_identified`,
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KioskMarker>;
    if (!parsed.name || !parsed.email) return null;
    return {
      name: parsed.name,
      email: parsed.email,
      company: parsed.company ?? "",
    };
  } catch {
    return null;
  }
}


export function KioskAcceptButton({
  token,
  sheetStatus,
  customerName,
  customerSignedAt,
  customerSignatureImage,
  hasProposal = false,
}: Props) {
  const tSpecs = useTranslations("specifications");
  const router = useRouter();
  const [identity, setIdentity] = useState<KioskMarker | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Identity marker lands in localStorage after the visitor posts
  // their name/email through the kiosk identity modal. We poll on
  // mount + focus so the button reflects the latest state once the
  // user has identified through the comments panel without
  // requiring a manual page reload.
  useEffect(() => {
    const refresh = () => setIdentity(readIdentityMarker(token));
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [token]);

  const handleIdentified = (echo: KioskIdentityEcho) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        `vita_kiosk_${token}_identified`,
        JSON.stringify(echo),
      );
    }
    setIdentity({
      name: echo.name,
      email: echo.email,
      company: echo.company,
    });
    setIdentityOpen(false);
    // Flow straight into the signature dialog — the user just
    // introduced themselves specifically to sign, making them
    // click again would be friction.
    setDialogOpen(true);
  };

  // Already accepted — show a read-only confirmation card instead
  // of the sign-off button.
  if (sheetStatus === "accepted" && customerSignedAt) {
    return (
      <div className="rounded-xl border border-success/40 bg-success/5 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-ink-1000">
              {tSpecs("signature.accepted_banner", {
                name: customerName || tSpecs("sheet.signature.customer"),
                when: new Date(customerSignedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </p>
            {customerSignatureImage ? (
              <img
                src={customerSignatureImage}
                alt="Customer signature"
                className="mt-3 max-h-20 rounded-lg bg-ink-0 p-1 ring-1 ring-inset ring-ink-200"
              />
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  // Pre-sent states (draft / in_review / approved / rejected) —
  // nothing for the customer to sign yet.
  if (sheetStatus !== "sent") {
    return (
      <p className="rounded-xl bg-ink-50 px-4 py-3 text-xs text-ink-500">
        {tSpecs("signature.not_sent_yet")}
      </p>
    );
  }

  const handleConfirm = async (dataUrl: string) => {
    if (!identity) {
      setError("missing_identity");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await acceptKioskSpecification(token, {
        name: identity.name,
        email: identity.email,
        company: identity.company,
        signature_image: dataUrl,
      });
      setDialogOpen(false);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "kiosk_accept_failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="primary"
        size="md"
        className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
        onClick={() => {
          // No identity yet → capture it first, then the modal's
          // ``onIdentified`` callback chains into the signature
          // dialog. One click for the visitor, two modals behind
          // the scenes.
          if (!identity) {
            setIdentityOpen(true);
          } else {
            setDialogOpen(true);
          }
        }}
      >
        <PenLine className="h-4 w-4" />
        {tSpecs(
          hasProposal
            ? "signature.accept_button_bundled"
            : "signature.accept_button",
        )}
      </Button>
      {hasProposal ? (
        <p className="text-xs text-ink-500">
          {tSpecs("signature.bundled_hint")}
        </p>
      ) : null}
      {identityOpen ? (
        <KioskIdentityModal
          token={token}
          onIdentified={handleIdentified}
          onDismiss={() => setIdentityOpen(false)}
        />
      ) : null}
      <SignatureDialog
        isOpen={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setError(null);
        }}
        title={tSpecs(
          hasProposal
            ? "signature.customer_title_bundled"
            : "signature.customer_title",
        )}
        subtitle={tSpecs(
          hasProposal
            ? "signature.customer_subtitle_bundled"
            : "signature.customer_subtitle",
        )}
        confirmLabel={tSpecs(
          hasProposal
            ? "signature.accept_button_bundled"
            : "signature.accept_button",
        )}
        cancelLabel={tSpecs("signature.cancel")}
        busy={busy}
        errorMessage={error}
        onConfirm={handleConfirm}
      />
    </div>
  );
}
