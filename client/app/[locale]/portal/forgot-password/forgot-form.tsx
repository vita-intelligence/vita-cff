"use client";

import { useState } from "react";

import {
  Card,
  ErrorBanner,
  H1,
  P,
  PortalButton,
  PortalInput,
} from "@/components/portal/brutalist";
import { requestPasswordReset } from "@/services/portal/api";


export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <Card className="max-w-xl">
        <H1>Check your inbox</H1>
        <P>
          If an account exists for that email, a reset link is on its way.
          The link expires in 30 minutes.
        </P>
      </Card>
    );
  }

  return (
    <Card className="max-w-xl">
      <H1>Reset password</H1>
      <P>
        Tell us the email address on your account and we will send a reset
        link.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <PortalInput
          name="email"
          type="email"
          label="Email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <PortalButton type="submit" disabled={submitting}>
          {submitting ? "Sending…" : "Send reset link"}
        </PortalButton>
      </form>
    </Card>
  );
}
