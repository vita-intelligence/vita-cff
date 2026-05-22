"use client";

import { Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import {
  swapDynamicsPrimaryContact,
  useCustomers,
  useDynamicsContactSearch,
  useImportCustomerFromDynamics,
  type CustomerDto,
  type DynamicsContactSuggestion,
} from "@/services/customers";


/**
 * Shared type-ahead customer picker used on the proposal + spec
 * create surfaces. Queries ``useCustomers`` with a debounced search
 * string; the caller is responsible for the "create new" escape
 * hatch (we emit ``onCreateNew`` so the host can mount its own
 * ``CustomerFormModal`` inside whatever dialog stack it's in).
 *
 * When the org has a Microsoft Dynamics integration configured, the
 * picker also queries Dataverse in parallel and surfaces contacts
 * tagged with a small "Dynamics" chip. Picking one fires the import
 * endpoint, which either reuses an existing local row keyed on
 * ``dynamics_id`` or creates a new local Customer mirroring the
 * Dataverse record — the host always sees a resolved local
 * :class:`CustomerDto`. Dynamics failures degrade silently to local-
 * only results so the picker never blocks the proposal flow.
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
  dynamicsManaged = false,
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
  //: When the org is Dynamics-managed (``OrganizationDto.dynamics_customers_managed``)
  //: every manual "Create new" affordance is hidden — the Dataverse
  //: import path is the only way new customers enter the system. The
  //: prop is opt-in (default false) so non-Dynamics call sites don't
  //: have to thread the flag through.
  dynamicsManaged?: boolean;
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
  const [importingId, setImportingId] = useState<string | null>(null);
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

  // Dynamics fetch fires whenever the picker is open so the user
  // sees Dataverse suggestions on first focus as well as while
  // typing. Empty query returns the most recently modified
  // contacts (real client) or the canned mock list — both useful
  // for "is the integration working" feedback. The hook caches
  // per-query so re-opening the picker on the same input is free.
  const dynamicsQuery = useDynamicsContactSearch(orgId, debounced, {
    enabled: open,
  });
  const dynamicsConfigured = Boolean(dynamicsQuery.data?.configured);
  const dynamicsSuggestions = dynamicsQuery.data?.results ?? [];
  // Hide Dynamics rows the user already has locally — every local
  // row carries its ``dynamics_id`` so the dedup is exact.
  const localDynamicsIds = new Set(
    matches.map((m) => m.dynamics_id).filter((id): id is string => Boolean(id)),
  );
  const visibleDynamicsSuggestions = dynamicsSuggestions.filter(
    (s) => !localDynamicsIds.has(s.dynamics_id),
  );

  const importMutation = useImportCustomerFromDynamics(orgId);
  const [importError, setImportError] = useState<string | null>(null);
  // When the import endpoint refuses with 409 ``account_already_linked``
  // we surface a modal so the operator can either swap the primary
  // contact on the existing customer or just open that customer
  // as-is. Modal state holds the originally-picked suggestion + the
  // existing customer's identifying info so the copy reads cleanly.
  const [accountLinkConflict, setAccountLinkConflict] = useState<
    | {
        readonly suggestion: DynamicsContactSuggestion;
        readonly existingCustomerId: string;
        readonly currentContactName: string;
        readonly currentContactEmail: string;
      }
    | null
  >(null);
  const [swapPending, setSwapPending] = useState(false);

  // Coarse "is anything pending" guard — used to lock the whole
  // dropdown while an import is in flight so a slow connection
  // doesn't tempt the user into rage-clicking other rows. The
  // per-row ``importingId`` is kept for the targeted spinner.
  const importPending = importingId !== null;

  const handlePickDynamics = async (contact: DynamicsContactSuggestion) => {
    // Guard against re-entry: a second click while an import is
    // still resolving used to spawn a parallel mutation, which on
    // slow internet meant several import POSTs racing for the same
    // contact and confusing the eventual outcome. Now only the
    // first click counts; subsequent clicks no-op.
    if (importPending) return;
    setImportingId(contact.dynamics_id);
    setImportError(null);
    try {
      const customer = await importMutation.mutateAsync(contact);
      onChange(customer);
      setOpen(false);
    } catch (err) {
      // ``account_already_linked`` 409 — the operator picked a
      // contact under an account that is already in their address
      // book with a different primary contact. Surface the
      // "swap?" modal instead of treating this as a generic
      // failure. The error payload carries the existing row's id +
      // the current primary contact's display info so the modal
      // can read cleanly.
      const apiError = err as {
        response?: {
          status?: number;
          data?: {
            code?: string;
            existing_customer_id?: string;
            current_contact_name?: string;
            current_contact_email?: string;
          };
        };
      };
      if (
        apiError?.response?.status === 409
        && apiError.response.data?.code === "account_already_linked"
        && apiError.response.data.existing_customer_id
      ) {
        setAccountLinkConflict({
          suggestion: contact,
          existingCustomerId:
            apiError.response.data.existing_customer_id,
          currentContactName:
            apiError.response.data.current_contact_name ?? "",
          currentContactEmail:
            apiError.response.data.current_contact_email ?? "",
        });
        return;
      }
      // Surface other failures inline rather than silently swallowing.
      // The previous "swallow and let them pick a local row" rule
      // assumed users with healthy connections; on flaky networks
      // the silent path turned into a rage-click loop with no
      // signal that anything went wrong. The dropdown stays open
      // so the user can retry or pick a local match.
      setImportError(
        err instanceof Error && err.message
          ? err.message
          : tCustomers("picker.dynamics_import_failed"),
      );
    } finally {
      setImportingId(null);
    }
  };

  const handleConfirmSwap = async () => {
    if (!accountLinkConflict || swapPending) return;
    setSwapPending(true);
    try {
      const customer = await swapDynamicsPrimaryContact(
        orgId,
        accountLinkConflict.existingCustomerId,
        accountLinkConflict.suggestion,
      );
      onChange(customer);
      setAccountLinkConflict(null);
      setOpen(false);
    } catch (err) {
      setImportError(
        err instanceof Error && err.message
          ? err.message
          : tCustomers("picker.dynamics_import_failed"),
      );
    } finally {
      setSwapPending(false);
    }
  };

  const handleOpenExistingFromConflict = () => {
    if (!accountLinkConflict) return;
    // Resolve the existing local row from the already-loaded
    // matches list when possible; otherwise we still close the
    // modal and let the operator search for it. The address-book
    // entry is reachable through the local search above.
    const found = matches.find(
      (m) => m.id === accountLinkConflict.existingCustomerId,
    );
    if (found) {
      onChange(found);
      setOpen(false);
    }
    setAccountLinkConflict(null);
  };

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
          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg bg-ink-0 shadow-lg ring-1 ring-ink-200">
            {/* Prominent inline banner the moment a Dynamics import
                starts. On a slow connection this is the only thing
                visible between click and resolved customer; without
                it users assumed their click hadn't registered and
                rage-clicked every row in turn. */}
            {importPending ? (
              <div className="flex items-center gap-2 border-b border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {tCustomers("picker.importing")}
              </div>
            ) : null}
            {importError ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"
              >
                <span>{importError}</span>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setImportError(null);
                  }}
                  className="text-[10px] uppercase tracking-wide hover:underline"
                >
                  {tCustomers("picker.dismiss")}
                </button>
              </div>
            ) : null}
            {matches.length === 0 &&
            visibleDynamicsSuggestions.length === 0 ? (
              <div className="flex flex-col gap-2 px-3 py-3 text-xs text-ink-500">
                <span>{tCustomers("picker.empty_results")}</span>
                {dynamicsManaged ? (
                  // Dynamics-managed orgs: no "Create new" affordance.
                  // The empty state instead nudges the user toward
                  // the Dataverse search above (when nothing matches
                  // there either, the only resolution is to add the
                  // contact in Dynamics directly).
                  <span className="text-[11px] text-ink-400">
                    {tCustomers("picker.dynamics_managed_hint")}
                  </span>
                ) : (
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
                )}
              </div>
            ) : (
              <>
                {matches.map((match) => (
                  <button
                    key={match.id}
                    type="button"
                    disabled={importPending}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (importPending) return;
                      onChange(match);
                      setOpen(false);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 border-b border-ink-100 px-3 py-2 text-left last:border-b-0 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-ink-0"
                  >
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-1000">
                      {match.company || match.name || "—"}
                      {match.dynamics_id ? (
                        <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-700">
                          {tCustomers("picker.dynamics_chip")}
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-ink-500">
                      {[match.name, match.email]
                        .filter((s) => s)
                        .join(" · ")}
                    </span>
                  </button>
                ))}

                {visibleDynamicsSuggestions.length > 0 ? (
                  <div className="border-t border-ink-200 bg-blue-50/30">
                    <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
                      {tCustomers("picker.dynamics_section")}
                    </div>
                    {visibleDynamicsSuggestions.map((suggestion) => {
                      const isImporting =
                        importingId === suggestion.dynamics_id;
                      // ``importPending`` greys every Dynamics row
                      // (including the unclicked ones) so the user
                      // can see the dropdown is busy, not unresponsive.
                      // The clicked row still keeps its own spinner via
                      // ``isImporting``.
                      return (
                        <button
                          key={`dyn-${suggestion.dynamics_id}`}
                          type="button"
                          disabled={importPending}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            void handlePickDynamics(suggestion);
                          }}
                          className="flex w-full flex-col items-start gap-0.5 border-b border-blue-100 px-3 py-2 text-left last:border-b-0 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-blue-50/30"
                        >
                          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-1000">
                            {suggestion.company ||
                              suggestion.name ||
                              "—"}
                            <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-700">
                              {tCustomers("picker.dynamics_chip")}
                            </span>
                            {isImporting ? (
                              <Loader2 className="h-3 w-3 animate-spin text-blue-700" />
                            ) : null}
                          </span>
                          <span className="text-xs text-ink-500">
                            {[suggestion.name, suggestion.email]
                              .filter((s) => s)
                              .join(" · ")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {dynamicsConfigured &&
                visibleDynamicsSuggestions.length === 0 &&
                !dynamicsQuery.isFetching ? (
                  <p className="border-t border-ink-100 px-3 py-1.5 text-[10px] text-ink-500">
                    {tCustomers("picker.dynamics_no_matches")}
                  </p>
                ) : null}

                {dynamicsManaged ? null : (
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
                )}
              </>
            )}
          </div>
        ) : null}
      </div>
      {hint ? (
        <p className="text-xs text-ink-500">{hint}</p>
      ) : null}
      {accountLinkConflict ? (
        <AccountAlreadyLinkedModal
          suggestion={accountLinkConflict.suggestion}
          currentContactName={accountLinkConflict.currentContactName}
          currentContactEmail={accountLinkConflict.currentContactEmail}
          swapPending={swapPending}
          onSwap={handleConfirmSwap}
          onOpenExisting={handleOpenExistingFromConflict}
          onCancel={() => setAccountLinkConflict(null)}
        />
      ) : null}
    </div>
  );
}


/**
 * Modal surfaced when the Dynamics import endpoint refuses with
 * ``409 account_already_linked``. The operator picked a contact
 * whose parent account is already linked to a local customer with
 * a *different* primary contact. The right resolution is rarely
 * "create a second local row" — it's "swap the primary contact on
 * the existing row" or "open the existing row as-is". This modal
 * surfaces both, plus a cancel.
 */
function AccountAlreadyLinkedModal({
  suggestion,
  currentContactName,
  currentContactEmail,
  swapPending,
  onSwap,
  onOpenExisting,
  onCancel,
}: {
  suggestion: DynamicsContactSuggestion;
  currentContactName: string;
  currentContactEmail: string;
  swapPending: boolean;
  onSwap: () => void;
  onOpenExisting: () => void;
  onCancel: () => void;
}) {
  const tCustomers = useTranslations("customers");
  const companyLabel = suggestion.company || tCustomers("picker.this_account");
  const currentLabel =
    currentContactName || currentContactEmail || tCustomers("picker.no_primary");
  const incomingLabel =
    suggestion.name || suggestion.email || suggestion.dynamics_id;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-1000/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-ink-200">
        <h2 className="text-base font-semibold text-ink-1000">
          {tCustomers("picker.account_already_linked_title")}
        </h2>
        <p className="mt-2 text-sm text-ink-700">
          {tCustomers("picker.account_already_linked_body", {
            company: companyLabel,
            current: currentLabel,
            incoming: incomingLabel,
          })}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={swapPending}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            {tCustomers("picker.account_already_linked_cancel")}
          </button>
          <button
            type="button"
            onClick={onOpenExisting}
            disabled={swapPending}
            className="rounded-lg px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
          >
            {tCustomers("picker.account_already_linked_open_existing")}
          </button>
          <button
            type="button"
            onClick={onSwap}
            disabled={swapPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {swapPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {tCustomers("picker.account_already_linked_swap")}
          </button>
        </div>
      </div>
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
