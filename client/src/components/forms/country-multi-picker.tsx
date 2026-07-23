"use client";

/**
 * Multi-select country picker with search.
 *
 * Trigger button shows the selected countries as chips (with an ×
 * per chip to remove) or a placeholder when the selection is empty.
 * Clicking the trigger opens a floating panel with a search input
 * and the filtered country list; every row is a checkbox row. Clicks
 * outside the panel close it. All ISO 3166-1 alpha-2 country codes
 * are searchable by both code and name — typing "GB" or "united"
 * both surface the United Kingdom.
 *
 * Used by the Setup tab's Target markets field so scientists don't
 * have to remember 2-char codes.
 */

import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { COUNTRIES, countryNameFor } from "@/lib/countries";


export interface CountryMultiPickerProps {
  /** Selected ISO 3166-1 alpha-2 codes. */
  readonly value: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  /** Optional id/aria-label pass-through for label association. */
  readonly ariaLabel?: string;
}


export function CountryMultiPicker({
  value,
  onChange,
  disabled = false,
  placeholder = "Add markets…",
  ariaLabel,
}: CountryMultiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Normalise selection to uppercase so a lower-case value from a
  // legacy payload still lights up the correct row + chip.
  const selected = useMemo(() => {
    const set = new Set<string>();
    for (const raw of value) {
      const code = String(raw || "")
        .trim()
        .toUpperCase();
      if (code) set.add(code);
    }
    return set;
  }, [value]);

  const filteredCountries = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q),
    );
  }, [query]);

  // Close on outside click. Uses ``mousedown`` (not ``click``) so the
  // panel closes before a click on a peer input steals focus.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (!(e.target instanceof Node)) return;
      if (!root.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus the search input when the panel opens so keyboard-first
  // operators can start typing immediately.
  useEffect(() => {
    if (open && searchRef.current) {
      searchRef.current.focus();
    }
  }, [open]);

  const toggle = (code: string) => {
    if (disabled) return;
    const upper = code.toUpperCase();
    const next = new Set(selected);
    if (next.has(upper)) {
      next.delete(upper);
    } else {
      next.add(upper);
    }
    onChange(Array.from(next));
  };

  const removeChip = (code: string) => {
    if (disabled) return;
    const next = new Set(selected);
    next.delete(code.toUpperCase());
    onChange(Array.from(next));
  };

  const clearAll = () => {
    if (disabled) return;
    onChange([]);
  };

  return (
    <div ref={rootRef} className="relative">
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-disabled={disabled}
        className={`mt-1 flex min-h-[42px] w-full flex-wrap items-center gap-1 rounded-xl bg-ink-0 px-3 py-2 text-left text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
      >
        {selected.size === 0 ? (
          <span className="text-ink-500">{placeholder}</span>
        ) : (
          Array.from(selected).map((code) => (
            <span
              key={code}
              className="inline-flex items-center gap-1 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-1000"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="font-mono text-[10px] text-ink-600">
                {code}
              </span>
              <span>{countryNameFor(code)}</span>
              {!disabled ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeChip(code);
                  }}
                  className="rounded-full p-0.5 hover:bg-ink-200"
                  aria-label={`Remove ${countryNameFor(code)}`}
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </span>
          ))
        )}
        <span className="ml-auto flex items-center gap-1 text-ink-500">
          {selected.size > 0 && !disabled ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                clearAll();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  clearAll();
                }
              }}
              className="rounded-md px-1 text-[10px] font-medium uppercase tracking-wide hover:bg-ink-100"
              aria-label="Clear all markets"
            >
              Clear
            </span>
          ) : null}
          <ChevronsUpDown className="h-4 w-4" aria-hidden />
        </span>
      </div>

      {open ? (
        // ``flex-col`` + ``min-h-0`` on the scrollable child is the
        // standard "make me scroll inside a bounded parent" pattern.
        // Previously the panel had ``overflow-hidden`` clipping a
        // fixed-height <ul> — the inner overflow-y-auto never fired
        // because the outer clip already hid the extra rows.
        <div className="absolute left-0 right-0 top-full z-30 mt-1 flex max-h-72 flex-col rounded-xl bg-ink-0 shadow-lg ring-1 ring-ink-200">
          <div className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-ink-500" />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by country name or ISO code…"
              className="w-full bg-transparent text-sm text-ink-1000 outline-none placeholder:text-ink-500"
              aria-label="Search countries"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded-full p-0.5 text-ink-500 hover:bg-ink-100"
                aria-label="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
          <ul
            role="listbox"
            aria-multiselectable="true"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1"
          >
            {filteredCountries.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-ink-500">
                No countries match &ldquo;{query}&rdquo;.
              </li>
            ) : (
              filteredCountries.map((country) => {
                const isSelected = selected.has(country.code);
                return (
                  <li
                    key={country.code}
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => toggle(country.code)}
                    className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${
                      isSelected
                        ? "bg-orange-50 text-ink-1000"
                        : "text-ink-900 hover:bg-ink-50"
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded ${
                        isSelected
                          ? "bg-orange-500 text-white"
                          : "bg-ink-0 ring-1 ring-inset ring-ink-300"
                      }`}
                      aria-hidden
                    >
                      {isSelected ? <Check className="h-3 w-3" /> : null}
                    </span>
                    <span className="font-mono text-[10px] text-ink-500">
                      {country.code}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {country.name}
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
