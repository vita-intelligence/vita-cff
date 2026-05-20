"use client";

import { useState } from "react";

import {
  Card,
  ErrorBanner,
  H2,
  PortalButton,
  PortalInput,
  PortalTextarea,
} from "@/components/portal/brutalist";
import { updateProfile } from "@/services/portal/api";
import { portalErrorMessage } from "@/services/portal/errors";
import type { PortalProfileDto } from "@/services/portal/types";


/**
 * Contact + address fields the customer can edit directly. Email
 * lives in its own card because the verification dance breaks
 * the "submit and forget" pattern.
 */
export function ProfileSection({
  initial,
}: {
  initial: PortalProfileDto;
}) {
  const [profile, setProfile] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [company, setCompany] = useState(initial.company);
  const [phone, setPhone] = useState(initial.phone);
  const [invoiceAddress, setInvoiceAddress] = useState(initial.invoice_address);
  const [deliveryAddress, setDeliveryAddress] = useState(initial.delivery_address);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus("saving");
    try {
      const updated = await updateProfile({
        name,
        company,
        phone,
        invoice_address: invoiceAddress,
        delivery_address: deliveryAddress,
      });
      setProfile(updated);
      setStatus("saved");
      // Reset the "Saved" pill after a short beat so the button
      // doesn't claim victory forever.
      setTimeout(() => setStatus("idle"), 2_000);
    } catch (err: unknown) {
      setError(portalErrorMessage(err));
      setStatus("idle");
    }
  }

  return (
    <Card as="section">
      <H2>Your details</H2>
      <ErrorBanner>{error}</ErrorBanner>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <PortalInput
            name="name"
            label="Contact name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
          <PortalInput
            name="company"
            label="Company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            autoComplete="organization"
          />
          <PortalInput
            name="phone"
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
        </div>
        <PortalTextarea
          name="invoice_address"
          label="Invoice address"
          rows={3}
          value={invoiceAddress}
          onChange={(e) => setInvoiceAddress(e.target.value)}
          autoComplete="street-address"
        />
        <PortalTextarea
          name="delivery_address"
          label="Delivery address"
          rows={3}
          value={deliveryAddress}
          onChange={(e) => setDeliveryAddress(e.target.value)}
          autoComplete="street-address"
        />
        <div className="flex items-center gap-3">
          <PortalButton type="submit" disabled={status === "saving"}>
            {status === "saving" ? "Saving…" : "Save changes"}
          </PortalButton>
          {status === "saved" ? (
            <span className="text-[11px] font-bold uppercase tracking-widest">
              Saved ✓
            </span>
          ) : null}
        </div>
        <p className="mt-2 text-[11px] uppercase tracking-widest text-neutral-600">
          Customer id: {profile.customer_id}
        </p>
      </form>
    </Card>
  );
}
