"use client";

/**
 * Country picker for portal ship-to fields.
 *
 * Desktop (`sm+`) keeps the native `<select>` — well-tested, keyboardable,
 * and matches the rest of the brutalist form controls beat-for-beat.
 *
 * Mobile (`< sm`) swaps in a full-height bottom sheet with a sticky
 * search box + tap-to-select list. Native `<select>` on a 250-item
 * list scrolls forever on iOS/Android with no way to search — the
 * bottom sheet gives the same "one tap to open, one tap to pick"
 * feel as the OS-level pickers users are used to.
 *
 * State is single-source: `value` / `onChange` control both variants,
 * so the parent form treats this as a drop-in replacement for the
 * old `<select>`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";

import { COUNTRIES, findCountry } from "@/lib/iso/countries";

interface Props {
  readonly value: string;
  readonly onChange: (code: string) => void;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  /** Extra classes applied to the wrapper so the parent controls
   *  spacing (`mt-1.5` etc) without the component owning layout. */
  readonly className?: string;
}

export function CountryField({
  value,
  onChange,
  disabled,
  required,
  id,
  className,
}: Props) {
  return (
    <div className={className}>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        className="hidden w-full border-2 border-black bg-white px-3 py-2 text-sm outline-none sm:block"
      >
        <option value="">— select a country —</option>
        {COUNTRIES.map((c) => (
          <option key={c.code} value={c.code}>
            {c.flag} {c.name} ({c.code})
          </option>
        ))}
      </select>
      <div className="block sm:hidden">
        <MobileTrigger
          value={value}
          onChange={onChange}
          disabled={disabled}
          id={id}
        />
      </div>
    </div>
  );
}

function MobileTrigger({
  value,
  onChange,
  disabled,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = findCountry(value);
  return (
    <>
      <button
        id={id}
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-haspopup="dialog"
        className="flex w-full items-center justify-between gap-2 border-2 border-black bg-white px-3 py-2 text-left text-sm outline-none disabled:opacity-50"
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              <span className="mr-1.5" aria-hidden>
                {selected.flag}
              </span>
              <span className="font-semibold">{selected.name}</span>
              <span className="ml-1 text-neutral-500">({selected.code})</span>
            </>
          ) : (
            <span className="text-neutral-500">— select a country —</span>
          )}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
      </button>
      {open ? (
        <MobileSheet
          value={value}
          onSelect={(code) => {
            onChange(code);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function MobileSheet({
  value,
  onSelect,
  onClose,
}: {
  value: string;
  onSelect: (code: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Delay autofocus a tick so the sheet is mounted before iOS opens
  // the keyboard — otherwise the keyboard springs up mid-transition
  // and the sheet ends up mis-sized on some devices.
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Choose country"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[88dvh] w-full flex-col overflow-hidden border-t-2 border-l-2 border-r-2 border-black bg-white"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="shrink-0 border-b-2 border-black bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-neutral-700">
              Choose country
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="text-neutral-500 hover:text-black"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex items-center gap-2 border-2 border-black px-2.5 py-2">
            <Search className="h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or code…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-base outline-none"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="text-neutral-500"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>

        <ul
          className="min-h-0 flex-1 overflow-y-auto"
          role="listbox"
          aria-label="Countries"
        >
          {results.length === 0 ? (
            <li className="p-6 text-center text-sm text-neutral-500">
              No countries match “{query}”.
            </li>
          ) : (
            results.map((c) => {
              const active = c.code === value;
              return (
                <li key={c.code}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.code)}
                    role="option"
                    aria-selected={active}
                    className={`flex w-full items-center gap-3 border-b border-neutral-200 px-4 py-3 text-left text-sm hover:bg-neutral-100 ${
                      active ? "bg-orange-50" : ""
                    }`}
                  >
                    <span className="text-lg" aria-hidden>
                      {c.flag}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {c.name}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-neutral-500">
                      {c.code}
                    </span>
                    {active ? (
                      <Check className="h-4 w-4 shrink-0 text-black" aria-hidden />
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
