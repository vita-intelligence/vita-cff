"use client";

import { AlertDialog, Button, Modal } from "@heroui/react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  MoreVertical,
  Pencil,
  PlayCircle,
  Plus,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { translateCode } from "@/lib/errors/translate";
import { useMemberships } from "@/services/members";
import type { OrganizationDto } from "@/services/organizations/types";
import {
  useAssignSalesPerson,
  useDeleteFormulation,
  useUpdateFormulation,
  type ProjectStatus,
  type SalesPersonDto,
} from "@/services/formulations";


interface ApiFieldErrors {
  fieldErrors?: Record<string, unknown>;
}


//: Ordered so the dropdown reads top-to-bottom along the product
//: lifecycle rather than alphabetically.
const PROJECT_STATUSES: readonly ProjectStatus[] = [
  "concept",
  "in_development",
  "pilot",
  "approved",
  "discontinued",
] as const;


/**
 * Action cluster rendered on the compact project header: an
 * editable ``project_status`` pill and a More-actions menu that
 * currently hosts a Delete action.
 *
 * All writes run through existing service hooks. Capability gating
 * mirrors the backend — ``formulations.edit`` gates status edits,
 * ``formulations.delete`` gates the delete item. Owners bypass
 * both by design.
 */
export function ProjectHeaderActions({
  organization,
  formulationId,
  formulationCode,
  projectStatus,
  salesPerson,
}: {
  organization: OrganizationDto;
  formulationId: string;
  formulationCode: string;
  projectStatus: ProjectStatus;
  salesPerson: SalesPersonDto | null;
}) {
  const tProject = useTranslations("project_overview");

  const canEdit = hasFlatCapability(organization, "formulations", "edit");
  const canDelete = hasFlatCapability(organization, "formulations", "delete");
  const canAssignSales = hasFlatCapability(
    organization,
    "formulations",
    "assign_sales_person",
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SalesPersonMenu
        orgId={organization.id}
        formulationId={formulationId}
        salesPerson={salesPerson}
        canAssign={canAssignSales}
        tProject={tProject}
      />
      <ProjectStatusMenu
        orgId={organization.id}
        formulationId={formulationId}
        status={projectStatus}
        canEdit={canEdit}
        tProject={tProject}
      />
      {canEdit || canDelete ? (
        <MoreActionsMenu
          orgId={organization.id}
          formulationId={formulationId}
          formulationCode={formulationCode}
          canEdit={canEdit}
          canDelete={canDelete}
          tProject={tProject}
        />
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Project status (clickable pill + dropdown)
// ---------------------------------------------------------------------------


function ProjectStatusMenu({
  orgId,
  formulationId,
  status,
  canEdit,
  tProject,
}: {
  orgId: string;
  formulationId: string;
  status: ProjectStatus;
  canEdit: boolean;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(containerRef, () => setOpen(false));

  const update = useUpdateFormulation(orgId, formulationId);

  const style = projectStatusStyle(status);

  // Read-only fallback — preserves the previous visual so users
  // without edit permission still see the pill without an
  // interactive affordance.
  if (!canEdit) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${style.classes}`}
      >
        {style.icon}
        {tProject(`status.${status}` as "status.concept")}
      </span>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={update.isPending}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-opacity hover:opacity-90 disabled:opacity-60 ${style.classes}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {style.icon}
        {tProject(`status.${status}` as "status.concept")}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 flex w-56 flex-col gap-0.5 rounded-xl bg-ink-0 p-1.5 shadow-lg ring-1 ring-ink-200"
        >
          {PROJECT_STATUSES.map((value) => {
            const vStyle = projectStatusStyle(value);
            const isActive = value === status;
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={isActive}
                disabled={update.isPending}
                onClick={async () => {
                  setOpen(false);
                  if (isActive) return;
                  try {
                    await update.mutateAsync({ project_status: value });
                    // Refresh the server tree so the SSR-rendered
                    // header + overview pick up the new status
                    // without a manual reload.
                    router.refresh();
                  } catch {
                    // Swallow — the mutation's error state surfaces
                    // via the TanStack Query error; menu is already
                    // closed so we don't block the user.
                  }
                }}
                className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-ink-50 disabled:opacity-60 ${
                  isActive ? "font-semibold text-ink-1000" : "text-ink-700"
                }`}
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full ${vStyle.classes} ring-0`}
                >
                  {vStyle.icon}
                </span>
                <span className="flex-1">
                  {tProject(`status.${value}` as "status.concept")}
                </span>
                {isActive ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-ink-400" />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Sales person (commercial owner of the project)
// ---------------------------------------------------------------------------


function SalesPersonMenu({
  orgId,
  formulationId,
  salesPerson,
  canAssign,
  tProject,
}: {
  orgId: string;
  formulationId: string;
  salesPerson: SalesPersonDto | null;
  canAssign: boolean;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(containerRef, () => setOpen(false));

  // Fetch members on demand — there is no point holding the full
  // roster in cache for readers who cannot assign. The hook gates
  // itself on ``canAssign`` via the ``enabled`` field inside
  // ``useMemberships``; we mirror that here for safety.
  const membershipsQuery = useMemberships(orgId, { enabled: open && canAssign });

  const assign = useAssignSalesPerson(orgId, formulationId);

  // Sort members alphabetically by display name so the same person
  // is always in the same slot — users build muscle memory against
  // a stable list. Duplicate emails are not possible (the backend
  // enforces unique membership per user), but we still dedupe by
  // user id to harden against transient duplicates from concurrent
  // query refetches.
  const members = useMemo(() => {
    const rows = membershipsQuery.data ?? [];
    const seen = new Set<string>();
    const out: { id: string; name: string; email: string }[] = [];
    for (const row of rows) {
      if (seen.has(row.user.id)) continue;
      seen.add(row.user.id);
      const name =
        (row.user.full_name && row.user.full_name.trim()) || row.user.email;
      out.push({ id: row.user.id, name, email: row.user.email });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [membershipsQuery.data]);

  const pillLabel = salesPerson
    ? salesPerson.name
    : tProject("sales_person.unassigned");

  const pillClasses = salesPerson
    ? "bg-orange-50 text-orange-800 ring-orange-200"
    : "bg-ink-50 text-ink-600 ring-ink-200";

  // Read-only pill — no dropdown for users who lack the capability.
  if (!canAssign) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${pillClasses}`}
        title={
          salesPerson
            ? `${tProject("sales_person.label")}: ${salesPerson.name}`
            : tProject("sales_person.unassigned")
        }
      >
        <UserRound className="h-3.5 w-3.5" />
        {pillLabel}
      </span>
    );
  }

  const handleAssign = async (userId: string | null) => {
    setOpen(false);
    if (userId === (salesPerson?.id ?? null)) return;
    try {
      await assign.mutateAsync({ user_id: userId });
      router.refresh();
    } catch {
      // Error surfaces via the mutation; menu is already closed.
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={assign.isPending}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-opacity hover:opacity-90 disabled:opacity-60 ${pillClasses}`}
      >
        <UserRound className="h-3.5 w-3.5" />
        {pillLabel}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 flex w-72 flex-col gap-0.5 rounded-xl bg-ink-0 p-1.5 shadow-lg ring-1 ring-ink-200"
        >
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
              {tProject("sales_person.label")}
            </span>
            {salesPerson ? (
              <button
                type="button"
                onClick={() => handleAssign(null)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-ink-500 hover:bg-ink-50 hover:text-danger"
              >
                <X className="h-3 w-3" />
                {tProject("sales_person.clear")}
              </button>
            ) : null}
          </div>
          {membershipsQuery.isLoading ? (
            <p className="px-2 py-3 text-xs text-ink-500">
              {tProject("sales_person.loading")}
            </p>
          ) : members.length === 0 ? (
            <p className="px-2 py-3 text-xs text-ink-500">
              {tProject("sales_person.empty")}
            </p>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              {members.map((member) => {
                const isActive = member.id === salesPerson?.id;
                return (
                  <button
                    key={member.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    disabled={assign.isPending}
                    onClick={() => handleAssign(member.id)}
                    className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors hover:bg-ink-50 disabled:opacity-60 ${
                      isActive ? "bg-orange-50/60" : ""
                    }`}
                  >
                    <UserRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-400" />
                    <span className="flex min-w-0 flex-col">
                      <span
                        className={`truncate text-sm ${
                          isActive
                            ? "font-semibold text-ink-1000"
                            : "text-ink-800"
                        }`}
                      >
                        {member.name}
                      </span>
                      <span className="truncate text-[11px] text-ink-500">
                        {member.email}
                      </span>
                    </span>
                    {isActive ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Overflow menu — R&D status + delete
// ---------------------------------------------------------------------------


function MoreActionsMenu({
  orgId,
  formulationId,
  formulationCode,
  canEdit,
  canDelete,
  tProject,
}: {
  orgId: string;
  formulationId: string;
  formulationCode: string;
  canEdit: boolean;
  canDelete: boolean;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  //: Edit-code modal is lazy-mounted on open so its internal state
  //: (value, error) resets cleanly between invocations — closing the
  //: modal unmounts it, so the next "Edit code" click starts from
  //: the current ``formulationCode`` rather than a stale draft.
  const [isEditCodeOpen, setIsEditCodeOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(containerRef, () => setOpen(false));

  const deleteMutation = useDeleteFormulation(orgId);

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(formulationId);
      setIsDeleteOpen(false);
      router.push("/formulations");
    } catch {
      // Leave the dialog open so the user sees it didn't go through.
      // Reusable error surface lives on the delete confirmation body
      // — we read ``deleteMutation.error`` below to render it.
    }
  };

  return (
    <>
      <div ref={containerRef} className="relative">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full text-ink-500 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50 hover:text-ink-1000"
          aria-label={tProject("actions.more_actions")}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <MoreVertical className="h-4 w-4" />
        </button>
        {open ? (
          <div
            role="menu"
            className="absolute right-0 z-20 mt-2 flex w-64 flex-col gap-0.5 rounded-xl bg-ink-0 p-1.5 shadow-lg ring-1 ring-ink-200"
          >
            {canEdit ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setIsEditCodeOpen(true);
                }}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink-800 transition-colors hover:bg-ink-50"
              >
                <Pencil className="h-3.5 w-3.5 text-ink-500" />
                {tProject("actions.edit_code")}
              </button>
            ) : null}
            {canDelete ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setIsDeleteOpen(true);
                }}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-danger transition-colors hover:bg-danger/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {tProject("actions.delete_project")}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {isEditCodeOpen ? (
        <EditCodeDialog
          orgId={orgId}
          formulationId={formulationId}
          initialCode={formulationCode}
          onClose={() => setIsEditCodeOpen(false)}
          tProject={tProject}
        />
      ) : null}

      <AlertDialog
        isOpen={isDeleteOpen}
        onOpenChange={(open) => {
          if (!open) setIsDeleteOpen(false);
        }}
      >
        <AlertDialog.Backdrop>
          <AlertDialog.Container size="md">
            <AlertDialog.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 text-ink-1000 shadow-lg ring-1 ring-ink-200">
              <AlertDialog.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <AlertDialog.Heading className="text-base font-semibold text-ink-1000">
                  {tProject("delete.confirm_title")}
                </AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body className="flex flex-col gap-3 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tProject("delete.confirm_body")}
                </p>
                {deleteMutation.isError ? (
                  <p
                    role="alert"
                    className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {tProject("delete.generic_error")}
                  </p>
                ) : null}
              </AlertDialog.Body>
              <AlertDialog.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={() => setIsDeleteOpen(false)}
                  isDisabled={deleteMutation.isPending}
                >
                  {tProject("delete.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="md"
                  className="h-10 rounded-lg bg-danger px-4 text-sm font-medium text-ink-0 hover:bg-danger/90"
                  onClick={handleDelete}
                  isDisabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending
                    ? tProject("delete.deleting")
                    : tProject("delete.confirm_confirm")}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </>
  );
}


// ---------------------------------------------------------------------------
// Edit-code dialog (lives under the overflow menu)
// ---------------------------------------------------------------------------


/**
 * Minimal single-field modal for editing the project's ``code``.
 * Reuses ``useUpdateFormulation`` so the shared invalidation path
 * (detail, list, totals, overview) fires on success. Surfaces
 * ``formulation_code_conflict`` / ``formulation_code_required``
 * against the input so the scientist can fix the clash in place
 * without dropping out of the dialog.
 */
function EditCodeDialog({
  orgId,
  formulationId,
  initialCode,
  onClose,
  tProject,
}: {
  orgId: string;
  formulationId: string;
  initialCode: string;
  onClose: () => void;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const tErrors = useTranslations("errors");
  const tForms = useTranslations("formulations");

  const [value, setValue] = useState(initialCode);
  const [error, setError] = useState<string | null>(null);

  const update = useUpdateFormulation(orgId, formulationId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const trimmed = value.trim();
    if (!trimmed) {
      setError(translateCode(tErrors, "formulation_code_required"));
      return;
    }
    if (trimmed === initialCode) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync({ code: trimmed });
      onClose();
    } catch (err) {
      const fieldErrors = (err as ApiFieldErrors).fieldErrors ?? {};
      const firstKey = Object.keys(fieldErrors)[0];
      const firstCode =
        firstKey && Array.isArray(fieldErrors[firstKey])
          ? String((fieldErrors[firstKey] as string[])[0] ?? "")
          : "";
      setError(
        firstCode ? translateCode(tErrors, firstCode) : tErrors("generic"),
      );
    }
  };

  return (
    <Modal isOpen onOpenChange={(open) => (open ? null : onClose())}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog className="flex max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tProject("header.edit_code")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tForms("fields.code")}
                  </span>
                  <input
                    autoFocus
                    required
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={tForms("placeholders.code")}
                    maxLength={64}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </label>
                {error ? (
                  <p
                    role="alert"
                    className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
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
                  isDisabled={update.isPending}
                  className="rounded-lg px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  {tProject("header.edit_code_cancel")}
                </Button>
                <Button
                  type="submit"
                  isDisabled={update.isPending || !value.trim()}
                  className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-ink-0 hover:bg-orange-600"
                >
                  {tProject("header.edit_code_save")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function projectStatusStyle(status: ProjectStatus): {
  classes: string;
  icon: ReactNode;
} {
  switch (status) {
    case "concept":
      return {
        classes: "bg-ink-100 text-ink-700 ring-ink-200",
        icon: <Plus className="h-3.5 w-3.5" />,
      };
    case "in_development":
      return {
        classes: "bg-info/10 text-info ring-info/20",
        icon: <FlaskConical className="h-3.5 w-3.5" />,
      };
    case "pilot":
      return {
        classes: "bg-orange-50 text-orange-700 ring-orange-200",
        icon: <PlayCircle className="h-3.5 w-3.5" />,
      };
    case "approved":
      return {
        classes: "bg-success/10 text-success ring-success/20",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
      };
    case "discontinued":
      return {
        classes: "bg-danger/10 text-danger ring-danger/20",
        icon: <AlertTriangle className="h-3.5 w-3.5" />,
      };
  }
}


/**
 * Close a popover-style menu when the user clicks outside it.
 *
 * Scoped to mousedown rather than click so dragging out of the menu
 * (mousedown inside, mouseup outside) doesn't dismiss prematurely.
 * No touch handling — mobile taps fire mousedown just like clicks
 * on the platforms we support.
 */
function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  onOutside: () => void,
): void {
  useEffect(() => {
    const handle = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current && ref.current.contains(target)) return;
      onOutside();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [ref, onOutside]);
}
