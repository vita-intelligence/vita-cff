/**
 * TanStack Query hooks for the catalogues domain.
 *
 * Query keys embed both the org id and the catalogue slug so a page
 * navigating between catalogues (raw materials → packaging) starts a
 * clean cache and never reuses rows from another scope.
 */

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  archiveItem,
  createCatalogue,
  createItem,
  deleteCatalogue,
  fetchCatalogue,
  fetchCatalogues,
  fetchItem,
  fetchItemsPage,
  hardDeleteItem,
  importItems,
  updateCatalogue,
  updateItem,
} from "./api";
import type {
  CatalogueDto,
  CreateCatalogueRequestDto,
  CreateItemRequestDto,
  ImportItemsResultDto,
  ItemDto,
  PaginatedItemsDto,
  UpdateCatalogueRequestDto,
  UpdateItemRequestDto,
} from "./types";

export const cataloguesQueryKeys = {
  all: [...rootQueryKey, "catalogues"] as const,
  catalogueList: (orgId: string) =>
    [...cataloguesQueryKeys.all, orgId, "list"] as const,
  catalogueDetail: (orgId: string, slug: string) =>
    [...cataloguesQueryKeys.all, orgId, "detail", slug] as const,
  itemList: (orgId: string, slug: string) =>
    [...cataloguesQueryKeys.all, orgId, slug, "items"] as const,
  itemInfinite: (
    orgId: string,
    slug: string,
    opts: {
      includeArchived: boolean;
      ordering: string;
      search?: string;
      useAs?: string;
    },
  ) =>
    [
      ...cataloguesQueryKeys.all,
      orgId,
      slug,
      "items",
      "infinite",
      opts.includeArchived ? "archived" : "active",
      opts.ordering,
      // Empty string collapses to the same cache key as undefined so
      // the picker does not thrash between two keys when the user
      // clears their search.
      (opts.search ?? "").trim(),
      opts.useAs ?? "",
    ] as const,
  itemDetail: (orgId: string, slug: string, itemId: string) =>
    [
      ...cataloguesQueryKeys.all,
      orgId,
      slug,
      "items",
      "detail",
      itemId,
    ] as const,
} as const;


// ---------------------------------------------------------------------------
// Catalogue metadata
// ---------------------------------------------------------------------------


export function useCatalogues(
  orgId: string,
): UseQueryResult<CatalogueDto[], ApiError> {
  return useQuery<CatalogueDto[], ApiError>({
    queryKey: cataloguesQueryKeys.catalogueList(orgId),
    queryFn: () => fetchCatalogues(orgId),
  });
}

export function useCatalogue(
  orgId: string,
  slug: string,
): UseQueryResult<CatalogueDto, ApiError> {
  return useQuery<CatalogueDto, ApiError>({
    queryKey: cataloguesQueryKeys.catalogueDetail(orgId, slug),
    queryFn: () => fetchCatalogue(orgId, slug),
  });
}

export function useCreateCatalogue(
  orgId: string,
): UseMutationResult<CatalogueDto, ApiError, CreateCatalogueRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<CatalogueDto, ApiError, CreateCatalogueRequestDto>({
    mutationFn: (payload) => createCatalogue(orgId, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.catalogueList(orgId),
      });
    },
  });
}

export function useUpdateCatalogue(
  orgId: string,
  slug: string,
): UseMutationResult<CatalogueDto, ApiError, UpdateCatalogueRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<CatalogueDto, ApiError, UpdateCatalogueRequestDto>({
    mutationFn: (payload) => updateCatalogue(orgId, slug, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.catalogueList(orgId),
      });
    },
  });
}

export function useDeleteCatalogue(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (slug) => deleteCatalogue(orgId, slug),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.catalogueList(orgId),
      });
    },
  });
}


// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------


export function useInfiniteItems(
  orgId: string,
  slug: string,
  options: {
    includeArchived: boolean;
    ordering: string;
    pageSize?: number;
    /**
     * Case-insensitive ``name`` / ``internal_code`` filter. Empty
     * strings are treated the same as ``undefined`` so the cache
     * does not thrash as the user clears the input.
     */
    search?: string;
    /** Filter items by ``use_as`` — typically a fixed array the
     *  caller reuses (e.g. ``["Sweeteners", "Bulking Agent"]`` for
     *  the gummy-base picker). */
    useAsIn?: readonly string[];
    initialFirstPage?: PaginatedItemsDto | null;
  },
): UseInfiniteQueryResult<InfiniteData<PaginatedItemsDto, string | null>, ApiError> {
  const {
    includeArchived,
    ordering,
    pageSize,
    search,
    useAsIn,
    initialFirstPage,
  } = options;
  const normalisedSearch = (search ?? "").trim() || undefined;
  const useAsKey =
    useAsIn && useAsIn.length > 0 ? [...useAsIn].sort().join(",") : undefined;
  return useInfiniteQuery<
    PaginatedItemsDto,
    ApiError,
    InfiniteData<PaginatedItemsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: cataloguesQueryKeys.itemInfinite(orgId, slug, {
      includeArchived,
      ordering,
      search: normalisedSearch,
      useAs: useAsKey,
    }),
    queryFn: ({ pageParam }) =>
      fetchItemsPage(orgId, slug, {
        includeArchived,
        ordering,
        pageSize,
        search: normalisedSearch,
        useAsIn,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    // Only hydrate with the SSR page when we are not filtering —
    // an SSR snapshot from an unfiltered request would be wrong for
    // an active search.
    initialData:
      initialFirstPage && normalisedSearch === undefined
        ? {
            pages: [initialFirstPage],
            pageParams: [null],
          }
        : undefined,
  });
}

export function useItem(
  orgId: string,
  slug: string,
  itemId: string,
  options: { readonly initialData?: ItemDto } = {},
): UseQueryResult<ItemDto, ApiError> {
  return useQuery<ItemDto, ApiError>({
    queryKey: cataloguesQueryKeys.itemDetail(orgId, slug, itemId),
    queryFn: () => fetchItem(orgId, slug, itemId),
    initialData: options.initialData,
  });
}

export function useCreateItem(
  orgId: string,
  slug: string,
): UseMutationResult<ItemDto, ApiError, CreateItemRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<ItemDto, ApiError, CreateItemRequestDto>({
    mutationFn: (payload) => createItem(orgId, slug, payload),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.itemList(orgId, slug),
      });
    },
  });
}

export function useUpdateItem(
  orgId: string,
  slug: string,
  itemId: string,
): UseMutationResult<ItemDto, ApiError, UpdateItemRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<ItemDto, ApiError, UpdateItemRequestDto>({
    mutationFn: (payload) => updateItem(orgId, slug, itemId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        cataloguesQueryKeys.itemDetail(orgId, slug, itemId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.itemList(orgId, slug),
      });
    },
  });
}

export function useArchiveItem(
  orgId: string,
  slug: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (itemId) => archiveItem(orgId, slug, itemId),
    onSuccess: (_, itemId) => {
      queryClient.removeQueries({
        queryKey: cataloguesQueryKeys.itemDetail(orgId, slug, itemId),
      });
      queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.itemList(orgId, slug),
      });
    },
  });
}

export function useHardDeleteItem(
  orgId: string,
  slug: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (itemId) => hardDeleteItem(orgId, slug, itemId),
    onSuccess: (_, itemId) => {
      queryClient.removeQueries({
        queryKey: cataloguesQueryKeys.itemDetail(orgId, slug, itemId),
      });
      queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.itemList(orgId, slug),
      });
    },
  });
}

export function useImportItems(
  orgId: string,
  slug: string,
): UseMutationResult<ImportItemsResultDto, ApiError, File> {
  const queryClient = useQueryClient();
  return useMutation<ImportItemsResultDto, ApiError, File>({
    mutationFn: (file) => importItems(orgId, slug, file),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: cataloguesQueryKeys.itemList(orgId, slug),
      });
    },
  });
}
