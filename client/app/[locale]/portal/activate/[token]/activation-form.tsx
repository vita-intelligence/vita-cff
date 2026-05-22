"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  P,
  PortalButton,
  PortalInput,
} from "@/components/portal/brutalist";
import { activate, requestActivationCode } from "@/services/portal/api";
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
  const [info, setInfo] = useState<string | null>(null);
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
    setError(null);
    setInfo(null);
    setStep("code");
  }

  async function onCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
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
      <CodeStep
        token={token}
        emailMasked={emailMasked}
        code={code}
        onCodeChange={setCode}
        onSubmit={onCodeSubmit}
        onBack={() => {
          setError(null);
          setInfo(null);
          setStep("password");
        }}
        submitting={submitting}
        error={error}
        info={info}
        setError={setError}
        setInfo={setInfo}
      />
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
        After this step we will email you a 6-digit code at{" "}
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


/**
 * The code-entry screen. Two responsibilities beyond the obvious
 * form: (1) auto-fire the request-code endpoint exactly once when
 * the customer first arrives on this screen so the OTP lands in
 * their inbox without an extra click, and (2) drive the "Resend"
 * countdown — disabled for 60 seconds after each send, then
 * clickable, with a precise mm:ss timer below the button.
 *
 * The countdown is fed by ``retry_after_seconds`` from the server
 * so a hammered Resend (e.g. customer multi-clicks) resyncs to the
 * server-side cooldown rather than drifting locally.
 */
function CodeStep({
  token,
  emailMasked,
  code,
  onCodeChange,
  onSubmit,
  onBack,
  submitting,
  error,
  info,
  setError,
  setInfo,
}: {
  token: string;
  emailMasked: string;
  code: string;
  onCodeChange: (next: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
  submitting: boolean;
  error: string | null;
  info: string | null;
  setError: (msg: string | null) => void;
  setInfo: (msg: string | null) => void;
}) {
  const [cooldown, setCooldown] = useState<number>(0);
  const [resending, setResending] = useState(false);
  const hasAutoFiredRef = useRef(false);

  // ``sendCode`` exists outside the auto-fire effect so the Resend
  // button can call the same function. ``isAutoFire`` controls the
  // info banner copy so a fresh visit reads "We sent a code" while
  // a resend reads "Sent again".
  const sendCode = useCallback(
    async (isAutoFire: boolean) => {
      setError(null);
      try {
        const result = await requestActivationCode(token);
        setCooldown(result.retry_after_seconds);
        setInfo(
          isAutoFire
            ? `We sent a 6-digit code to ${emailMasked}.`
            : `We sent another code to ${emailMasked}.`,
        );
      } catch (err: unknown) {
        const e = err as {
          response?: {
            status?: number;
            data?: { code?: string; retry_after_seconds?: number };
          };
        };
        const status = e?.response?.status;
        const errorCode = e?.response?.data?.code;
        if (status === 429 && e.response?.data?.retry_after_seconds) {
          // Server says "you asked too soon" — resync our countdown
          // to whatever it returned. Don't surface this as a hard
          // error since the previous code is still valid in their
          // inbox; just nudge the user with the wait time.
          setCooldown(e.response.data.retry_after_seconds);
          setInfo(
            `Please wait ${e.response.data.retry_after_seconds}s before requesting another code.`,
          );
          return;
        }
        if (errorCode === "account_already_activated") {
          // Returner — bounce to sign-in. The page should normally
          // route these before the code step but defence-in-depth.
          window.location.href = "/portal/login";
          return;
        }
        setError(portalErrorMessage(err));
      }
    },
    [token, emailMasked, setError, setInfo],
  );

  // Auto-fire the first code request on mount — exactly once.
  // React 19 in strict mode runs effects twice in dev; the ref guard
  // prevents a duplicate request that would burn the 60s cooldown
  // before the customer ever sees the form.
  useEffect(() => {
    if (hasAutoFiredRef.current) return;
    hasAutoFiredRef.current = true;
    void sendCode(true);
  }, [sendCode]);

  // Tick the cooldown down to zero. ``setInterval`` is cheap enough
  // at 1s and lets us render an mm:ss countdown without any extra
  // bookkeeping; the effect tears down naturally when the form
  // unmounts after a successful submit.
  useEffect(() => {
    if (cooldown <= 0) return;
    const handle = window.setInterval(() => {
      setCooldown((current) => (current > 0 ? current - 1 : 0));
    }, 1000);
    return () => window.clearInterval(handle);
  }, [cooldown]);

  const canResend = cooldown <= 0 && !resending;
  const handleResend = async () => {
    if (!canResend) return;
    setResending(true);
    try {
      await sendCode(false);
    } finally {
      setResending(false);
    }
  };

  return (
    <Card as="section" className="max-w-xl">
      <H1>Confirm your email</H1>
      <P>
        Type the 6-digit code we just sent to{" "}
        <strong>{emailMasked}</strong>. It expires in 10 minutes; if you
        don't see it, check your spam folder or use Resend below.
      </P>
      {info ? (
        <p
          role="status"
          className="mb-4 border-2 border-black bg-white px-4 py-3 text-sm font-medium"
        >
          {info}
        </p>
      ) : null}
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <PortalInput
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          label="6-digit code"
          value={code}
          onChange={(e) =>
            onCodeChange(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          pattern="\d{6}"
          required
          className="font-mono text-2xl tracking-[0.5em]"
          placeholder="000000"
        />
        <div className="flex flex-wrap items-center gap-3">
          <PortalButton type="submit" disabled={submitting}>
            {submitting ? "Confirming…" : "Confirm & enter portal"}
          </PortalButton>
          <PortalButton
            type="button"
            variant="secondary"
            onClick={onBack}
          >
            Back
          </PortalButton>
        </div>
        <div className="mt-2 flex items-center gap-3 text-sm">
          {canResend ? (
            <button
              type="button"
              onClick={handleResend}
              className="font-bold underline underline-offset-4 hover:no-underline"
            >
              {resending ? "Sending…" : "Resend code"}
            </button>
          ) : (
            <span className="text-neutral-600">
              Resend available in {formatCooldown(cooldown)}
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}


function formatCooldown(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
