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
