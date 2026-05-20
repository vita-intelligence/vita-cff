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
import { login } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";


export function PortalLoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      router.push("/portal");
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card as="section" className="max-w-xl">
      <H1>Sign in</H1>
      <P>Use the email Vita already has on file for you.</P>
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
        <PortalInput
          name="password"
          type="password"
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <PortalButton type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </PortalButton>
      </form>
      <div className="mt-6 border-t-2 border-black pt-4">
        <Link
          href="/portal/forgot-password"
          className="text-xs font-bold uppercase tracking-widest underline"
        >
          Forgot password →
        </Link>
      </div>
    </Card>
  );
}
