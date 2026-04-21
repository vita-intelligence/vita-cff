"use client";

/**
 * Public-visitor comment panel mounted on ``/p/<token>``.
 *
 * Differences from the authed :class:`CommentsPanel`:
 *   - No mentions, no moderation, no resolve toggle. A guest can
 *     only post top-level comments (and, in a later commit, reply
 *     to an org member's comment).
 *   - Identity is captured once per browser session via the
 *     :class:`KioskIdentityModal`. We do not persist the raw
 *     credentials in ``localStorage`` — the signed cookie is the
 *     single source of truth, ``sessionStorage`` only tracks the
 *     "already identified" flag so the modal does not re-pop on
 *     every reload.
 *   - Polling is 20 s because kiosk visitors have no WebSocket
 *     layer today — we'll wire a public-WS variant in a later
 *     commit if demand materialises.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Pin } from "lucide-react";
import { useTranslations } from "next-intl";

import { buttonClass } from "@/components/ui/button-styles";
import {
  openKioskCommentsSocket,
  type CommentDto,
  type CommentsSocketHandle,
  type PaginatedCommentsDto,
} from "@/services/comments";
import {
  createKioskComment,
  fetchKioskCommentsPage,
  signOutKioskVisitor,
  type KioskIdentityEcho,
} from "@/services/comments/kiosk-api";

import { KioskIdentityModal } from "./kiosk-identity-modal";
import { CommentThread } from "../comment-thread";
import { InfiniteLoader } from "../infinite-loader";
import { PresenceAvatars } from "../presence-avatars";
import { TypingIndicator } from "../typing-indicator";
import { groupIntoThreads } from "../utils";


interface Props {
  readonly token: string;
}


//: localStorage marker keyed per token so a visitor stays
//: "signed in" across refreshes / tab closes (the signed cookie
//: lives for 30 days; the marker just tells the panel to skip the
//: identity modal on re-open rather than re-prompting every time).
//: Two different shares in the same browser each keep their own
//: marker so identities don't cross-contaminate.
const identifiedKey = (token: string) => `vita_kiosk_${token}_identified`;


export function KioskCommentsPanel({ token }: Props) {
  const tComments = useTranslations("comments");
  const tKiosk = useTranslations("comments.kiosk");

  const [identity, setIdentity] = useState<KioskIdentityEcho | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [comments, setComments] = useState<readonly CommentDto[]>([]);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { pinnedThreads, regularThreads } = useMemo(() => {
    const grouped = groupIntoThreads(comments);
    const pinned = grouped.filter(
      (t) => t.root.needs_resolution && !t.root.is_resolved,
    );
    const rest = grouped.filter(
      (t) => !(t.root.needs_resolution && !t.root.is_resolved),
    );
    return { pinnedThreads: pinned, regularThreads: rest };
  }, [comments]);

  // Presence store key — mirrors the one :func:`openKioskCommentsSocket`
  // uses so the avatars / typing indicator read the right roster.
  const entityKey = useMemo(
    () => ({
      orgId: "public" as const,
      kind: "specification" as const,
      entityId: token,
    }),
    [token],
  );

  const refresh = useCallback(async () => {
    try {
      const page = await fetchKioskCommentsPage(token);
      setComments(page.results);
      setNextUrl(page.next);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [token]);

  const loadMore = useCallback(async () => {
    if (!nextUrl) return;
    try {
      const page: PaginatedCommentsDto = await fetchKioskCommentsPage(
        token,
        { cursorUrl: nextUrl },
      );
      setComments((prev) => [...prev, ...page.results]);
      setNextUrl(page.next);
    } catch {
      /* leave the button visible so the user can retry */
    }
  }, [nextUrl, token]);

  // Seed from sessionStorage on mount. If the marker is missing the
  // modal pops; otherwise we carry on and the cookie (still in the
  // browser jar) authorises the next write.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const marker = window.localStorage.getItem(identifiedKey(token));
    if (marker) {
      try {
        const parsed = JSON.parse(marker) as KioskIdentityEcho;
        setIdentity(parsed);
      } catch {
        setIdentity({ name: "", email: "", company: "" });
      }
    }
    void refresh();
  }, [refresh, token]);

  // Real-time sync via the public WebSocket route. The consumer
  // joins the same ``comments.specification.<id>`` group the authed
  // panel uses, so org-side replies appear instantly and vice-versa.
  // If the socket drops we fall back to an on-focus refetch — no
  // polling loop.
  const socketRef = useRef<CommentsSocketHandle | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    // The modal seed step writes the sessionStorage marker after
    // ``identify``; without identity we skip the WS open because the
    // consumer requires the signed kiosk cookie.
    if (!identity) return;
    const handle = openKioskCommentsSocket(token, {
      onCommentEvent: () => {
        void refresh();
      },
    });
    socketRef.current = handle;
    return () => {
      handle.release();
      socketRef.current = null;
    };
  }, [identity, refresh, token]);

  // Belt-and-braces refetch when the tab regains focus in case a WS
  // blip dropped an event while the window was hidden.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const handleIdentified = (echo: KioskIdentityEcho) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        identifiedKey(token),
        JSON.stringify(echo),
      );
    }
    setIdentity(echo);
    setModalOpen(false);
  };

  const handleSignOut = async () => {
    try {
      await signOutKioskVisitor(token);
    } catch {
      /* cookie clear is best-effort */
    }
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(identifiedKey(token));
    }
    setIdentity(null);
  };

  const handlePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setPosting(true);
    setError(null);
    try {
      const created = await createKioskComment(token, { body: body.trim() });
      setComments((prev) => [...prev, created]);
      setBody("");
      // Close the "X is typing…" indicator on org side now that the
      // message has been sent.
      socketRef.current?.sendTyping(false);
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      if (status === 403) {
        // Session revoked or rate-limited — either way we need to
        // re-identify the visitor rather than silently dropping.
        setError(tKiosk("error_session_expired"));
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(identifiedKey(token));
        }
        setIdentity(null);
      } else {
        setError(tKiosk("error_generic"));
      }
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-500">
          <MessageSquare className="h-3.5 w-3.5" />
          {tComments("title")}
        </div>
        <div className="flex items-center gap-3">
          {/*
            Presence strip — shows org members AND other clients
            watching the same sheet. The kiosk viewer sees their own
            avatar too (stable "you're here" cue); hiding self would
            require the server to hand back the session id, which we
            don't surface today.
          */}
          <PresenceAvatars entityKey={entityKey} />
          {identity ? (
            <div className="flex items-center gap-2 text-xs text-ink-600">
              <span>
                {tKiosk("signed_in_as", {
                  name: identity.name || identity.email,
                })}
              </span>
              <button
                type="button"
                className="rounded-md px-2 py-0.5 text-ink-500 hover:bg-ink-50 hover:text-ink-1000"
                onClick={() => void handleSignOut()}
              >
                {tKiosk("sign_out")}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto py-3">
        {pinnedThreads.length > 0 ? (
          <div className="sticky top-0 z-10 flex flex-col gap-2 border-b border-warning/30 bg-warning/5 px-4 py-2 backdrop-blur">
            <p className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-warning">
              <Pin className="h-2.5 w-2.5" />
              {tComments("states.pinned")} · {pinnedThreads.length}
            </p>
            {pinnedThreads.map((thread) => (
              <CommentThread
                key={`pin-${thread.root.id}`}
                root={thread.root}
                replies={thread.replies}
                orgId=""
                currentUserId={null}
                currentUserEmail={identity?.email ?? null}
                canWrite={false}
                canModerate={false}
                onReply={async () => undefined}
                onEdit={async () => undefined}
                onDelete={async () => undefined}
                onToggleResolve={async () => undefined}
              />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 px-4">
          {loading && regularThreads.length === 0 ? (
            <p className="text-xs text-ink-500">
              {tComments("states.loading")}
            </p>
          ) : regularThreads.length === 0 &&
            pinnedThreads.length === 0 ? (
            <p className="text-xs text-ink-500">
              {tComments("states.empty")}
            </p>
          ) : (
            regularThreads.map((thread) => (
              <CommentThread
                key={thread.root.id}
                root={thread.root}
                replies={thread.replies}
                orgId=""
                currentUserId={null}
                currentUserEmail={identity?.email ?? null}
                canWrite={false}
                canModerate={false}
                onReply={async () => undefined}
                onEdit={async () => undefined}
                onDelete={async () => undefined}
                onToggleResolve={async () => undefined}
              />
            ))
          )}
          {nextUrl ? (
            <InfiniteLoader
              onVisible={() => void loadMore()}
              label={tComments("actions.load_more")}
            />
          ) : null}
        </div>
      </div>

      <TypingIndicator entityKey={entityKey} />

      <div className="border-t border-ink-100 px-4 py-3">
        {identity ? (
          <form onSubmit={handlePost} className="flex flex-col gap-2">
            <textarea
              value={body}
              onChange={(e) => {
                const next = e.target.value;
                setBody(next);
                // Edge-triggered typing signal — let peers see a
                // "X is typing…" line. The socket handle tolerates
                // being called when the WS is still connecting or
                // disconnected (it no-ops until OPEN).
                socketRef.current?.sendTyping(next.trim().length > 0);
              }}
              onBlur={() => socketRef.current?.sendTyping(false)}
              placeholder={tComments("composer.placeholder")}
              rows={3}
              className="w-full resize-y rounded-xl bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none placeholder:text-ink-500 focus:ring-2 focus:ring-orange-400"
            />
            {error ? (
              <p
                role="alert"
                className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
              >
                {error}
              </p>
            ) : null}
            <div className="flex justify-end">
              <button
                type="submit"
                className={buttonClass("primary", "sm")}
                disabled={posting || !body.trim()}
              >
                {tComments("actions.send")}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className={buttonClass("primary", "sm")}
            onClick={() => setModalOpen(true)}
          >
            {tKiosk("open_modal")}
          </button>
        )}
      </div>

      {modalOpen ? (
        <KioskIdentityModal
          token={token}
          onIdentified={handleIdentified}
          onDismiss={() => setModalOpen(false)}
        />
      ) : null}
    </section>
  );
}
