"use client";

/**
 * Render a comment body with ``@email`` tokens swapped for styled
 * ``@Name`` chips.
 *
 * The wire format deliberately uses the mentioned user's email
 * (e.g. ``@alice@vita.test``) so server-side resolution is
 * unambiguous even when two members share a first name. On read we
 * look each ``@email`` up against the comment's ``mentions`` array
 * (which carries ``{id, name, email}`` per entry) and replace the
 * token with a compact chip rendering the human name.
 *
 * Tokens that do not resolve to a known mention (e.g. a quoted
 * address in the middle of a sentence) fall through unchanged.
 */

import type { ReactNode } from "react";

import type { CommentMentionRefDto } from "@/services/comments";


// ``@`` followed by the same permissive email shape the backend
// parser accepts. Kept conservative to avoid swallowing punctuation
// the user actually typed — ``"thanks @alice@vita.test!"`` still
// leaves the ``!`` behind the chip.
const MENTION_RE =
  /(?<![A-Za-z0-9._%+-])@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;


export function renderCommentBody(
  body: string,
  mentions: readonly CommentMentionRefDto[],
): ReactNode[] {
  if (!body) return [body];
  if (mentions.length === 0) return [body];

  const byEmail = new Map<string, CommentMentionRefDto>();
  for (const m of mentions) {
    byEmail.set(m.email.toLowerCase(), m);
  }

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;

  for (const match of body.matchAll(MENTION_RE)) {
    const raw = match[0];
    const email = (match[1] ?? "").toLowerCase();
    const start = match.index ?? 0;
    if (start > lastIndex) {
      nodes.push(body.slice(lastIndex, start));
    }
    const known = byEmail.get(email);
    if (known) {
      nodes.push(
        <MentionChip
          key={`mention-${key}`}
          name={known.name}
          email={known.email}
        />,
      );
    } else {
      // Unknown target — keep the raw token so the reader can still
      // see what was written.
      nodes.push(raw);
    }
    lastIndex = start + raw.length;
    key += 1;
  }
  if (lastIndex < body.length) {
    nodes.push(body.slice(lastIndex));
  }
  return nodes;
}


function MentionChip({ name, email }: { name: string; email: string }) {
  return (
    <span
      title={email}
      className="inline-flex items-center rounded-md bg-orange-50 px-1.5 py-0.5 text-[0.82em] font-medium text-orange-700"
    >
      @{name || email}
    </span>
  );
}
