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
  /** ``client`` is the customer-portal author kind — the inbox row
   *  surfaces it so the staff dropdown can tell apart "Jane replied"
   *  (the customer) from "Mike replied" (a teammate). */
  readonly kind: "member" | "client" | "guest" | "system";
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
  /** Lane discriminator. ``"internal"`` is the staff-only bubble
   *  (proposal internal chat, formulation project chat).
   *  ``"shared"`` is the customer-conversation slot that surfaces
   *  on the kiosk twin. The same ``(entity_kind, entity_id)`` pair
   *  can produce both — keys rows on
   *  ``(entity_kind, entity_id, visibility)`` so the two lanes
   *  render as distinct inbox entries. */
  readonly visibility: "internal" | "shared";
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
  readonly visibility?: "internal" | "shared" | "";
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
