import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { ApiError } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import {
  clearDynamicsConfig,
  createCustomer,
  deleteCustomer,
  fetchCustomer,
  fetchCustomers,
  fetchDynamicsConfig,
  importCustomerFromDynamics,
  saveDynamicsConfig,
  searchDynamicsContacts,
  testDynamicsConnection,
  updateCustomer,
} from "./api";
import type {
  CreateCustomerRequestDto,
  CustomerDto,
  DynamicsContactSuggestion,
  DynamicsIntegrationConfigDto,
  DynamicsIntegrationConfigUpdateDto,
  DynamicsSearchResponse,
  UpdateCustomerRequestDto,
} from "./types";


export const customersQueryKeys = {
  all: [rootQueryKey, "customers"] as const,
  list: (orgId: string, search?: string) =>
    [rootQueryKey, "customers", orgId, search ?? ""] as const,
  detail: (orgId: string, customerId: string) =>
    [rootQueryKey, "customers", orgId, customerId] as const,
};


export function useCustomers(
  orgId: string,
  search = "",
): UseQueryResult<CustomerDto[], ApiError> {
  return useQuery<CustomerDto[], ApiError>({
    queryKey: customersQueryKeys.list(orgId, search),
    queryFn: () => fetchCustomers(orgId, search || undefined),
    enabled: Boolean(orgId),
    // Short stale time so the typeahead in the proposal picker
    // shows newly-added customers without the user having to
    // refresh the page.
    staleTime: 5_000,
  });
}


export function useCustomer(
  orgId: string,
  customerId: string,
): UseQueryResult<CustomerDto, ApiError> {
  return useQuery<CustomerDto, ApiError>({
    queryKey: customersQueryKeys.detail(orgId, customerId),
    queryFn: () => fetchCustomer(orgId, customerId),
    enabled: Boolean(orgId && customerId),
  });
}


export function useCreateCustomer(
  orgId: string,
): UseMutationResult<CustomerDto, ApiError, CreateCustomerRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<CustomerDto, ApiError, CreateCustomerRequestDto>({
    mutationFn: (payload) => createCustomer(orgId, payload),
    onSuccess: (created) => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "customers", orgId],
      });
      queryClient.setQueryData(
        customersQueryKeys.detail(orgId, created.id),
        created,
      );
    },
  });
}


export function useUpdateCustomer(
  orgId: string,
  customerId: string,
): UseMutationResult<CustomerDto, ApiError, UpdateCustomerRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<CustomerDto, ApiError, UpdateCustomerRequestDto>({
    mutationFn: (payload) => updateCustomer(orgId, customerId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        customersQueryKeys.detail(orgId, customerId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "customers", orgId],
      });
    },
  });
}


export function useDeleteCustomer(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (customerId) => deleteCustomer(orgId, customerId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "customers", orgId],
      });
    },
  });
}


// ---------------------------------------------------------------------------
// Microsoft Dynamics integration
// ---------------------------------------------------------------------------


export const dynamicsQueryKeys = {
  config: (orgId: string) =>
    [rootQueryKey, "customers", orgId, "dynamics", "config"] as const,
  search: (orgId: string, query: string) =>
    [
      rootQueryKey,
      "customers",
      orgId,
      "dynamics",
      "search",
      query,
    ] as const,
};


export function useDynamicsConfig(
  orgId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<DynamicsIntegrationConfigDto, ApiError> {
  return useQuery<DynamicsIntegrationConfigDto, ApiError>({
    queryKey: dynamicsQueryKeys.config(orgId),
    queryFn: () => fetchDynamicsConfig(orgId),
    enabled: Boolean(orgId) && (options.enabled ?? true),
    // Config rarely changes; no need to refetch on mount more than
    // once per session.
    staleTime: 30_000,
  });
}


export function useSaveDynamicsConfig(
  orgId: string,
): UseMutationResult<
  DynamicsIntegrationConfigDto,
  ApiError,
  DynamicsIntegrationConfigUpdateDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    DynamicsIntegrationConfigDto,
    ApiError,
    DynamicsIntegrationConfigUpdateDto
  >({
    mutationFn: (payload) => saveDynamicsConfig(orgId, payload),
    onSuccess: (next) => {
      queryClient.setQueryData(dynamicsQueryKeys.config(orgId), next);
    },
  });
}


export function useClearDynamicsConfig(
  orgId: string,
): UseMutationResult<DynamicsIntegrationConfigDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<DynamicsIntegrationConfigDto, ApiError, void>({
    mutationFn: () => clearDynamicsConfig(orgId),
    onSuccess: (next) => {
      queryClient.setQueryData(dynamicsQueryKeys.config(orgId), next);
    },
  });
}


export function useTestDynamicsConnection(
  orgId: string,
): UseMutationResult<DynamicsIntegrationConfigDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<DynamicsIntegrationConfigDto, ApiError, void>({
    mutationFn: () => testDynamicsConnection(orgId),
    onSuccess: (next) => {
      queryClient.setQueryData(dynamicsQueryKeys.config(orgId), next);
    },
  });
}


export function useDynamicsContactSearch(
  orgId: string,
  query: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<DynamicsSearchResponse, ApiError> {
  return useQuery<DynamicsSearchResponse, ApiError>({
    queryKey: dynamicsQueryKeys.search(orgId, query),
    queryFn: () => searchDynamicsContacts(orgId, query),
    enabled: Boolean(orgId) && (options.enabled ?? true),
    // The picker drives this with a debounced ``query`` so a short
    // staleTime is fine — we want fresh suggestions per keystroke
    // after the debounce settles.
    staleTime: 5_000,
  });
}


export function useImportCustomerFromDynamics(
  orgId: string,
): UseMutationResult<CustomerDto, ApiError, DynamicsContactSuggestion> {
  const queryClient = useQueryClient();
  return useMutation<CustomerDto, ApiError, DynamicsContactSuggestion>({
    mutationFn: (contact) => importCustomerFromDynamics(orgId, contact),
    onSuccess: (customer) => {
      // The new local row may already exist (re-import dedupes) or
      // be brand new — either way bust the list cache + seed the
      // detail cache so downstream surfaces pick it up.
      queryClient.invalidateQueries({
        queryKey: [rootQueryKey, "customers", orgId],
      });
      queryClient.setQueryData(
        customersQueryKeys.detail(orgId, customer.id),
        customer,
      );
    },
  });
}
