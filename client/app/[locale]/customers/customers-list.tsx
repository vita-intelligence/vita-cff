"use client";

import {
  Info,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";

import { Link } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useCreateCustomer,
  useCreateCustomerPortalInvite,
  useCustomers,
  useDeleteCustomer,
  useUpdateCustomer,
  type CreateCustomerRequestDto,
  type CustomerDto,
} from "@/services/customers";


/**
 * Org customer address-book list. Debounced search + inline edit
 * modal. The same modal is reused by the proposal "Create new
 * customer" shortcut so adding a client in-flow doesn't lose the
 * scientist's place on the proposal creation screen.
 *
 * ``dynamicsManaged`` mirrors the backend ``is_dynamics_live`` flag
 * exposed on ``OrganizationDto.dynamics_customers_managed``. When
 * true we hide the "+ Add" CTA and surface a banner instead — every
 * customer for those orgs must flow through the Dynamics import
 * path so the local table never diverges from Dataverse. Edits stay
 * open because we have no auto-sync today, so a local tweak is an
 * explicit override, not a conflict.
 */
export function CustomersList({
  orgId,
  dynamicsManaged = false,
}: {
  orgId: string;
  dynamicsManaged?: boolean;
}) {
  const tCustomers = useTranslations("customers");
  const tErrors = useTranslations("errors");

  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const handle = setTimeout(
      () => setDebouncedSearch(searchInput.trim()),
      180,
    );
    return () => clearTimeout(handle);
  }, [searchInput]);

  const customersQuery = useCustomers(orgId, debouncedSearch);
  const deleteMutation = useDeleteCustomer(orgId);
  const inviteMutation = useCreateCustomerPortalInvite(orgId);
  const customers = customersQuery.data ?? [];

  const [editing, setEditing] = useState<CustomerDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Toast-style transient banner for the post-invite success state.
  // Lives at section level rather than per row so the operator
  // still sees it after we close the loading affordance — the row
  // refetches and re-renders, which would lose any row-scoped
  // state we tried to attach.
  const [inviteBanner, setInviteBanner] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);

  async function handleIssueInvite(customer: CustomerDto) {
    setError(null);
    setInviteBanner(null);
    try {
      const response = await inviteMutation.mutateAsync(customer.id);
      const url = response.activation_url;
      try {
        // ``navigator.clipboard`` requires a secure context (https or
        // localhost) — in dev that's the dev-server's localhost, in
        // prod the customers page is always behind https. If the
        // browser refuses the write we surface the raw URL in the
        // banner instead of silently failing.
        await navigator.clipboard.writeText(url);
        setInviteBanner({
          kind: "success",
          message: tCustomers("actions.invite_copied", {
            email: response.email_snapshot,
          }),
        });
      } catch {
        setInviteBanner({
          kind: "success",
          message: tCustomers("actions.invite_clipboard_failed", { url }),
        });
      }
    } catch (err) {
      setInviteBanner({
        kind: "error",
        message: extractApiErrorMessage(err, tErrors),
      });
    }
  }

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            {tCustomers("title")}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {tCustomers("subtitle")}
          </p>
        </div>
        {dynamicsManaged ? null : (
          <Button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
          >
            <Plus className="h-4 w-4" />
            {tCustomers("add")}
          </Button>
        )}
      </header>

      {dynamicsManaged ? (
        <div
          role="status"
          className="mt-4 flex items-start gap-2 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-900 ring-1 ring-inset ring-blue-200"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{tCustomers("dynamics_managed_banner")}</span>
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={tCustomers("search_placeholder")}
            className="w-full rounded-lg bg-ink-0 pl-9 pr-9 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
          {/* In-flight cue while the debounced query is running.
              ``isFetching`` (not ``isLoading``) so the spinner also
              fires on refetches triggered by a search edit, not
              just the cold first load. */}
          {customersQuery.isFetching ? (
            <Loader2
              aria-hidden
              className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-orange-500"
            />
          ) : null}
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </p>
      ) : null}

      {inviteBanner ? (
        <p
          role={inviteBanner.kind === "error" ? "alert" : "status"}
          className={
            "mt-4 rounded-xl px-3 py-2 text-sm font-medium ring-1 ring-inset " +
            (inviteBanner.kind === "success"
              ? "bg-success/10 text-success ring-success/20"
              : "bg-danger/10 text-danger ring-danger/20")
          }
        >
          {inviteBanner.message}
        </p>
      ) : null}

      {customersQuery.isLoading ? (
        <p className="mt-6 text-sm text-ink-500">
          {tCustomers("loading")}
        </p>
      ) : customers.length === 0 ? (
        <div className="mt-6 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
          <Users className="mx-auto h-6 w-6 text-ink-400" />
          <p className="mt-2 text-sm text-ink-500">
            {debouncedSearch
              ? tCustomers("empty_search")
              : tCustomers("empty")}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs font-medium uppercase tracking-wide text-ink-500">
                <th className="px-3 py-2">{tCustomers("columns.company")}</th>
                <th className="px-3 py-2">{tCustomers("columns.name")}</th>
                <th className="px-3 py-2">{tCustomers("columns.email")}</th>
                <th className="px-3 py-2">{tCustomers("columns.phone")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr
                  key={customer.id}
                  className="border-b border-ink-100 last:border-b-0 hover:bg-ink-50/60"
                >
                  <td className="px-3 py-2.5">
                    {/* Company name is now a route to the customer
                        detail page — the primary "drill in" path.
                        The old edit-on-click behaviour moved to the
                        pencil button on the right; discoverable from
                        the row and free from being conflated with
                        "open this customer". */}
                    <Link
                      href={`/customers/${customer.id}`}
                      className="text-sm font-medium text-ink-1000 hover:text-orange-700"
                    >
                      {customer.company || "—"}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">
                    <div className="flex items-center gap-2">
                      <span>{customer.name || "—"}</span>
                      {customer.has_portal_account ? (
                        <PortalAccountBadge
                          activated={customer.portal_account_activated}
                          tCustomers={tCustomers}
                        />
                      ) : null}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">
                    {customer.email || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">
                    {customer.phone || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Explicit Edit affordance. Company name on
                          the left now routes to the detail page —
                          the pencil is the dedicated edit path so
                          the two actions no longer conflict on the
                          same click target. */}
                      <button
                        type="button"
                        onClick={() => setEditing(customer)}
                        title={tCustomers("actions.edit")}
                        aria-label={tCustomers("actions.edit")}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-orange-50 hover:text-orange-700"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      {/* Portal-invite control. Three visible states:
                          - already activated → disabled (lock icon
                            on the right covers the same signal).
                          - pending / no portal row + has email → enabled
                            "Copy invite link" — staff issues + clipboard.
                          - no email → disabled with a tooltip pointing
                            the operator at the missing field. */}
                      <InvitePortalButton
                        customer={customer}
                        busy={
                          inviteMutation.isPending &&
                          inviteMutation.variables === customer.id
                        }
                        onIssue={handleIssueInvite}
                        tCustomers={tCustomers}
                      />
                      {customer.has_portal_account &&
                      customer.portal_account_activated ? (
                        // Active portal login — deleting would orphan
                        // their sessions + proposal / spec access.
                        // Lock the slot to keep the row layout stable
                        // and tooltip the reason so the operator knows
                        // what to do (revoke the login from the portal
                        // admin first).
                        <span
                          title={tCustomers(
                            "actions.delete_blocked_portal_account",
                          )}
                          aria-label={tCustomers(
                            "actions.delete_blocked_portal_account",
                          )}
                          className="inline-flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-md text-ink-300"
                        >
                          <Lock className="h-4 w-4" />
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={async () => {
                            if (
                              !confirm(tCustomers("actions.delete_confirm"))
                            )
                              return;
                            setError(null);
                            try {
                              await deleteMutation.mutateAsync(customer.id);
                            } catch (err) {
                              setError(extractApiErrorMessage(err, tErrors));
                            }
                          }}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-danger/10 hover:text-danger"
                          aria-label={tCustomers("actions.delete")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CustomerFormModal
        orgId={orgId}
        mode="create"
        isOpen={creating}
        onClose={() => setCreating(false)}
        initial={null}
      />
      <CustomerFormModal
        orgId={orgId}
        mode="edit"
        isOpen={editing !== null}
        onClose={() => setEditing(null)}
        initial={editing}
      />
    </section>
  );
}


/** Shared create/edit modal. Exported so the proposal picker's
 *  "Create new customer" shortcut can drop the same modal in-place
 *  without forcing a page navigation. */
export function CustomerFormModal({
  orgId,
  mode,
  isOpen,
  onClose,
  initial,
  onCreated,
}: {
  orgId: string;
  mode: "create" | "edit";
  isOpen: boolean;
  onClose: () => void;
  initial: CustomerDto | null;
  onCreated?: (customer: CustomerDto) => void;
}) {
  const tCustomers = useTranslations("customers");
  const tErrors = useTranslations("errors");
  const createMutation = useCreateCustomer(orgId);
  const updateMutation = useUpdateCustomer(orgId, initial?.id ?? "");

  const [form, setForm] = useState<CreateCustomerRequestDto>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setForm({
        name: initial.name,
        company: initial.company,
        email: initial.email,
        phone: initial.phone,
        invoice_address: initial.invoice_address,
        delivery_address: initial.delivery_address,
        notes: initial.notes,
      });
    } else {
      setForm({});
    }
    setError(null);
  }, [isOpen, initial]);

  const busy = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    try {
      if (mode === "create") {
        const created = await createMutation.mutateAsync(form);
        onCreated?.(created);
      } else if (initial) {
        await updateMutation.mutateAsync(form);
      }
      onClose();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  const bind =
    (key: keyof CreateCustomerRequestDto) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {mode === "create"
                    ? tCustomers("form.title_create")
                    : tCustomers("form.title_edit")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label={tCustomers("form.company")}>
                    <input
                      value={form.company ?? ""}
                      onChange={bind("company")}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </Field>
                  <Field label={tCustomers("form.name")}>
                    <input
                      value={form.name ?? ""}
                      onChange={bind("name")}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </Field>
                  <Field label={tCustomers("form.email")}>
                    <input
                      type="email"
                      value={form.email ?? ""}
                      onChange={bind("email")}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </Field>
                  <Field label={tCustomers("form.phone")}>
                    <input
                      value={form.phone ?? ""}
                      onChange={bind("phone")}
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </Field>
                </div>
                <Field label={tCustomers("form.invoice_address")}>
                  <textarea
                    rows={3}
                    value={form.invoice_address ?? ""}
                    onChange={bind("invoice_address")}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </Field>
                <Field label={tCustomers("form.delivery_address")}>
                  <textarea
                    rows={3}
                    value={form.delivery_address ?? ""}
                    onChange={bind("delivery_address")}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </Field>
                <Field label={tCustomers("form.notes")}>
                  <textarea
                    rows={2}
                    value={form.notes ?? ""}
                    onChange={bind("notes")}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </Field>
                {error ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={onClose}
                  isDisabled={busy}
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  {tCustomers("actions.cancel")}
                </Button>
                <Button
                  type="submit"
                  isDisabled={busy}
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                >
                  {tCustomers("actions.save")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {children}
    </label>
  );
}


/**
 * Inline chip on a customer row that signals "this customer has a
 * portal login". Two tonal states:
 *
 *   * ``activated`` — they've completed activation (set a
 *     password). Shown in success-tone (green) with a shield
 *     icon. The customer can sign in.
 *   * ``pending`` — an account row exists but ``activated_at``
 *     is still null. Shown in muted-tone (amber) — the team
 *     issued the activation link but the customer hasn't
 *     finished sign-up yet.
 *
 * Either way the row's delete affordance is locked, since the
 * client-portal FK ``on_delete=PROTECT`` would otherwise refuse
 * the delete deeper in the stack.
 */
/**
 * Per-row action that mints a new :class:`CustomerPortalInvite` and
 * copies the activation URL to the clipboard. Three visible states,
 * picked by the customer's portal-account flags + email:
 *
 * * Already activated (``portal_account_activated``) — rendered as a
 *   greyed-out icon with an explanatory tooltip. Clicking would 409
 *   server-side; we hide the action to avoid even surfacing the
 *   option.
 * * No email on the customer — same greyed-out icon, different
 *   tooltip pointing the operator at the missing field.
 * * Otherwise — enabled. Pending customers (``has_portal_account`` is
 *   true but ``activated`` is false) get an "re-issue" tooltip so a
 *   second click looks intentional rather than redundant.
 *
 * The actual clipboard write + banner live on the parent so the
 * post-success message survives the row re-render that the
 * mutation's cache invalidation triggers.
 */
function InvitePortalButton({
  customer,
  busy,
  onIssue,
  tCustomers,
}: {
  customer: CustomerDto;
  busy: boolean;
  onIssue: (customer: CustomerDto) => void | Promise<void>;
  tCustomers: ReturnType<typeof useTranslations<"customers">>;
}) {
  const hasEmail = Boolean(customer.email);
  const alreadyActivated =
    customer.has_portal_account && customer.portal_account_activated;

  if (alreadyActivated) {
    return (
      <span
        title={tCustomers("actions.invite_already_activated")}
        aria-label={tCustomers("actions.invite_already_activated")}
        className="inline-flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-md text-ink-300"
      >
        <Link2 className="h-4 w-4" />
      </span>
    );
  }

  if (!hasEmail) {
    return (
      <span
        title={tCustomers("actions.invite_no_email")}
        aria-label={tCustomers("actions.invite_no_email")}
        className="inline-flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-md text-ink-300"
      >
        <Link2 className="h-4 w-4" />
      </span>
    );
  }

  const label = customer.has_portal_account
    ? tCustomers("actions.invite_reissue")
    : tCustomers("actions.invite_open");

  return (
    <button
      type="button"
      onClick={() => void onIssue(customer)}
      disabled={busy}
      title={label}
      aria-label={label}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-orange-50 hover:text-orange-700 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Link2 className="h-4 w-4" />
      )}
    </button>
  );
}


function PortalAccountBadge({
  activated,
  tCustomers,
}: {
  activated: boolean;
  tCustomers: ReturnType<typeof useTranslations<"customers">>;
}) {
  const tone = activated
    ? "bg-success/10 text-success ring-success/30"
    : "bg-amber-100 text-amber-800 ring-amber-300";
  const label = activated
    ? tCustomers("portal_account.active")
    : tCustomers("portal_account.pending");
  const tooltip = activated
    ? tCustomers("portal_account.active_hint")
    : tCustomers("portal_account.pending_hint");
  return (
    <span
      title={tooltip}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${tone}`}
    >
      <ShieldCheck className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}
