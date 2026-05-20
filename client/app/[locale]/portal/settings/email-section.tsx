"use client";

import { useState } from "react";

import {
  Card,
  ErrorBanner,
  H2,
  P,
  PortalButton,
  PortalInput,
} from "@/components/portal/brutalist";
import {
  confirmEmailChange,
  requestEmailChange,
} from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


type Step = "view" | "code";


export function EmailSection({ initialEmail }: { initialEmail: string }) {
  const [currentEmail, setCurrentEmail] = useState(initialEmail);
  const [step, setStep] = useState<Step>("view");
  const [pendingEmail, setPendingEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  async function onRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!pendingEmail.trim()) {
      setError("Enter the new email.");
      return;
    }
    if (pendingEmail.trim().toLowerCase() === currentEmail.toLowerCase()) {
      setError("That's already your email.");
      return;
    }
    setSubmitting(true);
    try {
      await requestEmailChange(pendingEmail.trim());
      setStep("code");
      setCode("");
      setInfo(`Code sent to ${pendingEmail.trim()}.`);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onConfirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError("The code is 6 digits.");
      return;
    }
    setSubmitting(true);
    try {
      const updated = await confirmEmailChange(code);
      setCurrentEmail(updated.email);
      setPendingEmail("");
      setCode("");
      setStep("view");
      setInfo("Email updated.");
      setTimeout(() => setInfo(null), 3_000);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card as="section">
      <H2>Email</H2>
      <P>
        Current email: <strong>{currentEmail}</strong>
      </P>
      {info ? (
        <div className="mb-4 border-2 border-black bg-white px-4 py-3 text-sm font-bold uppercase tracking-widest">
          {info}
        </div>
      ) : null}
      <ErrorBanner>{error}</ErrorBanner>
      {step === "view" ? (
        <form onSubmit={onRequest} className="flex flex-col gap-4">
          <PortalInput
            name="new_email"
            type="email"
            label="New email"
            autoComplete="email"
            value={pendingEmail}
            onChange={(e) => setPendingEmail(e.target.value)}
            required
          />
          <p className="text-sm">
            We'll send a 6-digit code to the new address. Your email
            here only changes once you enter the code, so a typo doesn't
            lock you out.
          </p>
          <div>
            <PortalButton type="submit" disabled={submitting}>
              {submitting ? "Sending…" : "Send verification code"}
            </PortalButton>
          </div>
        </form>
      ) : (
        <form onSubmit={onConfirm} className="flex flex-col gap-4">
          <P>
            Enter the 6-digit code we just sent to{" "}
            <strong>{pendingEmail}</strong>.
          </P>
          <PortalInput
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            label="6-digit code"
            value={code}
            onChange={(e) =>
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
            pattern="\d{6}"
            required
            className="font-mono text-2xl tracking-[0.5em]"
            placeholder="000000"
          />
          <div className="flex gap-3">
            <PortalButton type="submit" disabled={submitting}>
              {submitting ? "Confirming…" : "Confirm new email"}
            </PortalButton>
            <PortalButton
              type="button"
              variant="secondary"
              onClick={() => {
                setError(null);
                setInfo(null);
                setStep("view");
                setCode("");
              }}
            >
              Cancel
            </PortalButton>
          </div>
        </form>
      )}
    </Card>
  );
}
