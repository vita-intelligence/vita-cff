/**
 * Transport types for the messenger inbox.
 *
 * Mirrors the DRF payload shipped by
 * :class:`apps.comments.api.inbox_views.InboxListView`. Keep this
 * file in lock-step with that view's serialiser so the wire contract
 * is expressed in exactly one place per side.
 */

import type { CommentDto } from "@/services/comments";

export type InboxEntityKind =
  | "formulation"
  | "specification"
  | "proposal"
  | "cff_submission";

export interface InboxOrganizationDto {
  readonly id: string;
  readonly name: string;
}

export interface InboxAuthorDto {
  readonly name: string;
  readonly kind: "member" | "guest" | "system";
}

export interface InboxThreadDto {
  readonly organization: InboxOrganizationDto;
  readonly entity_kind: InboxEntityKind;
  readonly entity_id: string;
  readonly entity_title: string;
  readonly entity_code: string;
  readonly unread_count: number;
  /** ISO-8601 timestamp of the latest message in the thread. */
  readonly last_message_at: string;
  readonly last_message_preview: string;
  readonly last_message_author: InboxAuthorDto;
}

export interface InboxListResponseDto {
  readonly threads: readonly InboxThreadDto[];
  readonly total_unread: number;
}

export interface InboxUnreadCountDto {
  readonly unread_count: number;
}

export interface ThreadMarkReadResponseDto {
  readonly entity_kind: InboxEntityKind;
  readonly entity_id: string;
  readonly organization_id: string;
  readonly last_read_at: string;
}

/**
 * The shape pushed over the inbox WebSocket on every new comment.
 * Carries enough context for the FE to bump the unread counter
 * and surface a notification without an extra fetch.
 */
export interface InboxWsMessageDto {
  readonly comment: CommentDto;
  readonly entity_kind: InboxEntityKind;
  readonly entity_id: string;
  readonly organization_id: string;
}
