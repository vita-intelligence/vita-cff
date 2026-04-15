/**
 * Transport types for the attributes domain.
 *
 * Mirrors the backend ``AttributeDefinitionReadSerializer``.
 * Definitions are scoped to a catalogue by the URL path, so the DTO
 * itself does not carry a catalogue reference.
 */

export const DATA_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "single_select",
  "multi_select",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export interface AttributeOption {
  readonly value: string;
  readonly label: string;
}

export interface AttributeDefinitionDto {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly data_type: DataType;
  readonly required: boolean;
  readonly options: readonly AttributeOption[];
  readonly display_order: number;
  readonly is_archived: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateAttributeDefinitionRequestDto {
  readonly key: string;
  readonly label: string;
  readonly data_type: DataType;
  readonly required?: boolean;
  readonly options?: readonly AttributeOption[];
  readonly display_order?: number;
}

export interface UpdateAttributeDefinitionRequestDto {
  readonly label?: string;
  readonly required?: boolean;
  readonly options?: readonly AttributeOption[];
  readonly display_order?: number;
  readonly is_archived?: boolean;
}
