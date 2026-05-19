"use client";

import { CheckCircle2, Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useAssignCFFToProject,
  useUnassignCFF,
  type CFFSubmissionDto,
} from "@/services/cff-submissions";
import { useInfiniteFormulations } from "@/services/formulations";


type Banner =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string }
  | null;


/**
 * Modal for attaching a CFF to a project.
 *
 * Two flows depending on whether the CFF is already attached:
 *
 * * **Unassigned** → searchable project picker. The list reuses
 *   :func:`useInfiniteFormulations` (same hook as the project page
 *   filter bar) so a project's code / name match the same fuzzy
 *   rules the user already knows.
 * * **Assigned** → confirmation prompt to detach. Detach is a
 *   single button — the audit trail records who broke the link so
 *   the team has a record even if the project itself stays.
 */
export function CFFAssignModal({
  orgId,
  submission,
  onClose,
}: {
  orgId: string;
  submission: CFFSubmissionDto;
  onClose: () => void;
}) {
  const t = useTranslations("cff.assign");
  const tErrors = useTranslations("errors");

  const isAttached = Boolean(submission.project);

  const assignMutation = useAssignCFFToProject(orgId);
  const unassignMutation = useUnassignCFF(orgId);

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [banner, setBanner] = useState<Banner>(null);

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

  const projectRows = useMemo(() => {
    const pages = projectsQuery.data?.pages ?? [];
    return pages.flatMap((page) => page.results ?? []);
  }, [projectsQuery.data]);

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
      // Brief pause so the success banner is visible before the
      // modal closes — matches the existing modals' UX.
      window.setTimeout(onClose, 600);
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

  const handleUnassign = async () => {
    setBanner(null);
    try {
      await unassignMutation.mutateAsync({ submissionId: submission.id });
      setBanner({ kind: "success", message: t("toast_unassigned") });
      window.setTimeout(onClose, 600);
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

  const isBusy = assignMutation.isPending || unassignMutation.isPending;

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
            {isAttached
              ? t("unassign_confirm_title", {
                  project:
                    submission.project?.code ||
                    submission.project?.name ||
                    "",
                })
              : t("title")}
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

        {isAttached ? (
          <div className="flex-1 px-5 py-4 text-sm text-ink-700">
            <p>{t("unassign_confirm_body")}</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden px-5 py-4">
            <p className="mb-3 text-xs text-ink-600">{t("body")}</p>
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
                <p className="p-4 text-xs text-ink-500">
                  {t("no_projects")}
                </p>
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
        )}

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
          {isAttached ? (
            <button
              type="button"
              onClick={() => void handleUnassign()}
              disabled={isBusy}
              className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {unassignMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {unassignMutation.isPending
                ? t("unassign_sending")
                : t("unassign_submit")}
            </button>
          ) : (
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
          )}
        </footer>
      </div>
    </div>
  );
}
