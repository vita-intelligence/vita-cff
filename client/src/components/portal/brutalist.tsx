/**
 * Brutalist primitives — refined.
 *
 * Same design language (stark black-on-white, hard borders, no
 * rounded corners, offset shadows) but tuned to read "deliberate"
 * rather than "raw":
 *
 * * Warm off-white background (``bg-paper`` = #faf8f4) rather
 *   than pure white so cards + the chrome have a subtle tonal
 *   contrast.
 * * Consistent shadow vocabulary: 3/3/0 for small chips, 6/6/0
 *   for cards, 10/10/0 for the page's centre-of-attention card.
 * * Typography rhythm: tighter heading tracking, more generous
 *   leading on body, dedicated ``Eyebrow`` style for the small
 *   uppercase metadata labels so we stop spelling out
 *   ``text-[10px] font-bold uppercase tracking-widest`` everywhere.
 * * ``PortalShell`` carries a real navbar — Proposals / Specs /
 *   Settings — with an ``active`` highlight so the customer
 *   always knows where they are.
 * * ``PageHeader`` standardises the (eyebrow → title → subtitle →
 *   actions) cluster every page repeats.
 */

import { CheckCircle2, ChevronLeft } from "lucide-react";

import { PortalInboxBell } from "@/components/portal/portal-inbox-bell";
import { PortalMobileDrawer } from "@/components/portal/portal-mobile-drawer";
import { PortalSignOutButton } from "@/components/portal/portal-sign-out-button";
import { PortalToastStack } from "@/components/portal/portal-toast-stack";

import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  ReactNode,
} from "react";


const VITA_LOGO_URL =
  "https://static.wixstatic.com/media/b33d89_9ee96412e6e04e0fbe376b8c4d69a290~mv2.png/v1/fill/w_760,h_146,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Vita%20Manufacture%20Logo%20-%20Website%20.png";


// ---------------------------------------------------------------------------
// Logo + shell
// ---------------------------------------------------------------------------


export function PortalLogo({ href = "/portal" }: { href?: string }) {
  return (
    <a
      href={href}
      className="inline-block focus:outline focus:outline-2 focus:outline-offset-4 focus:outline-black"
    >
      <img
        src={VITA_LOGO_URL}
        alt="Vita Manufacture"
        className="h-9 w-auto"
      />
    </a>
  );
}


// Kept permissive so legacy pages that still pass ``active="proposals"``
// etc. don't TS-error after the nav slim-down — those values just no
// longer match any rendered nav item, so nothing highlights (the
// deep-linked surfaces stay reachable, they're just not advertised
// as a top-level destination).
export type PortalNavSection =
  | "home"
  | "products"
  | "proposals"
  | "specs"
  | "cff"
  | "labels"
  | "settings";


// Slim global nav: Products is the customer's mental anchor ("where
// are my products?") and every action surface (proposals, specs,
// labels, requests) is now reachable via the per-product detail
// page. Settings stays for profile / password / avatar. New-project
// entry point lives as a CTA on the Products page so we don't need
// a "Requests" tab in the nav.
const NAV_ITEMS: ReadonlyArray<{
  readonly key: PortalNavSection;
  readonly href: string;
  readonly label: string;
}> = [
  { key: "products", href: "/portal/products", label: "Products" },
  { key: "settings", href: "/portal/settings", label: "Settings" },
];


export function PortalShell({
  children,
  active,
  minimal = false,
}: {
  children: ReactNode;
  /** Highlights the matching navbar link. Pass ``"home"`` on the
   *  ``/portal`` hub so no link lights up. */
  active?: PortalNavSection;
  /** Strip the chrome that depends on an authed session — the nav
   *  links + the inbox bell + the mobile-nav row + the toast
   *  stack. Use on pre-auth surfaces (login, forgot-password,
   *  reset, activate) where those affordances would 401 on every
   *  request OR confuse the visitor with a section nav they can't
   *  use until they sign in. Only the logo + the footer remain. */
  minimal?: boolean;
}) {
  return (
    <div className="min-h-dvh bg-paper text-black antialiased">
      <header className="sticky top-0 z-30 border-b-2 border-black bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <PortalLogo />
          {minimal ? null : (
            <div className="flex items-center gap-2 sm:gap-4">
              {/* Desktop inline nav — hidden below sm where the
                  hamburger-driven drawer takes over. */}
              <nav className="hidden items-center gap-1 sm:flex">
                {NAV_ITEMS.map((item) => {
                  const isActive = active === item.key;
                  return (
                    <a
                      key={item.key}
                      href={item.href}
                      className={`relative px-3 py-2 text-[11px] font-bold uppercase tracking-[0.2em] transition-colors ${
                        isActive
                          ? "text-black"
                          : "text-neutral-500 hover:text-black"
                      }`}
                    >
                      {item.label}
                      {isActive ? (
                        <span
                          aria-hidden="true"
                          className="absolute inset-x-3 bottom-1 h-0.5 bg-black"
                        />
                      ) : null}
                    </a>
                  );
                })}
              </nav>
              {/* The bell is the primary notification surface — kept
                  visible on every breakpoint. */}
              <PortalInboxBell />
              {/* Desktop-only sign-out (the drawer hosts its own
                  full-width sign-out CTA on mobile). Icon-only so it
                  doesn't crowd the bell + nav. */}
              <div className="hidden sm:block">
                <PortalSignOutButton />
              </div>
              {/* Mobile hamburger trigger — the drawer component
                  renders both the trigger and the slide-in panel. */}
              <PortalMobileDrawer items={NAV_ITEMS} active={active} />
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">{children}</main>
      {/* Global top-right toast stack — mounted at shell level so an
          incoming WS event surfaces regardless of which portal page
          the customer is on. Per-thread WSes (proposal / spec chat
          panels) push into the store; the stack renders them with
          the brutalist card treatment + auto-dismiss timer. Hidden
          on ``minimal`` (pre-auth) shells where there's no signed-in
          customer to receive thread events. */}
      {minimal ? null : <PortalToastStack />}
      <footer className="mt-16 border-t-2 border-black">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-3 px-6 py-6 text-[11px] uppercase tracking-[0.2em] text-neutral-700 sm:flex-row">
          <span>Vita Manufacture · vitamanufacture.co.uk</span>
          <span className="text-neutral-500">
            Customer portal · v1
          </span>
        </div>
      </footer>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------


export function H1({ children }: { children: ReactNode }) {
  return (
    <h1 className="font-black uppercase leading-[0.95] tracking-[-0.02em] text-3xl sm:text-4xl md:text-5xl">
      {children}
    </h1>
  );
}


export function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-black uppercase tracking-[-0.01em] text-xl mb-4">
      {children}
    </h2>
  );
}


export function P({ children }: { children: ReactNode }) {
  return (
    <p className="max-w-prose text-base leading-relaxed text-neutral-800 mb-4">
      {children}
    </p>
  );
}


export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-neutral-500">
      {children}
    </span>
  );
}


/**
 * Standardised page header — eyebrow + title + optional subtitle
 * and an actions slot on the right. Every page should start with
 * one of these so the visual rhythm at the top of each route is
 * identical.
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  back,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label?: string };
}) {
  return (
    <div className="mb-8 flex flex-col gap-3">
      {back ? (
        <a
          href={back.href}
          className="inline-flex w-fit items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-600 transition-colors hover:text-black"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          {back.label || "Back"}
        </a>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          {eyebrow ? (
            <div className="mb-2"><Eyebrow>{eyebrow}</Eyebrow></div>
          ) : null}
          <H1>{title}</H1>
          {subtitle ? (
            <p className="mt-3 max-w-2xl text-base leading-relaxed text-neutral-700">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-3">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------


export function Card({
  children,
  as: As = "div",
  className = "",
  hover = false,
  accent = false,
}: {
  children: ReactNode;
  as?: "div" | "article" | "section";
  className?: string;
  /** Subtle hover lift (use on clickable cards). */
  hover?: boolean;
  /** Inverted (black bg, white text) — used for hero / centre-of-
   *  attention cards on the dashboard. */
  accent?: boolean;
}) {
  const base = "relative border-2 border-black p-4 sm:p-6 md:p-7";
  // Mobile keeps a smaller 3/3 offset so the card doesn't read as
  // lopsided in a narrow column; sm+ steps back up to the full
  // 6/6 brutalist offset on larger viewports where the visual
  // weight has room to land.
  const colour = accent
    ? "bg-black text-white shadow-[3px_3px_0_#000] sm:shadow-[6px_6px_0_#000]"
    : "bg-white text-black shadow-[3px_3px_0_#000] sm:shadow-[6px_6px_0_#000]";
  const interactivity = hover
    ? "transition-transform duration-150 hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[5px_5px_0_#000] sm:hover:shadow-[8px_8px_0_#000] focus-within:-translate-x-[2px] focus-within:-translate-y-[2px] focus-within:shadow-[5px_5px_0_#000] sm:focus-within:shadow-[8px_8px_0_#000]"
    : "";
  return (
    <As className={`${base} ${colour} ${interactivity} ${className}`}>
      {children}
    </As>
  );
}


// ---------------------------------------------------------------------------
// Buttons + button-styled anchors
// ---------------------------------------------------------------------------


type BtnVariant = "primary" | "secondary" | "danger";

const VARIANT_CLASSES: Record<BtnVariant, string> = {
  primary: "bg-black text-white hover:bg-neutral-900",
  secondary: "bg-white text-black hover:bg-neutral-100",
  danger: "bg-red-700 text-white hover:bg-red-800",
};


function buttonClasses(variant: BtnVariant, size: "md" | "sm" = "md"): string {
  const sizing =
    size === "sm"
      ? "px-3 py-1.5 text-xs"
      : "px-5 py-2.5 text-sm";
  return [
    "inline-flex items-center justify-center gap-2 border-2 border-black",
    "font-bold uppercase tracking-widest shadow-[4px_4px_0_#000]",
    "transition-transform duration-100",
    "hover:-translate-x-[1px] hover:-translate-y-[1px] hover:shadow-[5px_5px_0_#000]",
    "active:translate-x-[2px] active:translate-y-[2px] active:shadow-[2px_2px_0_#000]",
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-[4px_4px_0_#000]",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black",
    sizing,
    VARIANT_CLASSES[variant],
  ].join(" ");
}


type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: "md" | "sm";
};

export function PortalButton({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: BtnProps) {
  return (
    <button
      className={`${buttonClasses(variant, size)} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}


type LinkBtnProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: BtnVariant;
  size?: "md" | "sm";
};

/** Anchor styled to match :class:`PortalButton` — use this for
 *  navigation actions so the keyboard semantics stay "this is a
 *  link" instead of "this is a button + onClick navigate". */
export function PortalLinkButton({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: LinkBtnProps) {
  return (
    <a className={`${buttonClasses(variant, size)} ${className}`} {...rest}>
      {children}
    </a>
  );
}


// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------


const FIELD_BASE =
  "w-full border-2 border-black bg-white px-4 py-3 font-medium text-base text-black placeholder:text-neutral-400 focus:outline-none focus:shadow-[4px_4px_0_#000] focus:-translate-x-[1px] focus:-translate-y-[1px] transition-transform duration-100";


type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
  error?: string;
};

export function PortalInput({
  label,
  hint,
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
        className={`${FIELD_BASE} ${className}`}
      />
      {hint && !error ? (
        <span className="mt-1.5 block text-[11px] text-neutral-600">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="mt-1.5 block text-[11px] font-bold uppercase tracking-wide text-red-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}


export function PortalTextarea({
  label,
  hint,
  error,
  className = "",
  id,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label?: string;
  hint?: string;
  error?: string;
}) {
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
        className={`${FIELD_BASE} ${className}`}
      />
      {hint && !error ? (
        <span className="mt-1.5 block text-[11px] text-neutral-600">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="mt-1.5 block text-[11px] font-bold uppercase tracking-wide text-red-700">
          {error}
        </span>
      ) : null}
    </label>
  );
}


// ---------------------------------------------------------------------------
// Pills + banners
// ---------------------------------------------------------------------------


/** Status palette + customer-facing label. Backend status codes
 *  are written from the Vita-team perspective ("we sent it") —
 *  that frame is wrong for the customer ("I received it, I need
 *  to do something"). We relabel here so the staff app isn't
 *  affected. */
const STATUS_PALETTE: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  draft:     { bg: "bg-white",      text: "text-black", label: "Draft" },
  in_review: { bg: "bg-yellow-200", text: "text-black", label: "In review" },
  approved:  { bg: "bg-blue-100",   text: "text-black", label: "Approved by Vita" },
  sent:      { bg: "bg-blue-100",   text: "text-black", label: "Action required" },
  signed:    { bg: "bg-black",      text: "text-white", label: "Signed" },
  accepted:  { bg: "bg-black",      text: "text-white", label: "Accepted" },
  rejected:  { bg: "bg-red-700",    text: "text-white", label: "Declined" },
  // CFF lifecycle_state values. Kept in the same palette so the
  // portal renders every workflow chip with one component.
  under_review:    { bg: "bg-yellow-200", text: "text-black", label: "Under review" },
  project_created: { bg: "bg-black",      text: "text-white", label: "Project created" },
  // RTG-track pending state. The customer has ordered off the
  // catalog and the drafted proposal is on our desk pending a
  // final send — visually amber so it reads as "in flight" rather
  // than "in review".
  awaiting_proposal: { bg: "bg-amber-200", text: "text-black", label: "Awaiting proposal" },
};


export function StatusPill({ status }: { status: string }) {
  // Sized to match a small ``PortalButton`` / the ``SignedChip``
  // so a header row of [download · status] reads as a balanced
  // pair. Same padding + text size + 3/3 shadow; no hover motion
  // because the pill isn't interactive.
  const palette = STATUS_PALETTE[status] || {
    bg: "bg-white",
    text: "text-black",
    label: status.replace(/_/g, " "),
  };
  return (
    <span
      className={`inline-flex items-center border-2 border-black px-3 py-1.5 text-xs font-bold uppercase tracking-widest shadow-[3px_3px_0_#000] ${palette.bg} ${palette.text}`}
    >
      {palette.label}
    </span>
  );
}


/** Inline "signed at" chip for document headers. Sized to match
 *  small ``PortalButton`` / ``PortalLinkButton`` so the two stack
 *  in a header row as a balanced pair. */
export function SignedChip({ at }: { at: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 border-2 border-black bg-black px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-white shadow-[3px_3px_0_#000]">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Signed{at ? ` · ${new Date(at).toLocaleDateString()}` : ""}
    </span>
  );
}


export function ErrorBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-6 border-2 border-black bg-yellow-200 px-4 py-3 text-sm font-bold uppercase tracking-wide shadow-[3px_3px_0_#000]">
      {children}
    </div>
  );
}


export function InfoBanner({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div className="border-2 border-black bg-white px-4 py-3 text-sm shadow-[3px_3px_0_#000]">
      {children}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------


export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card>
      <div className="flex flex-col items-start gap-4 py-6">
        <h3 className="text-xl font-black uppercase tracking-tight">
          {title}
        </h3>
        <p className="max-w-prose text-sm leading-relaxed text-neutral-700">
          {body}
        </p>
        {action ?? null}
      </div>
    </Card>
  );
}
