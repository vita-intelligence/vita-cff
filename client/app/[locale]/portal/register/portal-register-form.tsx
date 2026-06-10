"use client";

import Link from "next/link";
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
import { confirmRegistration, startRegistration } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


type Step = "details" | "code";


/** The privacy policy URL the form links to. Kept here so the
 *  string the customer ticks against is the SAME string the server
 *  stamps onto their consent record. If marketing ever moves the
 *  page, change it in one place. */
const PRIVACY_POLICY_URL = "https://www.vitamanufacture.co.uk/privacypolicy";


/**
 * Two-step self-registration form.
 *
 * Step 1 collects the customer's contact details, a password, and
 * mandatory privacy-policy acceptance. The submit POSTs the form to
 * the backend, which mails a 6-digit code and returns an opaque
 * registration token.
 *
 * Step 2 collects that 6-digit code, submits it alongside the password
 * (still in component state) and the token, and on success the backend
 * sets portal cookies + we route the customer to ``/portal``.
 *
 * Password is held only in React state, mirroring the kiosk and invite
 * activation flows — losing the tab means restarting registration.
 */
export function PortalRegisterForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("details");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [emailMasked, setEmailMasked] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onDetailsSubmit(e: React.FormEvent) {
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
    if (!privacyAccepted) {
      setError("Please tick the privacy policy box to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await startRegistration({
        email,
        name,
        company,
        password,
        privacy_accepted: privacyAccepted,
      });
      setToken(result.token);
      setEmailMasked(result.email_masked);
      setStep("code");
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function onCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setError("The code is 6 digits.");
      return;
    }
    if (!token) {
      setError("Registration token missing — start again.");
      setStep("details");
      return;
    }
    setSubmitting(true);
    try {
      await confirmRegistration(token, code, password);
      router.push("/portal");
    } catch (err: unknown) {
      const e = err as { response?: { data?: { code?: string } } };
      // Decoy-token path returns invalid_registration_token — treat
      // it as "you probably already have an account, go sign in".
      if (e?.response?.data?.code === "invalid_registration_token") {
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
          <strong>{emailMasked}</strong>. Paste it here to finish
          setting up your account.
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
                setCode("");
                setStep("details");
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
      <H1>Create your account</H1>
      <P>
        Register for the Vita Manufacture customer portal to follow
        your projects, review proposals, and sign off on spec sheets.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onDetailsSubmit} className="flex flex-col gap-4">
        <PortalInput
          name="email"
          type="email"
          label="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <PortalInput
          name="name"
          type="text"
          label="Your name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <PortalInput
          name="company"
          type="text"
          label="Company"
          autoComplete="organization"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
        />
        <PortalInput
          name="password"
          type="password"
          label="Password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          hint="At least 8 characters."
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
        <label className="flex items-start gap-3 border-2 border-black bg-white p-3">
          <input
            type="checkbox"
            checked={privacyAccepted}
            onChange={(e) => setPrivacyAccepted(e.target.checked)}
            className="mt-1 h-5 w-5 shrink-0 border-2 border-black accent-black"
            required
          />
          <span className="text-sm leading-snug">
            I have read and accept the{" "}
            <a
              href={PRIVACY_POLICY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold underline"
            >
              Vita Manufacture privacy policy
            </a>
            .
          </span>
        </label>
        <PortalButton type="submit" disabled={submitting}>
          {submitting ? "Sending code…" : "Next: enter code →"}
        </PortalButton>
      </form>
      <div className="mt-6 border-t-2 border-black pt-4">
        <Link
          href="/portal/login"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          Already have an account? Sign in →
        </Link>
      </div>
    </Card>
  );
}
