/**
 * Transport types for the client portal.
 *
 * Mirror of the backend serializers in
 * ``apps.client_portal.api.serializers``.
 */

export interface ActivationPreviewDto {
  readonly customer_company: string;
  readonly email_masked: string;
  readonly already_activated: boolean;
  readonly proposal_code: string;
}

export interface PortalMeDto {
  readonly id: string;
  readonly email: string;
  readonly customer_id: string;
  readonly customer_company: string;
  readonly customer_name: string;
  readonly activated_at: string | null;
  readonly avatar_image: string;
}

export interface PortalProposalListItemDto {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly status: string;
  readonly updated_at: string;
  readonly created_at: string;
  readonly public_token: string | null;
}

export interface PortalProposalListDto {
  readonly results: ReadonlyArray<PortalProposalListItemDto>;
}


export interface PortalMessageParentPreview {
  readonly id: string;
  readonly body_preview: string;
  readonly author_name: string;
  readonly author_kind: "staff" | "client";
  readonly is_deleted: boolean;
}


export interface PortalMessageDto {
  readonly id: string;
  readonly body: string;
  readonly created_at: string;
  readonly is_deleted: boolean;
  readonly author_kind: "staff" | "client";
  readonly author_name: string;
  readonly author_avatar: string;
  readonly thread_target_type: "spec" | "proposal" | "other";
  readonly thread_target_id: string;
  readonly parent: PortalMessageParentPreview | null;
}


export interface PortalMessagesDto {
  readonly results: ReadonlyArray<PortalMessageDto>;
  readonly read_state: Record<string, string>;
  readonly spec_ids: ReadonlyArray<string>;
}


export interface PortalProfileDto {
  readonly customer_id: string;
  readonly email: string;
  readonly name: string;
  readonly company: string;
  readonly phone: string;
  readonly invoice_address: string;
  readonly delivery_address: string;
}


export interface ProfileUpdate {
  readonly name?: string;
  readonly company?: string;
  readonly phone?: string;
  readonly invoice_address?: string;
  readonly delivery_address?: string;
}
