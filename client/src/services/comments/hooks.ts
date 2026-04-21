/**
 * TanStack Query hooks for the comments domain.
 *
 * The backend broadcasts ``comment.*`` events over the WebSocket
 * layer (commit 5) and the :class:`CommentsSocket` handler calls
 * ``queryClient.invalidateQueries`` on the thread key, so polling
 * is no longer the source of freshness. We keep ``refetchOnWindow
 * Focus`` on as a belt-and-braces net — if the WS was momentarily
 * down while a tab was hidden, the tab regains focus and pulls the
 * latest list in one round-trip.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  createComment,
  deleteComment,
  editComment,
  fetchCommentsPage,
  fetchMentionableMembers,
  flagComment,
  resolveComment,
  unflagComment,
  unresolveComment,
  type CommentEntityKind,
} from "./api";
import type {
  CommentDto,
  CreateCommentRequestDto,
  EditCommentRequestDto,
  MentionableMembersPageDto,
  PaginatedCommentsDto,
} from "./types";

export const commentsQueryKeys = {
  all: [...rootQueryKey, "comments"] as const,
  thread: (
    orgId: string,
    kind: CommentEntityKind,
    entityId: string,
    includeResolved: boolean,
  ) =>
    [
      ...commentsQueryKeys.all,
      orgId,
      kind,
      entityId,
      { includeResolved },
    ] as const,
  mentionable: (orgId: string, q: string) =>
    [...commentsQueryKeys.all, orgId, "mentionable", q] as const,
} as const;

export interface UseInfiniteCommentsArgs {
  readonly orgId: string;
  readonly kind: CommentEntityKind;
  readonly entityId: string;
  readonly includeResolved?: boolean;
  readonly enabled?: boolean;
  readonly initialFirstPage?: PaginatedCommentsDto | null;
}

export function useInfiniteComments(
  args: UseInfiniteCommentsArgs,
): UseInfiniteQueryResult<
  InfiniteData<PaginatedCommentsDto, string | null>,
  ApiError
> {
  const includeResolved = args.includeResolved ?? true;
  return useInfiniteQuery<
    PaginatedCommentsDto,
    ApiError,
    InfiniteData<PaginatedCommentsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: commentsQueryKeys.thread(
      args.orgId,
      args.kind,
      args.entityId,
      includeResolved,
    ),
    queryFn: ({ pageParam }) =>
      fetchCommentsPage(
        { orgId: args.orgId, kind: args.kind, entityId: args.entityId },
        {
          cursorUrl: pageParam ?? undefined,
          includeResolved,
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    enabled: args.enabled ?? true,
    refetchOnWindowFocus: true,
    initialData: args.initialFirstPage
      ? { pages: [args.initialFirstPage], pageParams: [null] }
      : undefined,
  });
}

interface CreateVars {
  readonly payload: CreateCommentRequestDto;
}

export function useCreateComment(
  orgId: string,
  kind: CommentEntityKind,
  entityId: string,
): UseMutationResult<CommentDto, ApiError, CreateVars> {
  const queryClient = useQueryClient();
  return useMutation<CommentDto, ApiError, CreateVars>({
    mutationFn: ({ payload }) =>
      createComment({ orgId, kind, entityId }, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...commentsQueryKeys.all, orgId, kind, entityId],
      });
    },
  });
}

interface EditVars {
  readonly commentId: string;
  readonly payload: EditCommentRequestDto;
}

export function useEditComment(
  orgId: string,
  kind: CommentEntityKind,
  entityId: string,
): UseMutationResult<CommentDto, ApiError, EditVars> {
  const queryClient = useQueryClient();
  return useMutation<CommentDto, ApiError, EditVars>({
    mutationFn: ({ commentId, payload }) =>
      editComment(orgId, commentId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...commentsQueryKeys.all, orgId, kind, entityId],
      });
    },
  });
}

interface DeleteVars {
  readonly commentId: string;
}

export function useDeleteComment(
  orgId: string,
  kind: CommentEntityKind,
  entityId: string,
): UseMutationResult<void, ApiError, DeleteVars> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, DeleteVars>({
    mutationFn: ({ commentId }) => deleteComment(orgId, commentId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...commentsQueryKeys.all, orgId, kind, entityId],
      });
    },
  });
}

interface ResolveVars {
  readonly commentId: string;
  readonly resolved: boolean;
}

export function useSetCommentResolved(
  orgId: string,
  kind: CommentEntityKind,
  entityId: string,
): UseMutationResult<CommentDto, ApiError, ResolveVars> {
  const queryClient = useQueryClient();
  return useMutation<CommentDto, ApiError, ResolveVars>({
    mutationFn: ({ commentId, resolved }) =>
      resolved
        ? resolveComment(orgId, commentId)
        : unresolveComment(orgId, commentId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...commentsQueryKeys.all, orgId, kind, entityId],
      });
    },
  });
}

interface FlagVars {
  readonly commentId: string;
  readonly flagged: boolean;
}

export function useSetCommentFlagged(
  orgId: string,
  kind: CommentEntityKind,
  entityId: string,
): UseMutationResult<CommentDto, ApiError, FlagVars> {
  const queryClient = useQueryClient();
  return useMutation<CommentDto, ApiError, FlagVars>({
    mutationFn: ({ commentId, flagged }) =>
      flagged
        ? flagComment(orgId, commentId)
        : unflagComment(orgId, commentId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [...commentsQueryKeys.all, orgId, kind, entityId],
      });
    },
  });
}

export function useMentionableMembers(
  orgId: string,
  query: string,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<MentionableMembersPageDto, ApiError> {
  return useQuery<MentionableMembersPageDto, ApiError>({
    queryKey: commentsQueryKeys.mentionable(orgId, query),
    queryFn: () => fetchMentionableMembers(orgId, query),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
