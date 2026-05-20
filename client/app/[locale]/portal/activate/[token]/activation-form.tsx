"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  P,
  PortalButton,
  PortalInput,
} from "@/components/portal/brutalist";
import { activate } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


type Step = "password" | "code";


export function ActivationForm({
  token,
  customerCompany,
  emailMasked,
  alreadyActivated,
  proposalCode,
}: {
  token: string;
  customerCompany: string;
  emailMasked: string;
  alreadyActivated: boolean;
  proposalCode: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (alreadyActivated) {
    return (
      <Card className="max-w-xl">
        <H1>Welcome back</H1>
        <P>
          The account for <strong>{customerCompany}</strong> already exists.
          Sign in to review proposal <strong>{proposalCode}</strong> and
          everything else attached to your account.
        </P>
        <PortalButton onClick={() => router.push("/portal/login")}>
          Sign in →
        </PortalButton>
      </Card>
    );
  }

  function onPasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    // Password validated locally; defer the actual API call until
    // the customer also types the 6-digit code on the next screen.
    // Locking in the password client-side keeps the second step
    // honest about "you're almost done" — only the code remains.
    setStep("code");
  }

  async function onCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError("The code is 6 digits.");
      return;
    }
    setSubmitting(true);
    try {
      await activate(token, password, code);
      router.push("/portal");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { code?: string } } };
      if (e?.response?.data?.code === "account_already_activated") {
        router.push("/portal/login");
        return;
      }
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (step === "code") {
    return (
      <Card as="section" className="max-w-xl">
        <H1>Confirm your email</H1>
        <P>
          We sent a <strong>6-digit code</strong> to{" "}
          <strong>{emailMasked}</strong>. Paste it here to finish setting
          up your account.
        </P>
        <ErrorBanner>{error}</ErrorBanner>
        <form onSubmit={onCodeSubmit} className="flex flex-col gap-4">
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
              {submitting ? "Confirming…" : "Confirm & enter portal"}
            </PortalButton>
            <PortalButton
              type="button"
              variant="secondary"
              onClick={() => {
                setError(null);
                setStep("password");
              }}
            >
              Back
            </PortalButton>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card as="section" className="max-w-xl">
      <H1>Set your password</H1>
      <P>
        Hello <strong>{customerCompany}</strong> — proposal{" "}
        <strong>{proposalCode}</strong> is waiting for you. Pick a password
        to set up your account. Future updates will use the same login.
      </P>
      <P>
        After this step we will confirm the 6-digit code we sent to{" "}
        <strong>{emailMasked}</strong>.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onPasswordSubmit} className="flex flex-col gap-4">
        <PortalInput
          name="password"
          type="password"
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
        />
        <PortalInput
          name="confirm"
          type="password"
          label="Confirm password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
        />
        <PortalButton type="submit">Next: enter code →</PortalButton>
      </form>
    </Card>
  );
}
