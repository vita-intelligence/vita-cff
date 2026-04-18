"use client";

import { AlertDialog, Button } from "@heroui/react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  MoreVertical,
  PlayCircle,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useRouter } from "@/i18n/navigation";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import type { OrganizationDto } from "@/services/organizations/types";
import {
  useDeleteFormulation,
  useUpdateFormulation,
  type ProjectStatus,
} from "@/services/formulations";


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
  projectStatus,
}: {
  organization: OrganizationDto;
  formulationId: string;
  projectStatus: ProjectStatus;
}) {
  const tProject = useTranslations("project_overview");

  const canEdit = hasFlatCapability(organization, "formulations", "edit");
  const canDelete = hasFlatCapability(organization, "formulations", "delete");

  return (
    <div className="flex items-center gap-2">
      <ProjectStatusMenu
        orgId={organization.id}
        formulationId={formulationId}
        status={projectStatus}
        canEdit={canEdit}
        tProject={tProject}
      />
      {canDelete ? (
        <MoreActionsMenu
          orgId={organization.id}
          formulationId={formulationId}
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
// Overflow menu — R&D status + delete
// ---------------------------------------------------------------------------


function MoreActionsMenu({
  orgId,
  formulationId,
  tProject,
}: {
  orgId: string;
  formulationId: string;
  tProject: ReturnType<typeof useTranslations<"project_overview">>;
}) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
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
          </div>
        ) : null}
      </div>

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
