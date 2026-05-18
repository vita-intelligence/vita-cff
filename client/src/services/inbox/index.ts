export { inboxEndpoints } from "./endpoints";
export {
  fetchInbox,
  fetchInboxUnreadCount,
  markThreadRead,
} from "./api";
export {
  inboxQueryKeys,
  useInboxList,
  useInboxUnreadCount,
  useMarkThreadRead,
} from "./hooks";
export {
  openInboxSocket,
  type InboxSocketHandle,
  type InboxSocketHandlers,
} from "./ws-client";
export type {
  InboxAuthorDto,
  InboxEntityKind,
  InboxListResponseDto,
  InboxOrganizationDto,
  InboxThreadDto,
  InboxUnreadCountDto,
  InboxWsMessageDto,
  ThreadMarkReadResponseDto,
} from "./types";
