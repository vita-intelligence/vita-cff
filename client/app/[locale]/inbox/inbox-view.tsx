"use client";

/**
 * Two-pane mailbox: left thread list, right reader.
 *
 * Layout posture: the section is a fixed-height flex column that sits
 * inside the viewport — the left aside scrolls internally rather than
 * letting the page grow. With thousands of threads the row list is
 * virtualized via :code:`@tanstack/react-virtual` so only the on-
 * screen window pays for DOM nodes.
 *
 * The data comes from the same ``/api/comments/inbox/`` endpoint the
 * bell dropdown reads — the bell preview and this page never go
 * out of sync because they share the TanStack cache key. What this
 * page adds is the *structure*: customer-authored threads float to a
 * dedicated section at the top (so a "the customer just replied"
 * signal never gets buried under internal noise), the rest groups
 * by source kind with a single-row filter chip strip, and clicking
 * a row opens the conversation inline on the right rather than
 * pushing yet another floating window into a stack.
 *
 * Capabilities posture matches :file:`floating-chat-panel.tsx`:
 * optimistic until the selected thread's organisation resolves,
 * then tightened against the membership's ``formulations.comments_*``
 * grants. The backend re-checks every write anyway — the FE flags
 * exist only to hide the composer where it would be a wasted click.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ClipboardList,
  ExternalLink,
  FileSignature,
  FileText,
  FlaskConical,
  Inbox,
  Loader2,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { CommentsPanel } from "@/components/comments/comments-panel";
import { Link } from "@/i18n/navigation";
import { hasFlatCapability } from "@/lib/auth/capabilities";
import { useCurrentUser } from "@/services/accounts";
import {
  useInboxList,
  useMarkThreadRead,
  type InboxEntityKind,
  type InboxThreadDto,
} from "@/services/inbox";
import { useOrganization } from "@/services/organizations";


type KindFilter = InboxEntityKind | "all";

const KIND_LABEL: Record<InboxEntityKind, string> = {
  proposal: "Proposals",
  specification: "Specifications",
  cff_submission: "CFF submissions",
  formulation: "Projects",
};

const KIND_LABEL_SINGULAR: Record<InboxEntityKind, string> = {
  proposal: "Proposal",
  specification: "Specification",
  cff_submission: "CFF submission",
  formulation: "Project",
};

const KIND_GROUP_ORDER: readonly InboxEntityKind[] = [
  "proposal",
  "specification",
  "cff_submission",
  "formulation",
];


// Each list section has its own scroll container, its own
// virtualizer, and its own flat-item shape. The customer section
// renders only thread rows; the "everything else" section
// interleaves per-kind dividers with rows. Keeping them separate
// preserves the production visual (two distinct rounded cards)
// while letting each grow to thousands of rows without DOM bloat.
type OtherRow =
  | { readonly kind: "thread"; readonly thread: InboxThreadDto }
  | { readonly kind: "kind-divider"; readonly entityKind: InboxEntityKind };

const THREAD_ROW_ESTIMATE = 76;
const KIND_DIVIDER_ESTIMATE = 32;


export function InboxView() {
  const inboxQuery = useInboxList();
  const [selected, setSelected] = useState<InboxThreadDto | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const markRead = useMarkThreadRead();

  const threads = inboxQuery.data?.threads ?? [];

  // Partition: customer-authored threads sit in a priority section
  // at the top regardless of which source they belong to. Detection
  // is "the *latest* message was from a client" — i.e. the customer
  // is the one currently waiting on the team, not the other way
  // round. Internal-lane rows can NEVER end up in this bucket because
  // the customer cannot author into the internal lane by design
  // (the kiosk filter is shared-only) — the guard below is defence-
  // in-depth so a misclassified row can't surface a customer reply
  // inside the staff-only section.
  const { customerThreads, otherThreads } = useMemo(() => {
    const customer: InboxThreadDto[] = [];
    const other: InboxThreadDto[] = [];
    for (const t of threads) {
      const isCustomerReply =
        t.last_message_author.kind === "client" && t.visibility !== "internal";
      if (isCustomerReply) customer.push(t);
      else other.push(t);
    }
    return { customerThreads: customer, otherThreads: other };
  }, [threads]);

  const filteredOther = useMemo(() => {
    if (kindFilter === "all") return otherThreads;
    return otherThreads.filter((t) => t.entity_kind === kindFilter);
  }, [otherThreads, kindFilter]);

  const otherByKind = useMemo(() => {
    const map = new Map<InboxEntityKind, InboxThreadDto[]>();
    for (const t of filteredOther) {
      const bucket = map.get(t.entity_kind) ?? [];
      bucket.push(t);
      map.set(t.entity_kind, bucket);
    }
    return map;
  }, [filteredOther]);

  // "Everything else" — interleaves kind dividers with the per-kind
  // thread rows. Empty kinds are skipped so the divider doesn't sit
  // alone above zero rows after the user picks a filter.
  const otherItems = useMemo<readonly OtherRow[]>(() => {
    const out: OtherRow[] = [];
    for (const k of KIND_GROUP_ORDER) {
      const bucket = otherByKind.get(k);
      if (!bucket || bucket.length === 0) continue;
      out.push({ kind: "kind-divider", entityKind: k });
      for (const t of bucket) {
        out.push({ kind: "thread", thread: t });
      }
    }
    return out;
  }, [otherByKind]);

  const customerUnread = useMemo(
    () => customerThreads.reduce((sum, t) => sum + t.unread_count, 0),
    [customerThreads],
  );

  const customerScrollRef = useRef<HTMLDivElement>(null);
  const customerVirtualizer = useVirtualizer({
    count: customerThreads.length,
    getScrollElement: () => customerScrollRef.current,
    estimateSize: () => THREAD_ROW_ESTIMATE,
    overscan: 8,
  });

  const otherScrollRef = useRef<HTMLDivElement>(null);
  const otherVirtualizer = useVirtualizer({
    count: otherItems.length,
    getScrollElement: () => otherScrollRef.current,
    estimateSize: (i) =>
      otherItems[i]!.kind === "kind-divider"
        ? KIND_DIVIDER_ESTIMATE
        : THREAD_ROW_ESTIMATE,
    overscan: 8,
  });

  const handleSelect = useCallback(
    (thread: InboxThreadDto) => {
      setSelected(thread);
      // Optimistic mark-read so the unread badge clears the moment
      // the user clicks. We pass ``visibility`` so only the matching
      // lane's pointer moves — opening the internal bubble can't
      // accidentally clear unreads on the sibling customer thread.
      // Mutation invalidates the inbox + count queries on success —
      // a network failure leaves the row showing unread, which is the
      // correct conservative default.
      if (thread.unread_count > 0) {
        markRead.mutate({
          entityKind: thread.entity_kind,
          entityId: thread.entity_id,
          visibility: thread.visibility,
        });
      }
    },
    [markRead],
  );

  const selectedKey = selected ? threadKey(selected) : null;
  const isReady =
    !inboxQuery.isLoading && !inboxQuery.error && threads.length > 0;
  const hasCustomer = customerThreads.length > 0;
  const hasOther = otherThreads.length > 0;
  const noMatchesAfterFilter =
    isReady && !hasCustomer && hasOther && otherItems.length === 0;

  return (
    <section className="mt-6 flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Inbox className="h-5 w-5 text-ink-500" aria-hidden />
          <div>
            <h1 className="text-lg font-semibold text-ink-1000">Messages</h1>
            <p className="text-xs text-ink-500">
              Every conversation across proposals, spec sheets, CFFs and
              projects you can see.
            </p>
          </div>
        </div>
        {inboxQuery.data ? (
          <span className="text-xs text-ink-500 tabular-nums">
            {inboxQuery.data.total_unread > 0
              ? `${inboxQuery.data.total_unread} unread · `
              : ""}
            {threads.length} conversation{threads.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* Left pane — thread list. On mobile this hides once a
            thread is selected; on desktop it stays put as a fixed-
            width column. The pane itself never scrolls — the inner
            virtualized container is the only scroll target. */}
        <aside
          className={`${
            selected ? "hidden lg:flex" : "flex"
          } w-full min-h-0 flex-col gap-4 lg:w-[420px] lg:shrink-0`}
        >
          {inboxQuery.isLoading ? (
            <div className="flex items-center gap-2 rounded-2xl bg-ink-0 p-4 text-xs text-ink-500 ring-1 ring-ink-200">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading conversations…
            </div>
          ) : inboxQuery.error ? (
            <div
              role="alert"
              className="rounded-2xl bg-danger/10 p-4 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
            >
              Couldn't load your inbox.
            </div>
          ) : threads.length === 0 ? (
            <EmptyInbox />
          ) : (
            <>
              {hasCustomer ? (
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-ink-0 ring-1 ring-ink-200">
                  <header className="flex shrink-0 items-center justify-between border-b border-ink-100 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <UserRound
                        className="h-3.5 w-3.5 text-orange-600"
                        aria-hidden
                      />
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-1000">
                        From customers
                      </h2>
                    </div>
                    {customerUnread > 0 ? (
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-orange-700">
                        {customerUnread} unread
                      </span>
                    ) : null}
                  </header>
                  <div
                    ref={customerScrollRef}
                    className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
                  >
                    <div
                      style={{
                        height: customerVirtualizer.getTotalSize(),
                        width: "100%",
                        position: "relative",
                      }}
                      role="list"
                    >
                      {customerVirtualizer.getVirtualItems().map((vi) => {
                        const thread = customerThreads[vi.index]!;
                        return (
                          <div
                            key={vi.key}
                            data-index={vi.index}
                            ref={customerVirtualizer.measureElement}
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 0,
                              width: "100%",
                              transform: `translateY(${vi.start}px)`,
                            }}
                          >
                            <ThreadRow
                              thread={thread}
                              selected={selectedKey === threadKey(thread)}
                              onClick={() => handleSelect(thread)}
                              highlightAuthor
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </section>
              ) : null}

              {hasOther ? (
                <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-ink-0 ring-1 ring-ink-200">
                  <header className="shrink-0 border-b border-ink-100 px-4 py-3">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-1000">
                      Everything else
                    </h2>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <FilterChip
                        label="All"
                        active={kindFilter === "all"}
                        onClick={() => setKindFilter("all")}
                      />
                      {KIND_GROUP_ORDER.map((kind) => (
                        <FilterChip
                          key={kind}
                          label={KIND_LABEL[kind]}
                          active={kindFilter === kind}
                          onClick={() => setKindFilter(kind)}
                        />
                      ))}
                    </div>
                  </header>
                  {noMatchesAfterFilter ? (
                    <NoMatches />
                  ) : (
                    <div
                      ref={otherScrollRef}
                      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
                    >
                      <div
                        style={{
                          height: otherVirtualizer.getTotalSize(),
                          width: "100%",
                          position: "relative",
                        }}
                        role="list"
                      >
                        {otherVirtualizer.getVirtualItems().map((vi) => {
                          const item = otherItems[vi.index]!;
                          return (
                            <div
                              key={vi.key}
                              data-index={vi.index}
                              ref={otherVirtualizer.measureElement}
                              style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${vi.start}px)`,
                              }}
                            >
                              {item.kind === "kind-divider" ? (
                                <KindDivider entityKind={item.entityKind} />
                              ) : (
                                <ThreadRow
                                  thread={item.thread}
                                  selected={
                                    selectedKey === threadKey(item.thread)
                                  }
                                  onClick={() => handleSelect(item.thread)}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </section>
              ) : null}
            </>
          )}
        </aside>

        {/* Right pane — reader. On mobile it takes the whole width
            when a thread is open and shows a back button. ``min-h-0``
            so it shrinks to its row's height; the inner CommentsPanel
            handles its own scroll via ``layout="fill"``. */}
        <div
          className={`${
            selected ? "flex" : "hidden lg:flex"
          } min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-ink-0 ring-1 ring-ink-200`}
        >
          {selected ? (
            <ThreadReader
              thread={selected}
              onBack={() => setSelected(null)}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-ink-500">
              <div className="max-w-xs">
                <Sparkles
                  className="mx-auto mb-2 h-5 w-5 text-ink-400"
                  aria-hidden
                />
                <p>Pick a conversation on the left to open it here.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


function threadKey(t: InboxThreadDto): string {
  // Include visibility so the internal-lane row and shared-lane row
  // for the same entity render as distinct React children — without
  // it the second row would silently collide with the first and the
  // inbox would only show one of the two.
  return `${t.entity_kind}:${t.entity_id}:${t.visibility}`;
}


function KindDivider({ entityKind }: { entityKind: InboxEntityKind }) {
  return (
    <div className="flex items-center gap-1.5 border-t border-ink-100 bg-ink-50/40 px-4 pt-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500 first:border-t-0">
      <KindIcon kind={entityKind} />
      {KIND_LABEL[entityKind]}
    </div>
  );
}


function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ${
        active
          ? "bg-ink-1000 text-ink-0 ring-ink-1000"
          : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
      }`}
    >
      {label}
    </button>
  );
}


function KindIcon({ kind }: { kind: InboxEntityKind }) {
  const cls = "h-3 w-3 text-ink-400";
  switch (kind) {
    case "formulation":
      return <FlaskConical className={cls} aria-hidden />;
    case "specification":
      return <FileText className={cls} aria-hidden />;
    case "proposal":
      return <FileSignature className={cls} aria-hidden />;
    case "cff_submission":
      return <ClipboardList className={cls} aria-hidden />;
  }
}


function ThreadRow({
  thread,
  selected,
  onClick,
  highlightAuthor = false,
}: {
  thread: InboxThreadDto;
  selected: boolean;
  onClick: () => void;
  highlightAuthor?: boolean;
}) {
  const isClient = thread.last_message_author.kind === "client";
  const titleLine =
    thread.entity_title ||
    thread.entity_code ||
    KIND_LABEL_SINGULAR[thread.entity_kind];
  return (
    <div role="listitem" className="border-t border-ink-100 first:border-t-0">
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors ${
          selected
            ? "bg-ink-50 ring-1 ring-inset ring-ink-200"
            : "hover:bg-ink-50/60"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-1000">
              <span className="truncate">{titleLine}</span>
              {thread.entity_code && thread.entity_code !== titleLine ? (
                <span className="shrink-0 text-[10px] font-medium text-ink-500">
                  {thread.entity_code}
                </span>
              ) : null}
              {thread.visibility === "internal" ? (
                <span className="shrink-0 rounded bg-ink-1000 px-1 text-[9px] font-semibold uppercase tracking-wide text-ink-0">
                  Internal
                </span>
              ) : null}
            </p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
              <span
                className={`shrink-0 truncate font-medium ${
                  highlightAuthor || isClient
                    ? "text-orange-700"
                    : "text-ink-700"
                }`}
              >
                {thread.last_message_author.name}
              </span>
              {isClient ? (
                <span className="shrink-0 rounded bg-orange-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-orange-700">
                  Customer
                </span>
              ) : null}
              <span className="text-ink-300">·</span>
              <span className="truncate text-ink-500">
                {thread.last_message_preview || "(empty)"}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <time
              dateTime={thread.last_message_at}
              className="text-[10px] tabular-nums text-ink-500"
              title={thread.last_message_at}
            >
              {formatShortRelative(thread.last_message_at)}
            </time>
            {thread.unread_count > 0 ? (
              <span className="rounded-full bg-orange-500 px-1.5 text-[10px] font-semibold tabular-nums text-white">
                {thread.unread_count}
              </span>
            ) : null}
          </div>
        </div>
      </button>
    </div>
  );
}


// Where each row's "Open source" link points. The inbox aggregates
// threads across orgs; the destination pages resolve the org from
// the URL slug or active context, so we just hand them the entity id.
function entityHref(kind: InboxEntityKind, id: string): string {
  switch (kind) {
    case "proposal":
      return `/proposals/${id}`;
    case "specification":
      return `/specifications/${id}`;
    case "cff_submission":
      return `/cff/${id}`;
    case "formulation":
      return `/formulations/${id}`;
  }
}


function ThreadReader({
  thread,
  onBack,
}: {
  thread: InboxThreadDto;
  onBack: () => void;
}) {
  const userQuery = useCurrentUser();
  // Each thread carries its own org id (cross-org inboxes are
  // valid for users with memberships in multiple workspaces). We
  // resolve THAT org so the capability flags reflect the right
  // membership, not the one currently active in the header
  // switcher.
  const orgQuery = useOrganization(thread.organization.id);
  const organization = orgQuery ?? null;
  const canRead = organization
    ? hasFlatCapability(organization, "formulations", "comments_view")
    : true;
  const canWrite = organization
    ? hasFlatCapability(organization, "formulations", "comments_write")
    : true;
  const canModerate = organization
    ? hasFlatCapability(organization, "formulations", "comments_moderate")
    : false;

  return (
    <>
      <header className="flex items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
            <KindIcon kind={thread.entity_kind} />
            {KIND_LABEL_SINGULAR[thread.entity_kind]}
            {thread.entity_code ? (
              <span className="text-ink-400">· {thread.entity_code}</span>
            ) : null}
            {thread.visibility === "internal" ? (
              <span className="rounded bg-ink-1000 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-ink-0">
                Internal
              </span>
            ) : (
              <span className="rounded bg-orange-100 px-1 py-0.5 text-[9px] font-semibold tracking-wide text-orange-700">
                Customer
              </span>
            )}
          </p>
          <Link
            href={entityHref(thread.entity_kind, thread.entity_id)}
            className="group inline-flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-ink-1000 underline-offset-4 hover:text-orange-700 hover:underline"
            title={`Open ${KIND_LABEL_SINGULAR[thread.entity_kind].toLowerCase()}`}
          >
            <span className="truncate">
              {thread.entity_title ||
                thread.entity_code ||
                KIND_LABEL_SINGULAR[thread.entity_kind]}
            </span>
            <ExternalLink
              className="h-3.5 w-3.5 shrink-0 text-ink-400 transition-colors group-hover:text-orange-700"
              aria-hidden
            />
          </Link>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-2 py-1 text-xs text-ink-500 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 lg:hidden"
        >
          ← Back
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <CommentsPanel
          orgId={thread.organization.id}
          entityKind={thread.entity_kind}
          entityId={thread.entity_id}
          canRead={canRead}
          canWrite={canWrite}
          canModerate={canModerate}
          currentUserId={userQuery.data?.id ?? null}
          layout="fill"
          // Scope BOTH the read (so the reader only shows messages
          // from the lane you clicked) AND the write (so replies
          // posted from this surface stay in the same lane — an
          // internal-lane reply never appears on the customer kiosk).
          visibilityFilter={thread.visibility}
        />
      </div>
    </>
  );
}


function EmptyInbox() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-ink-0 p-10 text-center text-xs text-ink-500 ring-1 ring-ink-200">
      <Inbox className="h-6 w-6 text-ink-300" aria-hidden />
      <p className="font-medium text-ink-700">No conversations yet</p>
      <p className="max-w-sm">
        Threads appear here as soon as the team or a customer posts a message
        on a proposal, spec sheet, CFF, or project.
      </p>
    </div>
  );
}


function NoMatches() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-ink-0 p-8 text-center text-xs text-ink-500 ring-1 ring-ink-200">
      <Inbox className="h-5 w-5 text-ink-300" aria-hidden />
      <p className="font-medium text-ink-700">No conversations match this filter</p>
      <p className="max-w-sm">
        Try the All chip above to see every thread.
      </p>
    </div>
  );
}


// Lightweight relative-time formatter for the inbox list rows. Avoids
// the next-intl ``relativeTime`` round-trip per row when the list is
// long. Matches the messenger dropdown's terseness conventions.
function formatShortRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const delta = Math.max(0, Date.now() - then);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  // Past a month — fall back to YYYY-MM-DD so the user gets the
  // unambiguous date without dragging in i18n date plumbing for
  // what is fundamentally a sortable label.
  return new Date(iso).toISOString().slice(0, 10);
}
