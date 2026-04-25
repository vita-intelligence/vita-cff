/**
 * Transport types for the catalogues domain.
 *
 * Mirrors the backend ``CatalogueReadSerializer`` and
 * ``ItemReadSerializer`` output.
 */

/**
 * Slugs of the two system catalogues that every organization seeds
 * automatically. Business logic that references raw materials or
 * packaging should import these constants rather than embed the
 * magic string inline.
 */
export const RAW_MATERIALS_SLUG = "raw_materials" as const;
export const PACKAGING_SLUG = "packaging" as const;

export interface CatalogueDto {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly is_system: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateCatalogueRequestDto {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export interface UpdateCatalogueRequestDto {
  readonly name?: string;
  readonly description?: string;
}

/**
 * Cursor-paginated list response shape from DRF's
 * :class:`CursorPagination`. ``next`` / ``previous`` are full URLs the
 * client follows verbatim; they are opaque from our side.
 */
export interface PaginatedItemsDto {
  readonly next: string | null;
  readonly previous: string | null;
  readonly results: readonly ItemDto[];
}

export interface ItemsListQuery {
  readonly includeArchived?: boolean;
  readonly ordering?: string;
  readonly pageSize?: number;
  /** Case-insensitive contains match against name + internal_code. */
  readonly search?: string;
  /** Filter to items whose ``attributes.use_as`` matches one of the
   *  provided canonical values. Powers the gummy-base picker (filters
   *  to ``Sweeteners``/``Bulking Agent``). Values are normalised
   *  server-side so callers can pass casing-drift strings safely. */
  readonly useAsIn?: readonly string[];
}

export interface ItemDto {
  readonly id: string;
  readonly name: string;
  readonly internal_code: string;
  readonly unit: string;
  /** Decimal serialized as string by DRF. Use ``parseFloat`` for display. */
  readonly base_price: string | null;
  readonly is_archived: boolean;
  /**
   * Dynamic attribute map keyed by ``AttributeDefinition.key``. Values
   * follow the shape declared by each definition's ``data_type``.
   */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface CreateItemRequestDto {
  readonly name: string;
  readonly internal_code?: string;
  readonly unit?: string;
  readonly base_price?: string | null;
  readonly attributes?: Record<string, unknown>;
}

export interface UpdateItemRequestDto {
  readonly name?: string;
  readonly internal_code?: string;
  readonly unit?: string;
  readonly base_price?: string | null;
  readonly is_archived?: boolean;
  readonly attributes?: Record<string, unknown>;
}

export interface ImportItemsRowError {
  readonly row: number;
  readonly errors: Readonly<Record<string, readonly string[]>>;
}

export interface ImportItemsResultDto {
  readonly created: number;
  readonly errors: readonly ImportItemsRowError[];
  readonly unmapped_columns: readonly string[];
}
