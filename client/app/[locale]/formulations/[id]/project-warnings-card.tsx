"use client";

import { Button, Modal } from "@heroui/react";
import {
  AlertTriangle,
  ClipboardList,
  Link2,
  Loader2,
  Search,
  UserCircle,
  UserRound,
  UserRoundCog,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";

import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useDebouncedValue } from "@/lib/utils/use-debounced-value";
import {
  useCFFCandidates,
  useLinkCFFToProject,
  useUnlinkCFFFromProject,
  type ProjectOverviewDto,
} from "@/services/formulations";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";


/**
 * Top-of-page reminders card. Renders one row per outstanding
 * assignment gap, and one soft row for CFF linkage. Self-hides when
 * nothing needs the operator's attention.
 *
 * Warning severity is intentional:
 *
 * * Missing sales / lead scientist — hard warning (amber). Every
 *   commercial-ready project needs both; the assignments feed the
 *   proposal signer and the QC responsibility trail.
 * * Missing CFF link — soft reminder (blue). A project born from a
 *   direct scientist-drafted brief is a legitimate use case; the
 *   card just reminds sales they can attach the CFF that spawned
 *   this project if they had one in the inbox.
 */
export function ProjectWarningsCard({
  orgId,
  overview,
  canEdit,
}: {
  orgId: string;
  overview: ProjectOverviewDto;
  canEdit: boolean;
}) {
  const tWarnings = useTranslations("project_warnings");
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [unlinkError, setUnlinkError] = useState<string | null>(null);

  const missingSales = overview.sales_person === null;
  const missingScientist = overview.lead_scientist === null;
  const missingCustomer = overview.linked_customer === null;
  const hasCFF = overview.linked_cffs.length > 0;

  const anythingToShow =
    missingCustomer ||
    missingSales ||
    missingScientist ||
    !hasCFF ||
    overview.linked_cffs.length;

  const unlinkMutation = useUnlinkCFFFromProject(orgId, overview.id);
  const tErrors = useTranslations("errors");

  const handleUnlink = async (cffId: string) => {
    setUnlinkError(null);
    try {
      await unlinkMutation.mutateAsync(cffId);
    } catch (err) {
      setUnlinkError(extractApiErrorMessage(err, tErrors));
    }
  };

  if (!anythingToShow) return null;

  return (
    <section className="flex flex-col gap-3 rounded-2xl bg-ink-0 p-5 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink-1000">
          {tWarnings("title")}
        </h2>
        <span className="text-xs text-ink-500">
          {tWarnings("subtitle")}
        </span>
      </div>

      <ul className="flex flex-col gap-2">
        {/* No customer — the loudest hard warning. Blocks spec sheet
            creation + director approval on the BE; surfacing it here
            gives sales a one-click path to fix before they hit the
            server-side gate. */}
        {missingCustomer ? (
          <WarningRow
            tone="amber"
            icon={<UserRound className="h-4 w-4" />}
            title="No customer linked"
            body="A spec sheet can't be created or director-signed until you attach a client. Use the Customer card below to link one now."
          />
        ) : null}

        {missingSales ? (
          <WarningRow
            tone="amber"
            icon={<UserCircle className="h-4 w-4" />}
            title={tWarnings("no_sales.title")}
            body={tWarnings("no_sales.body")}
          />
        ) : null}

        {missingScientist ? (
          <WarningRow
            tone="amber"
            icon={<UserRoundCog className="h-4 w-4" />}
            title={tWarnings("no_scientist.title")}
            body={tWarnings("no_scientist.body")}
          />
        ) : null}

        {!hasCFF ? (
          <WarningRow
            tone="blue"
            icon={<ClipboardList className="h-4 w-4" />}
            title={tWarnings("no_cff.title")}
            body={tWarnings("no_cff.body")}
            action={
              canEdit ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setLinkModalOpen(true)}
                  className="rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Link2 className="h-3.5 w-3.5" />
                    {tWarnings("no_cff.action")}
                  </span>
                </Button>
              ) : null
            }
          />
        ) : null}

        {hasCFF ? (
          <li className="flex flex-col gap-2 rounded-xl bg-ink-50 p-3 ring-1 ring-inset ring-ink-200">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-600">
              {tWarnings("linked.title")}
            </p>
            {/* One CFF per project — the section renders exactly one
                row. Legacy projects that (pre-migration) carried
                multiple got de-duplicated in migration 0008 down to
                the most-recently-assigned row, so ``linked_cffs[0]``
                is the canonical link. */}
            {overview.linked_cffs.slice(0, 1).map((cff) => (
              <div
                key={cff.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-ink-0 px-3 py-2 ring-1 ring-inset ring-ink-200"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-ink-1000">
                    {cff.submitter_name || cff.submitter_email || cff.id}
                  </span>
                  {cff.submitter_email &&
                  cff.submitter_email !== cff.submitter_name ? (
                    <span className="text-xs text-ink-500">
                      {cff.submitter_email}
                    </span>
                  ) : null}
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => handleUnlink(cff.id)}
                    disabled={unlinkMutation.isPending}
                    title={tWarnings("linked.unlink")}
                    className="rounded-full p-1 text-ink-400 hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                  >
                    {unlinkMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="h-3.5 w-3.5" />
                    )}
                  </button>
                ) : null}
              </div>
            ))}
            {unlinkError ? (
              <p
                role="alert"
                className="rounded-lg bg-danger/10 px-2 py-1 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
              >
                {unlinkError}
              </p>
            ) : null}
          </li>
        ) : null}
      </ul>

      <LinkCFFModal
        orgId={orgId}
        formulationId={overview.id}
        isOpen={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
      />
    </section>
  );
}


function WarningRow({
  tone,
  icon,
  title,
  body,
  action,
}: {
  tone: "amber" | "blue";
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  const toneClasses =
    tone === "amber"
      ? "bg-amber-50 text-amber-950 ring-amber-200"
      : "bg-sky-50 text-sky-950 ring-sky-200";
  const iconClasses = tone === "amber" ? "text-amber-700" : "text-sky-700";
  return (
    <li
      className={`flex flex-wrap items-start justify-between gap-3 rounded-xl px-3 py-3 ring-1 ring-inset ${toneClasses}`}
    >
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex-none ${iconClasses}`}>
          {tone === "amber" ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            icon
          )}
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold">{title}</span>
          <span className="text-xs text-ink-700">{body}</span>
        </div>
      </div>
      {action ? <div className="flex-none">{action}</div> : null}
    </li>
  );
}


//: Debounce delay for the CFF picker's search input. Balances
//: perceived responsiveness against the wire cost of a query that
//: at scale walks two indexed columns over millions of rows —
//: 300 ms is short enough that a decisive typist doesn't feel
//: the pause and long enough to swallow keystroke chatter.
const CFF_SEARCH_DEBOUNCE_MS = 300;


function LinkCFFModal({
  orgId,
  formulationId,
  isOpen,
  onClose,
}: {
  orgId: string;
  formulationId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const tWarnings = useTranslations("project_warnings");
  const tErrors = useTranslations("errors");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, CFF_SEARCH_DEBOUNCE_MS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      setSearch("");
      setError(null);
    }
  }, [isOpen]);

  // No min-length gate — the modal always renders the newest rows
  // on open and lets the operator scroll for more. Search just
  // narrows the same infinite list.
  const trimmed = debouncedSearch.trim();

  const {
    data,
    isLoading,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useCFFCandidates(orgId, formulationId, trimmed, isOpen);

  const link = useLinkCFFToProject(orgId, formulationId);

  const candidates = useMemo(
    () => data?.pages.flatMap((page) => page.candidates) ?? [],
    [data],
  );

  // Infinite-scroll sentinel — IntersectionObserver fires
  // ``fetchNextPage`` the moment the div scrolls into view. Rerun
  // when the callback identity changes (search flips, page count
  // grows) so a fresh observer targets the newest sentinel.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void fetchNextPage();
        }
      },
      { root: null, rootMargin: "120px", threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, candidates.length]);

  const handleLink = async (cffId: string) => {
    setError(null);
    try {
      await link.mutateAsync(cffId);
      onClose();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? undefined : onClose())}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tWarnings("link_modal.title")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex max-h-[70vh] flex-col gap-4 overflow-hidden px-6 py-6">
              <p className="text-sm text-ink-500">
                {tWarnings("link_modal.subtitle")}
              </p>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
                <input
                  autoFocus
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={tWarnings("link_modal.search_placeholder")}
                  className={`${INPUT_CLASS} pl-9`}
                />
              </div>

              <div className="flex-1 overflow-y-auto rounded-xl bg-ink-50 ring-1 ring-inset ring-ink-200">
                {isLoading ? (
                  <div className="flex items-center justify-center py-10 text-sm text-ink-500">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {tWarnings("link_modal.loading")}
                  </div>
                ) : candidates.length === 0 && !isFetching ? (
                  <div className="py-10 text-center text-sm text-ink-500">
                    {trimmed
                      ? tWarnings("link_modal.empty_search")
                      : tWarnings("link_modal.empty")}
                  </div>
                ) : (
                  <>
                    <ul className="divide-y divide-ink-200">
                      {candidates.map((cff) => {
                        const linkedCount = cff.linked_projects.length;
                        const firstLinked = cff.linked_projects[0];
                        const linkedTooltip =
                          linkedCount > 0
                            ? cff.linked_projects
                                .map((p) => p.code || p.name)
                                .join(", ")
                            : undefined;
                        return (
                          <li
                            key={cff.id}
                            className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-ink-0"
                          >
                            <div className="flex min-w-0 flex-col">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="truncate text-sm font-medium text-ink-1000">
                                  {cff.submitter_name ||
                                    cff.submitter_email ||
                                    cff.id}
                                </span>
                                {linkedCount > 0 ? (
                                  <span
                                    title={linkedTooltip}
                                    className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 ring-1 ring-inset ring-amber-200"
                                  >
                                    <Link2 className="h-3 w-3" />
                                    {linkedCount === 1
                                      ? tWarnings(
                                          "link_modal.linked_elsewhere_one",
                                          {
                                            code:
                                              firstLinked?.code ||
                                              firstLinked?.name ||
                                              "?",
                                          },
                                        )
                                      : tWarnings(
                                          "link_modal.linked_elsewhere_many",
                                          { count: linkedCount },
                                        )}
                                  </span>
                                ) : null}
                              </div>
                              <span className="truncate text-xs text-ink-500">
                                {cff.submitter_email}
                                {cff.wix_created_date
                                  ? ` · ${new Date(cff.wix_created_date).toLocaleDateString()}`
                                  : ""}
                              </span>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => handleLink(cff.id)}
                              isDisabled={link.isPending}
                              className="flex-none rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-60"
                            >
                              {tWarnings("link_modal.link")}
                            </Button>
                          </li>
                        );
                      })}
                    </ul>
                    {/* Sentinel row — an IntersectionObserver higher
                        up fires ``fetchNextPage`` the moment this
                        scrolls into the viewport (plus a 120px
                        pre-fetch buffer via ``rootMargin``). */}
                    {hasNextPage ? (
                      <div
                        ref={sentinelRef}
                        className="flex items-center justify-center py-4 text-xs text-ink-500"
                      >
                        {isFetchingNextPage ? (
                          <>
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            {tWarnings("link_modal.loading_more")}
                          </>
                        ) : null}
                      </div>
                    ) : candidates.length > 0 ? (
                      <p className="py-4 text-center text-xs text-ink-500">
                        {tWarnings("link_modal.end_of_list")}
                      </p>
                    ) : null}
                  </>
                )}
              </div>

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
                size="md"
                className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={onClose}
                isDisabled={link.isPending}
              >
                {tWarnings("link_modal.close")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
