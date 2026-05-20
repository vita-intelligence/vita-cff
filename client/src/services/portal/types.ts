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
