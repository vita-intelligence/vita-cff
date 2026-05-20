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
import { changePassword } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


export function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setSaved(true);
      setTimeout(() => setSaved(false), 3_000);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card as="section">
      <H2>Password</H2>
      <P>
        Rotate the password you use to sign in to the portal. You will
        stay signed in on this device after the change.
      </P>
      <ErrorBanner>{error}</ErrorBanner>
      {saved ? (
        <div className="mb-4 border-2 border-black bg-white px-4 py-3 text-sm font-bold uppercase tracking-widest">
          Password updated ✓
        </div>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <PortalInput
          name="current_password"
          type="password"
          label="Current password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <PortalInput
          name="new_password"
          type="password"
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={8}
        />
        <PortalInput
          name="confirm_password"
          type="password"
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
        />
        <div>
          <PortalButton type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Change password"}
          </PortalButton>
        </div>
      </form>
    </Card>
  );
}
