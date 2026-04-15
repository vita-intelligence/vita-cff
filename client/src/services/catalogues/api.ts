/**
 * Raw Axios calls for the catalogues domain.
 *
 * Every endpoint takes the target catalogue ``slug`` as its second
 * argument (after ``orgId``) so callers never embed hardcoded
 * references to raw_materials / packaging.
 */

import { apiClient } from "@/lib/api";

import { cataloguesEndpoints } from "./endpoints";
import type {
  CatalogueDto,
  CreateCatalogueRequestDto,
  CreateItemRequestDto,
  ImportItemsResultDto,
  ItemDto,
  ItemsListQuery,
  PaginatedItemsDto,
  UpdateCatalogueRequestDto,
  UpdateItemRequestDto,
} from "./types";


// ---------------------------------------------------------------------------
// Catalogue metadata
// ---------------------------------------------------------------------------


export async function fetchCatalogues(orgId: string): Promise<CatalogueDto[]> {
  const { data } = await apiClient.get<CatalogueDto[]>(
    cataloguesEndpoints.catalogueList(orgId),
  );
  return data;
}

export async function fetchCatalogue(
  orgId: string,
  slug: string,
): Promise<CatalogueDto> {
  const { data } = await apiClient.get<CatalogueDto>(
    cataloguesEndpoints.catalogueDetail(orgId, slug),
  );
  return data;
}

export async function createCatalogue(
  orgId: string,
  payload: CreateCatalogueRequestDto,
): Promise<CatalogueDto> {
  const { data } = await apiClient.post<CatalogueDto>(
    cataloguesEndpoints.catalogueList(orgId),
    payload,
  );
  return data;
}

export async function updateCatalogue(
  orgId: string,
  slug: string,
  payload: UpdateCatalogueRequestDto,
): Promise<CatalogueDto> {
  const { data } = await apiClient.patch<CatalogueDto>(
    cataloguesEndpoints.catalogueDetail(orgId, slug),
    payload,
  );
  return data;
}

export async function deleteCatalogue(
  orgId: string,
  slug: string,
): Promise<void> {
  await apiClient.delete(cataloguesEndpoints.catalogueDetail(orgId, slug));
}


// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------


export interface FetchItemsPageArgs extends ItemsListQuery {
  /** Full ``next``/``previous`` URL from a prior cursor response. */
  readonly cursorUrl?: string | null;
}

/**
 * Fetch one page of items inside the given catalogue. When
 * ``cursorUrl`` is provided the request follows the opaque cursor the
 * backend returned on the previous response; otherwise it hits the
 * list endpoint with the ordering and filter params turned into query
 * strings.
 */
export async function fetchItemsPage(
  orgId: string,
  slug: string,
  args: FetchItemsPageArgs = {},
): Promise<PaginatedItemsDto> {
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedItemsDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }

  const params: Record<string, string> = {};
  if (args.includeArchived) params.include_archived = "true";
  if (args.ordering) params.ordering = args.ordering;
  if (args.pageSize) params.page_size = String(args.pageSize);
  if (args.search && args.search.trim()) params.search = args.search.trim();
  const { data } = await apiClient.get<PaginatedItemsDto>(
    cataloguesEndpoints.itemList(orgId, slug),
    { params },
  );
  return data;
}

export async function fetchItem(
  orgId: string,
  slug: string,
  itemId: string,
): Promise<ItemDto> {
  const { data } = await apiClient.get<ItemDto>(
    cataloguesEndpoints.itemDetail(orgId, slug, itemId),
  );
  return data;
}

export async function createItem(
  orgId: string,
  slug: string,
  payload: CreateItemRequestDto,
): Promise<ItemDto> {
  const { data } = await apiClient.post<ItemDto>(
    cataloguesEndpoints.itemList(orgId, slug),
    payload,
  );
  return data;
}

export async function updateItem(
  orgId: string,
  slug: string,
  itemId: string,
  payload: UpdateItemRequestDto,
): Promise<ItemDto> {
  const { data } = await apiClient.patch<ItemDto>(
    cataloguesEndpoints.itemDetail(orgId, slug, itemId),
    payload,
  );
  return data;
}

export async function archiveItem(
  orgId: string,
  slug: string,
  itemId: string,
): Promise<void> {
  await apiClient.delete(cataloguesEndpoints.itemDetail(orgId, slug, itemId));
}

/**
 * Permanently delete an item. The row is removed from the database
 * and cannot be restored. The UI must always confirm before calling.
 */
export async function hardDeleteItem(
  orgId: string,
  slug: string,
  itemId: string,
): Promise<void> {
  await apiClient.delete(cataloguesEndpoints.itemDetail(orgId, slug, itemId), {
    params: { hard: "true" },
  });
}

/**
 * Bulk-import items from an ``.xlsx`` workbook into ``slug``.
 *
 * The server streams through the rows, creating each one in its own
 * savepoint. The returned summary lists per-row failures and any
 * column headers that could not be mapped to a builtin field or an
 * active attribute definition.
 */
export async function importItems(
  orgId: string,
  slug: string,
  file: File,
): Promise<ImportItemsResultDto> {
  const body = new FormData();
  body.append("file", file);
  const { data } = await apiClient.post<ImportItemsResultDto>(
    cataloguesEndpoints.itemImport(orgId, slug),
    body,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data;
}
