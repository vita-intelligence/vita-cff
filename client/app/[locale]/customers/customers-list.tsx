"use client";

import { Plus, Search, Trash2, Users } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";

import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useCreateCustomer,
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
 */
export function CustomersList({ orgId }: { orgId: string }) {
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
  const customers = customersQuery.data ?? [];

  const [editing, setEditing] = useState<CustomerDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <Button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          {tCustomers("add")}
        </Button>
      </header>

      <div className="mt-4 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={tCustomers("search_placeholder")}
            className="w-full rounded-lg bg-ink-0 pl-9 pr-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
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
                    <button
                      type="button"
                      onClick={() => setEditing(customer)}
                      className="text-sm font-medium text-ink-1000 hover:text-orange-700"
                    >
                      {customer.company || "—"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">
                    {customer.name || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">
                    {customer.email || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-ink-700">
                    {customer.phone || "—"}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm(tCustomers("actions.delete_confirm")))
                          return;
                        setError(null);
                        try {
                          await deleteMutation.mutateAsync(customer.id);
                        } catch (err) {
                          setError(extractErrorMessage(err, tErrors));
                        }
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-danger/10 hover:text-danger"
                      aria-label={tCustomers("actions.delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
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
      setError(extractErrorMessage(err, tErrors));
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


function extractErrorMessage(
  error: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (error instanceof ApiError) {
    for (const codes of Object.values(error.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}
