export { commentsEndpoints } from "./endpoints";
export {
  createComment,
  deleteComment,
  editComment,
  fetchCommentsPage,
  fetchMentionableMembers,
  fetchNotifyClientSummary,
  flagComment,
  notifyClient,
  resolveComment,
  unflagComment,
  unresolveComment,
  type CommentEntityKind,
} from "./api";
export {
  commentsQueryKeys,
  useCreateComment,
  useDeleteComment,
  useEditComment,
  useInfiniteComments,
  useMentionableMembers,
  useNotifyClient,
  useNotifyClientSummary,
  useSetCommentFlagged,
  useSetCommentResolved,
} from "./hooks";
export {
  entityStoreKey,
  presenceStoreFor,
  type EntityKey,
  type PresenceState,
  type Viewer,
} from "./presence-store";
export {
  openCommentsSocket,
  openKioskCommentsSocket,
  type CommentsSocketHandle,
  type CommentsSocketHandlers,
} from "./ws-client";
export {
  acceptKioskSpecification,
  type KioskAcceptInput,
  type KioskAcceptEcho,
} from "./kiosk-api";
export type {
  CommentAuthorDto,
  CommentAuthorKind,
  CommentDto,
  CommentMentionRefDto,
  CommentTargetKind,
  CreateCommentRequestDto,
  EditCommentRequestDto,
  MentionableMemberDto,
  MentionableMembersPageDto,
  NotifyClientLatestAlertDto,
  NotifyClientRequestDto,
  NotifyClientResponseDto,
  NotifyClientSummaryDto,
  PaginatedCommentsDto,
} from "./types";
