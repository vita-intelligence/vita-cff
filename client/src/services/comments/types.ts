/**
 * Transport types for the comments domain.
 *
 * The shapes mirror the Django ``apps.comments`` serializers — keep
 * this file in lock-step with ``server/apps/comments/api/
 * serializers.py`` so the wire contract is expressed in exactly one
 * place on each side.
 */

export type CommentTargetKind =
  | "formulation"
  | "specification"
  | "unknown";

export type CommentAuthorKind = "member" | "guest" | "system";

export interface CommentAuthorDto {
  readonly id: string | null;
  readonly kind: CommentAuthorKind;
  readonly name: string;
  readonly email: string;
  readonly org_label: string;
  /** Opaque profile-photo URL. Base64 data URL today, blob-storage
   *  URL tomorrow — treated as a string by every consumer. */
  readonly avatar_url: string;
}

export interface CommentMentionRefDto {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface CommentDto {
  readonly id: string;
  readonly parent_id: string | null;
  readonly target_type: CommentTargetKind;
  readonly target_id: string | null;
  readonly author: CommentAuthorDto;
  readonly body: string;
  readonly mentions: readonly CommentMentionRefDto[];
  //: ``true`` when a teammate has explicitly flagged this root as
  //: needing resolution. Pins the thread to the top of the list and
  //: unlocks the ``resolve`` action on the UI.
  readonly needs_resolution: boolean;
  readonly is_resolved: boolean;
  readonly is_edited: boolean;
  readonly is_deleted: boolean;
  readonly created_at: string;
  readonly updated_at: string;
  readonly edited_at: string | null;
  readonly resolved_at: string | null;
  readonly deleted_at: string | null;
}

export interface PaginatedCommentsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly CommentDto[];
}

export interface CreateCommentRequestDto {
  readonly body: string;
  readonly parent_id?: string | null;
}

export interface EditCommentRequestDto {
  readonly body: string;
}

export interface MentionableMemberDto {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly avatar_url?: string;
}

export interface MentionableMembersPageDto {
  readonly results: readonly MentionableMemberDto[];
}


// ---------------------------------------------------------------------------
// Notify-client (kiosk alert) DTOs
// ---------------------------------------------------------------------------


export interface NotifyClientLatestAlertDto {
  readonly id: string;
  /** ``queued`` | ``sent`` | ``failed`` | ``skipped`` — the FE
   *  cares mostly about ``sent`` for the "Last notified X ago"
   *  hint, but we surface the rest so an admin can inspect a
   *  partial / failed batch. */
  readonly status: string;
  readonly recipient_email: string;
  readonly triggered_by: string;
  readonly created_at: string;
  readonly sent_at: string | null;
}

export interface NotifyClientSummaryDto {
  readonly recipient_count: number;
  readonly last_alert: NotifyClientLatestAlertDto | null;
  readonly custom_note_max_length: number;
}

export interface NotifyClientRequestDto {
  readonly note?: string;
}

export interface NotifyClientResponseDto {
  readonly notified_count: number;
  readonly sent_emails: readonly string[];
  readonly skipped_emails: readonly string[];
  readonly failed_emails: readonly string[];
  readonly last_alert: NotifyClientLatestAlertDto | null;
}
