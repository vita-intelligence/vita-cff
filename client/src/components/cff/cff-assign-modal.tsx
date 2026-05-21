"use client";

import { CheckCircle2, Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useAssignCFFToProject,
  useCFFSubmission,
  useUnassignCFF,
  type CFFAssignmentDto,
  type CFFSubmissionDto,
} from "@/services/cff-submissions";
import { useInfiniteFormulations } from "@/services/formulations";


type Banner =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | null;


/**
 * Modal for managing a CFF's project links.
 *
 * Under the many-to-many model a single CFF can be wired to any
 * number of projects, so the modal stays in one mode at all times:
 *
 * * **Top half** lists every project the CFF is currently linked
 *   to (one chip per :class:`CFFAssignmentDto`), each with an
 *   inline detach control. Empty when the CFF is still in triage.
 * * **Bottom half** is the project picker — same fuzzy match the
 *   project page filter uses, via :func:`useInfiniteFormulations`.
 *   Submitting *adds* a link rather than replacing the existing
 *   set, mirroring the additive ``assign_to_project`` service
 *   behaviour on the backend.
 *
 * Detach is per-link and independent of the picker so an operator
 * can re-route a CFF — drop the wrong link, attach the right one —
 * without leaving the dialog.
 */
export function CFFAssignModal({
  orgId,
  submission: initialSubmission,
  onClose,
}: {
  orgId: string;
  submission: CFFSubmissionDto;
  onClose: () => void;
}) {
  const t = useTranslations("cff.assign");
  const tErrors = useTranslations("errors");

  // Subscribe to the detail query so the modal re-renders when the
  // assign / unassign mutations seed the cache with the freshly-
  // serialised row. The caller passes in the row they already hold
  // (from the inbox list) as ``initialData`` so the modal paints
  // instantly — the live query just keeps the assignment chips in
  // sync after each mutation.
  const submissionQuery = useCFFSubmission(orgId, initialSubmission.id, {
    initialData: initialSubmission,
  });
  const submission: CFFSubmissionDto = submissionQuery.data ?? initialSubmission;

  const assignMutation = useAssignCFFToProject(orgId);
  const unassignMutation = useUnassignCFF(orgId);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [banner, setBanner] = useState<Banner>(null);
  // Tracks which (CFF, project) link is currently being detached so
  // the chip can swap its X icon for a spinner. ``null`` when no
  // detach is in flight. Per-row rather than a global flag because
  // we don't want every chip's button to grey out when one is
  // mid-request.
  const [detachingProjectId, setDetachingProjectId] = useState<string | null>(
    null,
  );

  const isBusy =
    assignMutation.isPending || unassignMutation.isPending;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isBusy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  const projectsQuery = useInfiniteFormulations(orgId, {
    ordering: "name",
    pageSize: 50,
    search: search.trim() || undefined,
  });

  // Filter out projects the CFF is already linked to — re-attaching
  // the same pair is a no-op server-side, but surfacing it in the
  // picker would imply otherwise. The backend's idempotent
  // ``get_or_create`` is the safety net, this is just UX hygiene.
  const linkedProjectIds = useMemo(
    () => new Set(submission.assignments.map((a) => a.project.id)),
    [submission.assignments],
  );

  const projectRows = useMemo(() => {
    const pages = projectsQuery.data?.pages ?? [];
    return pages
      .flatMap((page) => page.results ?? [])
      .filter((row) => !linkedProjectIds.has(row.id));
  }, [projectsQuery.data, linkedProjectIds]);

  const handleAssign = async () => {
    if (!selectedProjectId) return;
    setBanner(null);
    try {
      const projectLabel =
        projectRows.find((p) => p.id === selectedProjectId)?.code ||
        projectRows.find((p) => p.id === selectedProjectId)?.name ||
        "";
      await assignMutation.mutateAsync({
        submissionId: submission.id,
        projectId: selectedProjectId,
      });
      setBanner({
        kind: "success",
        message: t("toast_assigned", { project: projectLabel }),
      });
      // Reset the picker so the operator can immediately attach
      // another project without re-opening the modal. The list
      // refetches via the mutation's onSuccess invalidate.
      setSelectedProjectId(null);
      setSearch("");
    } catch (err) {
      setBanner({
        kind: "error",
        message:
          err instanceof ApiError
            ? extractApiErrorMessage(err, tErrors)
            : t("error_generic"),
      });
    }
  };

  const handleDetach = async (assignment: CFFAssignmentDto) => {
    setBanner(null);
    setDetachingProjectId(assignment.project.id);
    try {
      await unassignMutation.mutateAsync({
        submissionId: submission.id,
        projectId: assignment.project.id,
      });
      setBanner({
        kind: "success",
        message: t("toast_unassigned", {
          project: assignment.project.code || assignment.project.name,
        }),
      });
    } catch (err) {
      setBanner({
        kind: "error",
        message:
          err instanceof ApiError
            ? extractApiErrorMessage(err, tErrors)
            : t("error_generic"),
      });
    } finally {
      setDetachingProjectId(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cff-assign-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isBusy) onClose();
      }}
    >
      <div className="flex w-full max-w-lg max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <header className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <h2
            id="cff-assign-title"
            className="text-sm font-semibold text-ink-1000"
          >
            {t("title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            aria-label={t("cancel")}
            className="rounded-md p-1 text-ink-500 transition-colors hover:bg-ink-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
          <p className="mb-3 text-xs text-ink-600">{t("body")}</p>

          {/* Currently-linked projects. Renders one chip per link
              with an inline detach button so a misrouted CFF can be
              fixed in two clicks. Empty-state copy keeps the section
              present (rather than hiding it) so the operator always
              sees the assignment shape at a glance. */}
          <section className="mb-3">
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-500">
              {t("linked_section")}
            </p>
            {submission.assignments.length === 0 ? (
              <p className="rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-500 ring-1 ring-inset ring-ink-100">
                {t("linked_empty")}
              </p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {submission.assignments.map((assignment) => {
                  const detaching =
                    detachingProjectId === assignment.project.id;
                  return (
                    <li key={assignment.project.id}>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-900 ring-1 ring-inset ring-blue-200">
                        <span className="truncate">
                          {assignment.project.code ||
                            assignment.project.name}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleDetach(assignment)}
                          disabled={isBusy}
                          aria-label={t("unassign_link_label")}
                          title={t("unassign_link_label")}
                          className="-mr-1 rounded-full p-0.5 text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-50"
                        >
                          {detaching ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <X className="h-3 w-3" />
                          )}
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Project picker — bottom half. Filters out projects the
              CFF is already linked to so the operator doesn't waste
              a click on a no-op re-attach. */}
          <label className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("select_placeholder")}
              className="w-full rounded-lg bg-white py-2 pl-9 pr-3 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
            />
          </label>
          <div className="flex-1 overflow-y-auto rounded-lg border border-ink-100">
            {projectsQuery.isPending ? (
              <div className="flex items-center justify-center p-4 text-xs text-ink-500">
                <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              </div>
            ) : projectRows.length === 0 ? (
              <p className="p-4 text-xs text-ink-500">{t("no_projects")}</p>
            ) : (
              <ul className="flex flex-col">
                {projectRows.map((row) => {
                  const isSelected = selectedProjectId === row.id;
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedProjectId(row.id)}
                        className={
                          "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors " +
                          (isSelected
                            ? "bg-orange-50 text-ink-1000"
                            : "hover:bg-ink-50")
                        }
                      >
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {row.name}
                          </span>
                          {row.code ? (
                            <span className="truncate text-[11px] text-ink-500">
                              {row.code}
                            </span>
                          ) : null}
                        </div>
                        {isSelected ? (
                          <CheckCircle2 className="h-4 w-4 text-orange-500" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {banner ? (
          <p
            role="alert"
            className={`mx-5 mb-3 rounded-lg px-3 py-2 text-xs font-medium ring-1 ring-inset ${
              banner.kind === "success"
                ? "bg-success/10 text-success ring-success/20"
                : "bg-danger/10 text-danger ring-danger/20"
            }`}
          >
            {banner.message}
          </p>
        ) : null}

        <footer className="flex items-center justify-end gap-2 border-t border-ink-100 bg-ink-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isBusy}
            className="rounded-lg px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-white disabled:opacity-50"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => void handleAssign()}
            disabled={isBusy || !selectedProjectId}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-600 disabled:opacity-50"
          >
            {assignMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {assignMutation.isPending ? t("sending") : t("submit")}
          </button>
        </footer>
      </div>
    </div>
  );
}
