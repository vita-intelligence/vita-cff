"use client";

import { Button, Modal } from "@heroui/react";
import {
  Building2,
  Link2,
  Loader2,
  Mail,
  Search,
  UserRound,
  UserRoundPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useDebouncedValue } from "@/lib/utils/use-debounced-value";
import { useTranslations } from "next-intl";
import { useCustomers } from "@/services/customers";
import {
  useLinkCustomerToProject,
  useUnlinkCustomerFromProject,
  type ProjectOverviewDto,
} from "@/services/formulations";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";

//: Same debounce budget the CFF picker uses — short enough for a
//: decisive typist not to notice, long enough to swallow keystroke
//: chatter before we walk the customer index.
const CUSTOMER_SEARCH_DEBOUNCE_MS = 300;


/**
 * Project ⇢ Customer link card. Rendered on the formulation overview
 * next to :class:`ProjectWarningsCard`. One customer per project — a
 * fresh link overwrites in place; unlink clears back to nil.
 *
 * The card is deliberately its own component (rather than a row in
 * the warnings card) because customer assignment is a first-class
 * sales-track concern that PSP mirrors onto the CustomerOrder — not
 * a soft reminder. Missing customer isn't a warning, it's a state.
 */
export function ProjectCustomerCard({
  orgId,
  overview,
  canEdit,
}: {
  orgId: string;
  overview: ProjectOverviewDto;
  canEdit: boolean;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const tErrors = useTranslations("errors");

  const unlinkMutation = useUnlinkCustomerFromProject(orgId, overview.id);

  const linked = overview.linked_customer;

  const handleUnlink = async () => {
    setUnlinkError(null);
    try {
      await unlinkMutation.mutateAsync();
    } catch (err) {
      setUnlinkError(extractApiErrorMessage(err, tErrors));
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-1000">Customer</h2>
        <span className="text-xs text-ink-500">
          {linked ? "One customer per project" : "Link a client to this project"}
        </span>
      </div>

      {linked ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-ink-50 px-3 py-3 ring-1 ring-inset ring-ink-200">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex-none text-ink-600">
              <UserRound className="h-4 w-4" />
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-ink-1000">
                {linked.name || linked.company || "—"}
              </span>
              {linked.company && linked.company !== linked.name ? (
                <span className="inline-flex items-center gap-1 text-xs text-ink-700">
                  <Building2 className="h-3 w-3" />
                  {linked.company}
                </span>
              ) : null}
              {linked.email ? (
                <span className="inline-flex items-center gap-1 text-xs text-ink-500">
                  <Mail className="h-3 w-3" />
                  {linked.email}
                </span>
              ) : null}
            </div>
          </div>
          {canEdit ? (
            <div className="flex flex-none items-center gap-1">
              <span title="Swap the linked customer">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setModalOpen(true)}
                  className="rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Link2 className="h-3.5 w-3.5" />
                    Change
                  </span>
                </Button>
              </span>
              <button
                type="button"
                onClick={handleUnlink}
                disabled={unlinkMutation.isPending}
                title="Unlink customer"
                className="rounded-full p-1 text-ink-400 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
              >
                {unlinkMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sky-50 px-3 py-3 text-sky-950 ring-1 ring-inset ring-sky-200">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex-none text-sky-700">
              <UserRoundPlus className="h-4 w-4" />
            </span>
            <div className="flex flex-col">
              <span className="text-sm font-semibold">
                No customer linked yet
              </span>
              <span className="text-xs text-ink-700">
                Attach a client so PSP&rsquo;s kanban and the proposal team
                know who this project is for.
              </span>
            </div>
          </div>
          {canEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setModalOpen(true)}
              className="rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            >
              <span className="inline-flex items-center gap-1.5">
                <Link2 className="h-3.5 w-3.5" />
                Link customer
              </span>
            </Button>
          ) : null}
        </div>
      )}

      {unlinkError ? (
        <p
          role="alert"
          className="rounded-lg bg-danger/10 px-2 py-1 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {unlinkError}
        </p>
      ) : null}

      {modalOpen ? (
        <LinkCustomerModal
          orgId={orgId}
          formulationId={overview.id}
          currentCustomerId={linked?.id ?? null}
          onClose={() => setModalOpen(false)}
        />
      ) : null}
    </section>
  );
}


/**
 * Search-and-pick modal. Reuses the existing ``fetchCustomers``
 * endpoint (server-side search on ``name`` / ``company`` / ``email``).
 * Skips infinite scroll — the customers list is typically small enough
 * that a single fetch covers the picker; we cap it visually in a
 * scrollable pane just in case.
 */
function LinkCustomerModal({
  orgId,
  formulationId,
  currentCustomerId,
  onClose,
}: {
  orgId: string;
  formulationId: string;
  currentCustomerId: string | null;
  onClose: () => void;
}) {
  const tErrors = useTranslations("errors");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(
    search,
    CUSTOMER_SEARCH_DEBOUNCE_MS,
  );
  const [error, setError] = useState<string | null>(null);

  const trimmed = debouncedSearch.trim();
  const query = useCustomers(orgId, trimmed);

  const rows = useMemo(() => query.data ?? [], [query.data]);
  const link = useLinkCustomerToProject(orgId, formulationId);

  const handleLink = async (customerId: string) => {
    setError(null);
    try {
      await link.mutateAsync(customerId);
      onClose();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  return (
    <Modal
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                Link a customer
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex max-h-[70vh] flex-col gap-4 overflow-hidden px-6 py-6">
              <p className="text-sm text-ink-500">
                Pick a client from the address book. Swaps the existing
                link if there is one.
              </p>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search name, company, or email"
                  className={`${INPUT_CLASS} pl-9`}
                />
              </div>

              <div className="flex-1 overflow-y-auto rounded-xl bg-ink-50 ring-1 ring-inset ring-ink-200">
                {query.isLoading ? (
                  <div className="flex items-center justify-center py-10 text-sm text-ink-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Loading customers…
                  </div>
                ) : rows.length === 0 ? (
                  <div className="py-10 text-center text-sm text-ink-500">
                    {trimmed
                      ? "No matches for that search."
                      : "No customers yet — add one on the Customers page first."}
                  </div>
                ) : (
                  <ul className="divide-y divide-ink-200">
                    {rows.map((c) => {
                      const isCurrent = c.id === currentCustomerId;
                      return (
                        <li
                          key={c.id}
                          className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-0"
                        >
                          <div className="flex min-w-0 flex-col">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-medium text-ink-1000">
                                {c.name || c.company || c.email || c.id}
                              </span>
                              {isCurrent ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-900 ring-1 ring-inset ring-emerald-200">
                                  Linked
                                </span>
                              ) : null}
                            </div>
                            {c.company && c.company !== c.name ? (
                              <span className="truncate text-xs text-ink-600">
                                {c.company}
                              </span>
                            ) : null}
                            {c.email ? (
                              <span className="truncate text-xs text-ink-500">
                                {c.email}
                              </span>
                            ) : null}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleLink(c.id)}
                            isDisabled={link.isPending || isCurrent}
                            className="flex-none rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-60"
                          >
                            {isCurrent ? "Linked" : "Link"}
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {error}
                </p>
              ) : null}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
