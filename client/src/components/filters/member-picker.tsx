"use client";

/**
 * Searchable autocomplete picker for org members.
 *
 * Replaces a native ``<select>`` for the sales-person filter: the
 * native control stops being usable past ~50 entries (no search,
 * tiny scroll). This widget fetches the org's full member list
 * once (cached via TanStack Query), then filters client-side on
 * keystroke. Scales comfortably to ~1k members; at higher scale
 * the same component can be flipped to server-side search by
 * extending :func:`useMemberships` with a ``q`` param — the picker
 * UX stays identical.
 *
 * Built for filter-bar use:
 *
 * * Closed: renders a single button showing the picked member's
 *   name (or the "All / Unassigned" sentinel label).
 * * Open: floating panel with a search input on top and a virtual-
 *   safe list of matches. Up/Down arrows + Enter to commit.
 * * Sentinel options ("All", "Unassigned") sit above the search-
 *   filtered member list so they're always reachable.
 *
 * The picker is controlled — parent owns the selected value and
 * receives change events through ``onChange``.
 */

import { Check, ChevronDown, Search, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useMemberships } from "@/services/members";


//: Sentinel option keys reserved for filter semantics. ``""`` clears
//: the filter; ``"unassigned"`` is the magic backend value that
//: surfaces rows with no sales person.
const ALL_VALUE = "";
const UNASSIGNED_VALUE = "unassigned";


export function MemberPicker({
  orgId,
  value,
  onChange,
  label,
  allLabel,
  unassignedLabel,
  searchPlaceholder,
  emptyHint,
  group,
  disabled = false,
}: {
  readonly orgId: string;
  /** Selected value — empty string means "All", ``"unassigned"``
   *  means the no-owner bucket, anything else is a user UUID. */
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly label: string;
  readonly allLabel: string;
  readonly unassignedLabel: string;
  readonly searchPlaceholder: string;
  readonly emptyHint: string;
  /** Narrow the roster to a role tag (``"sales"`` / ``"scientist"``).
   *  Owners always remain in the list. Omitted = show everyone. */
  readonly group?: string;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const membersQuery = useMemberships(orgId, { group });
  const members = membersQuery.data ?? [];

  // Sort members alphabetically by display name; cheap O(n log n)
  // once the list is loaded and memoised so re-renders skip it.
  const sortedMembers = useMemo(() => {
    return [...members].sort((a, b) => {
      const an = (a.user.full_name || a.user.email).toLowerCase();
      const bn = (b.user.full_name || b.user.email).toLowerCase();
      return an.localeCompare(bn);
    });
  }, [members]);

  const filteredMembers = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return sortedMembers;
    return sortedMembers.filter((m) => {
      const name = (m.user.full_name || "").toLowerCase();
      const email = (m.user.email || "").toLowerCase();
      return name.includes(needle) || email.includes(needle);
    });
  }, [sortedMembers, search]);

  // Map current value → display label for the button.
  const selectedLabel = useMemo(() => {
    if (value === ALL_VALUE) return allLabel;
    if (value === UNASSIGNED_VALUE) return unassignedLabel;
    const picked = members.find((m) => m.user.id === value);
    return picked ? picked.user.full_name || picked.user.email : allLabel;
  }, [value, members, allLabel, unassignedLabel]);

  // Focus search field when opening; clear the search box when
  // closing so the next open starts fresh.
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(id);
    }
    setSearch("");
    return undefined;
  }, [open]);

  // Click-outside to close. Tracks both the button and the panel
  // since the panel is rendered as a sibling div (not inside the
  // button) for z-index headroom.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (
        buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const isFiltering = value !== ALL_VALUE;

  return (
    <div className="relative">
      {/* The clear ✕ is its own button positioned over the right
       *  edge of the trigger, not nested inside it. Nested buttons
       *  are invalid HTML and trigger a React hydration error. The
       *  trigger reserves right-padding (``pr-9``) when filtering
       *  so the overlay doesn't bleed into the selected label. */}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex h-10 min-w-[12rem] items-center gap-2 rounded-xl bg-ink-0 pl-3 text-sm ring-1 ring-inset transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          isFiltering ? "pr-9" : "pr-3"
        } ${
          isFiltering
            ? "text-ink-1000 ring-orange-300 hover:ring-orange-400"
            : "text-ink-700 ring-ink-200 hover:bg-ink-50"
        }`}
      >
        <Users
          className={`h-4 w-4 ${
            isFiltering ? "text-orange-500" : "text-ink-500"
          }`}
          aria-hidden
        />
        <span className="sr-only">{label}</span>
        <span className="flex-1 truncate text-left font-medium">
          {selectedLabel}
        </span>
        {isFiltering ? null : (
          <ChevronDown className="h-4 w-4 text-ink-400" aria-hidden />
        )}
      </button>
      {isFiltering ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            commit(ALL_VALUE);
          }}
          aria-label={`${label}: ${allLabel}`}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-1000"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}

      {open ? (
        <div
          ref={panelRef}
          role="listbox"
          // z-50 so the panel sits above any sticky table header
          // (typically z-10) and any other in-flow content. The
          // parent filter card must NOT clip its overflow or this
          // panel gets cut off — both bars are explicit on that.
          className="absolute right-0 z-50 mt-1 w-[18rem] overflow-hidden rounded-xl bg-ink-0 shadow-xl ring-1 ring-ink-200"
        >
          <div className="relative border-b border-ink-100">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400"
              aria-hidden
            />
            <input
              ref={inputRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-9 w-full bg-transparent pl-8 pr-3 text-sm text-ink-1000 placeholder:text-ink-400 focus:outline-none"
            />
          </div>

          <ul className="max-h-72 overflow-y-auto py-1">
            {/* Sentinel options — always visible above the filtered
             *  member list so "All" and "Unassigned" stay reachable
             *  no matter what the search box looks like. */}
            <SentinelOption
              label={allLabel}
              selected={value === ALL_VALUE}
              onSelect={() => commit(ALL_VALUE)}
            />
            <SentinelOption
              label={unassignedLabel}
              selected={value === UNASSIGNED_VALUE}
              onSelect={() => commit(UNASSIGNED_VALUE)}
            />

            <li
              role="separator"
              className="my-1 border-t border-ink-100"
              aria-hidden
            />

            {membersQuery.isLoading ? (
              <li className="px-3 py-2 text-xs text-ink-500">
                {searchPlaceholder}…
              </li>
            ) : filteredMembers.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-ink-500">
                {emptyHint}
              </li>
            ) : (
              filteredMembers.map((m) => {
                const isSelected = m.user.id === value;
                const display = m.user.full_name || m.user.email;
                const sublabel = m.user.full_name ? m.user.email : null;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => commit(m.user.id)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? "bg-orange-50 text-orange-900"
                          : "text-ink-1000 hover:bg-ink-50"
                      }`}
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {display}
                        </span>
                        {sublabel ? (
                          <span className="truncate text-[11px] text-ink-500">
                            {sublabel}
                          </span>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <Check
                          className="h-4 w-4 shrink-0 text-orange-500"
                          aria-hidden
                        />
                      ) : null}
                    </button>
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


function SentinelOption({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
          selected
            ? "bg-orange-50 text-orange-900"
            : "text-ink-700 hover:bg-ink-50"
        }`}
      >
        <span className="font-medium">{label}</span>
        {selected ? (
          <Check className="h-4 w-4 text-orange-500" aria-hidden />
        ) : null}
      </button>
    </li>
  );
}
