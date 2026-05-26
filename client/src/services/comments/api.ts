/**
 * Raw Axios calls for the comments domain.
 */

import { apiClient } from "@/lib/api";

import { commentsEndpoints } from "./endpoints";
import type {
  CommentDto,
  CreateCommentRequestDto,
  EditCommentRequestDto,
  MentionableMembersPageDto,
  NotifyClientRequestDto,
  NotifyClientResponseDto,
  NotifyClientSummaryDto,
  PaginatedCommentsDto,
} from "./types";

export type CommentEntityKind =
  | "formulation"
  | "specification"
  | "proposal"
  | "cff_submission";

interface ThreadKey {
  readonly orgId: string;
  readonly kind: CommentEntityKind;
  readonly entityId: string;
}

function threadUrl(key: ThreadKey): string {
  switch (key.kind) {
    case "formulation":
      return commentsEndpoints.formulationThread(key.orgId, key.entityId);
    case "specification":
      return commentsEndpoints.specificationThread(key.orgId, key.entityId);
    case "proposal":
      return commentsEndpoints.proposalThread(key.orgId, key.entityId);
    case "cff_submission":
      return commentsEndpoints.cffSubmissionThread(key.orgId, key.entityId);
  }
}

export interface FetchCommentsPageArgs {
  readonly cursorUrl?: string | null;
  readonly includeResolved?: boolean;
  readonly pageSize?: number;
  /** Optional visibility scope. Omitting returns every comment the
   *  caller can see (the historical contract every existing
   *  fetcher relies on). The internal-proposal bubble passes
   *  ``"internal"`` so its read stays disjoint from the shared
   *  customer thread. */
  readonly visibility?: "internal" | "shared";
}

export async function fetchCommentsPage(
  key: ThreadKey,
  args: FetchCommentsPageArgs = {},
): Promise<PaginatedCommentsDto> {
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedCommentsDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }
  const params: Record<string, string> = {};
  if (args.includeResolved === false) params.include_resolved = "false";
  if (args.pageSize) params.page_size = String(args.pageSize);
  if (args.visibility) params.visibility = args.visibility;
  const { data } = await apiClient.get<PaginatedCommentsDto>(threadUrl(key), {
    params,
  });
  return data;
}

export async function createComment(
  key: ThreadKey,
  payload: CreateCommentRequestDto,
): Promise<CommentDto> {
  const { data } = await apiClient.post<CommentDto>(threadUrl(key), payload);
  return data;
}

export async function editComment(
  orgId: string,
  commentId: string,
  payload: EditCommentRequestDto,
): Promise<CommentDto> {
  const { data } = await apiClient.patch<CommentDto>(
    commentsEndpoints.detail(orgId, commentId),
    payload,
  );
  return data;
}

export async function deleteComment(
  orgId: string,
  commentId: string,
): Promise<void> {
  await apiClient.delete(commentsEndpoints.detail(orgId, commentId));
}

export async function resolveComment(
  orgId: string,
  commentId: string,
): Promise<CommentDto> {
  const { data } = await apiClient.post<CommentDto>(
    commentsEndpoints.resolve(orgId, commentId),
  );
  return data;
}

export async function unresolveComment(
  orgId: string,
  commentId: string,
): Promise<CommentDto> {
  const { data } = await apiClient.post<CommentDto>(
    commentsEndpoints.unresolve(orgId, commentId),
  );
  return data;
}

export async function flagComment(
  orgId: string,
  commentId: string,
): Promise<CommentDto> {
  const { data } = await apiClient.post<CommentDto>(
    commentsEndpoints.flag(orgId, commentId),
  );
  return data;
}

export async function unflagComment(
  orgId: string,
  commentId: string,
): Promise<CommentDto> {
  const { data } = await apiClient.post<CommentDto>(
    commentsEndpoints.unflag(orgId, commentId),
  );
  return data;
}

export async function fetchMentionableMembers(
  orgId: string,
  q?: string,
): Promise<MentionableMembersPageDto> {
  const { data } = await apiClient.get<MentionableMembersPageDto>(
    commentsEndpoints.mentionable(orgId, q),
  );
  return data;
}


// ---------------------------------------------------------------------------
// Notify-client (kiosk alert)
// ---------------------------------------------------------------------------


export async function fetchNotifyClientSummary(
  orgId: string,
  sheetId: string,
): Promise<NotifyClientSummaryDto> {
  const { data } = await apiClient.get<NotifyClientSummaryDto>(
    commentsEndpoints.notifyClient(orgId, sheetId),
  );
  return data;
}


export async function notifyClient(
  orgId: string,
  sheetId: string,
  args: NotifyClientRequestDto = {},
): Promise<NotifyClientResponseDto> {
  const { data } = await apiClient.post<NotifyClientResponseDto>(
    commentsEndpoints.notifyClient(orgId, sheetId),
    args,
  );
  return data;
}
