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

  // Axios turns a URL-param object into a query string; a ``use_as``
  // array has to go through ``URLSearchParams`` so each value becomes
  // a repeated ``?use_as=X&use_as=Y`` pair (matching what the
  // server's ``getlist`` reads).
  const searchParams = new URLSearchParams();
  if (args.includeArchived) searchParams.set("include_archived", "true");
  if (args.ordering) searchParams.set("ordering", args.ordering);
  if (args.pageSize) searchParams.set("page_size", String(args.pageSize));
  if (args.search && args.search.trim())
    searchParams.set("search", args.search.trim());
  if (args.useAsIn && args.useAsIn.length > 0) {
    for (const value of args.useAsIn) {
      searchParams.append("use_as", value);
    }
  }
  const qs = searchParams.toString();
  const url = qs
    ? `${cataloguesEndpoints.itemList(orgId, slug)}?${qs}`
    : cataloguesEndpoints.itemList(orgId, slug);
  const { data } = await apiClient.get<PaginatedItemsDto>(url);
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

/**
 * Download the import template for ``slug`` as a ``Blob``.
 *
 * The server renders the spreadsheet on demand against the live
 * attribute schema — there is no cached asset to stale out — so
 * callers just hand the blob to the browser's download pipeline.
 */
export async function downloadImportTemplate(
  orgId: string,
  slug: string,
): Promise<Blob> {
  const { data } = await apiClient.get<Blob>(
    cataloguesEndpoints.itemImportTemplate(orgId, slug),
    { responseType: "blob" },
  );
  return data;
}
