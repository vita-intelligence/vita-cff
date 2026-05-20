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
import { confirmPasswordReset } from "@/services/portal/api";


export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
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
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      router.push("/portal");
    } catch (err: unknown) {
      const e = err as {
        response?: { data?: { code?: string; messages?: string[] } };
      };
      const code = e.response?.data?.code;
      if (code === "weak_password") {
        setError(
          (e.response?.data?.messages || ["Password is too weak."]).join(" "),
        );
      } else if (code === "invalid_or_expired_token") {
        setError("This reset link is no longer valid. Request a new one.");
      } else {
        setError("Something went wrong. Try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <H1>Choose a new password</H1>
      <P>The link expires 30 minutes after it was sent.</P>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
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
        <PortalButton type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save new password"}
        </PortalButton>
      </form>
    </Card>
  );
}
