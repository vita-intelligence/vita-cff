/**
 * Brutalist primitives for the customer portal.
 *
 * One file, one design language. Stark black-on-white, no rounded
 * corners, 2px solid borders, offset hard shadows. The goal is a
 * visual identity that is intentionally distinct from the rest of
 * the staff UI — the portal must look like a different product so
 * a customer hopping from vitamanufacture.co.uk to here feels at
 * home, not like they've landed in someone's internal admin tool.
 *
 * Why one file rather than per-component: the surface area is
 * small (button, input, card, logo, heading) and these
 * primitives are tightly coupled to one another's styling
 * decisions (border thickness, shadow offset). Co-locating
 * prevents drift.
 */

import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";

const VITA_LOGO_URL =
  "https://static.wixstatic.com/media/b33d89_9ee96412e6e04e0fbe376b8c4d69a290~mv2.png/v1/fill/w_760,h_146,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Vita%20Manufacture%20Logo%20-%20Website%20.png";


export function PortalLogo({ href = "/portal" }: { href?: string }) {
  return (
    <a
      href={href}
      className="inline-block focus:outline focus:outline-2 focus:outline-offset-2 focus:outline-black"
    >
      <img
        src={VITA_LOGO_URL}
        alt="Vita Manufacture"
        className="h-10 w-auto"
      />
    </a>
  );
}


export function PortalShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-white text-black antialiased">
      <header className="border-b-2 border-black bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <PortalLogo />
          <span className="text-[11px] font-bold uppercase tracking-[0.2em]">
            Customer portal
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      <footer className="border-t-2 border-black">
        <div className="mx-auto max-w-5xl px-6 py-6 text-[11px] uppercase tracking-[0.2em]">
          Vita Manufacture · vitamanufacture.co.uk
        </div>
      </footer>
    </div>
  );
}


export function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="font-black uppercase leading-none tracking-tight text-5xl mb-6">
      {children}
    </h1>
  );
}


export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-black uppercase tracking-tight text-2xl mb-4">
      {children}
    </h2>
  );
}


export function P({ children }: { children: ReactNode }) {
  return <p className="text-base leading-relaxed mb-4">{children}</p>;
}


export function Card({
  children,
  as: As = "div",
  className = "",
}: {
  children: ReactNode;
  as?: "div" | "article" | "section";
  className?: string;
}) {
  return (
    <As
      className={`border-2 border-black bg-white p-6 shadow-[6px_6px_0_#000] ${className}`}
    >
      {children}
    </As>
  );
}


type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
};

export function PortalButton({
  variant = "primary",
  className = "",
  children,
  ...rest
}: BtnProps) {
  const base =
    "inline-flex items-center justify-center border-2 border-black px-6 py-3 font-bold uppercase tracking-wider text-sm shadow-[4px_4px_0_#000] transition-transform active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_#000] disabled:cursor-not-allowed disabled:opacity-50";
  const variants = {
    primary: "bg-black text-white hover:bg-neutral-800",
    secondary: "bg-white text-black hover:bg-neutral-100",
  };
  return (
    <button
      className={`${base} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}


type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  error?: string;
};

export function PortalInput({
  label,
  error,
  className = "",
  id,
  ...rest
}: InputProps) {
  const inputId = id || rest.name;
  return (
    <label htmlFor={inputId} className="block">
      {label ? (
        <span className="mb-2 block text-xs font-bold uppercase tracking-widest">
          {label}
        </span>
      ) : null}
      <input
        id={inputId}
        {...rest}
        className={`w-full border-2 border-black bg-white px-4 py-3 font-medium text-base focus:outline-none focus:shadow-[4px_4px_0_#000] focus:translate-x-[-2px] focus:translate-y-[-2px] transition-transform ${className}`}
      />
      {error ? (
        <span className="mt-2 block text-xs font-bold uppercase tracking-wide text-red-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}


export function PortalTextarea({
  label,
  error,
  className = "",
  id,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; error?: string }) {
  const inputId = id || rest.name;
  return (
    <label htmlFor={inputId} className="block">
      {label ? (
        <span className="mb-2 block text-xs font-bold uppercase tracking-widest">
          {label}
        </span>
      ) : null}
      <textarea
        id={inputId}
        {...rest}
        className={`w-full border-2 border-black bg-white px-4 py-3 font-medium text-base focus:outline-none focus:shadow-[4px_4px_0_#000] focus:translate-x-[-2px] focus:translate-y-[-2px] transition-transform ${className}`}
      />
      {error ? (
        <span className="mt-2 block text-xs font-bold uppercase tracking-wide text-red-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}


export function StatusPill({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center border-2 border-black bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest">
      {status.replace(/_/g, " ")}
    </span>
  );
}


export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-6 border-2 border-black bg-yellow-200 px-4 py-3 text-sm font-bold uppercase tracking-wide">
      {children}
    </div>
  );
}
