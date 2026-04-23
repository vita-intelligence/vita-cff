"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { useCustomers, type CustomerDto } from "@/services/customers";


/**
 * Shared type-ahead customer picker used on the proposal + spec
 * create surfaces. Queries ``useCustomers`` with a debounced search
 * string; the caller is responsible for the "create new" escape
 * hatch (we emit ``onCreateNew`` so the host can mount its own
 * ``CustomerFormModal`` inside whatever dialog stack it's in).
 *
 * Why this lives here instead of inside the first page that used it:
 * the proposal and spec create modals need the same behaviour
 * verbatim — search for a client by name/company/email, fall back
 * to "create new" when they're not on file yet — so duplicating the
 * component would mean the two surfaces drift (different placeholder
 * copy, different debounce, different empty-state action). One
 * shared component keeps them in lockstep.
 */
export function CustomerPicker({
  orgId,
  value,
  onChange,
  onCreateNew,
  label,
  hint,
}: {
  orgId: string;
  value: CustomerDto | null;
  onChange: (customer: CustomerDto | null) => void;
  onCreateNew: () => void;
  //: Optional overrides so host surfaces can phrase the label to
  //: match their context ("Customer" on a proposal, "Client" on a
  //: spec sheet). Defaults to the canonical ``customers.picker.*``
  //: strings when omitted.
  label?: string;
  hint?: string;
}) {
  const tCustomers = useTranslations("customers");

  // ``searchInput`` is what the user sees in the field; ``debounced``
  // drives the API query so we don't hammer the server on every
  // keystroke.
  const [searchInput, setSearchInput] = useState(
    value ? labelForCustomer(value) : "",
  );
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(searchInput.trim()), 200);
    return () => clearTimeout(h);
  }, [searchInput]);

  // Keep the input in sync with the "selected" value so picking a
  // customer then reopening the picker doesn't show a stale typed
  // search string.
  useEffect(() => {
    setSearchInput(value ? labelForCustomer(value) : "");
  }, [value]);

  const customersQuery = useCustomers(orgId, debounced);
  const matches = customersQuery.data ?? [];

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-700">
        {label ?? tCustomers("picker.label")}
      </span>
      <div className="relative">
        <input
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setOpen(true);
            if (value !== null) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            // Delay so an onMouseDown on a result has a chance to
            // fire before the list closes.
            setTimeout(() => setOpen(false), 120);
          }}
          placeholder={tCustomers("picker.placeholder")}
          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-ink-500 hover:text-ink-1000"
          >
            {tCustomers("picker.clear")}
          </button>
        ) : null}
        {open ? (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg bg-ink-0 shadow-lg ring-1 ring-ink-200">
            {matches.length === 0 ? (
              <div className="flex flex-col gap-2 px-3 py-3 text-xs text-ink-500">
                <span>{tCustomers("picker.empty_results")}</span>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    onCreateNew();
                  }}
                  className="self-start text-orange-700 hover:text-orange-900"
                >
                  {tCustomers("picker.create_new")}
                </button>
              </div>
            ) : (
              <>
                {matches.map((match) => (
                  <button
                    key={match.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onChange(match);
                      setOpen(false);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 border-b border-ink-100 px-3 py-2 text-left last:border-b-0 hover:bg-ink-50"
                  >
                    <span className="text-sm font-medium text-ink-1000">
                      {match.company || match.name || "—"}
                    </span>
                    <span className="text-xs text-ink-500">
                      {[match.name, match.email]
                        .filter((s) => s)
                        .join(" · ")}
                    </span>
                  </button>
                ))}
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setOpen(false);
                    onCreateNew();
                  }}
                  className="flex w-full items-center gap-2 border-t border-ink-200 px-3 py-2 text-xs font-medium text-orange-700 hover:bg-orange-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {tCustomers("picker.create_new")}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
      {hint ? (
        <p className="text-xs text-ink-500">{hint}</p>
      ) : null}
    </div>
  );
}


/** Preferred display label for a customer — company first so the
 *  picker reads well against the "B2B supplement brand" context
 *  scientists mostly deal with, then falls back to the contact
 *  person's name, then email. Kept exported so callers can show the
 *  same label outside the picker (e.g. in a list of recent picks). */
export function labelForCustomer(customer: CustomerDto): string {
  return customer.company || customer.name || customer.email || "—";
}
