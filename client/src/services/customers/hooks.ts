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
  createCustomer,
  deleteCustomer,
  fetchCustomer,
  fetchCustomers,
  updateCustomer,
} from "./api";
import type {
  CreateCustomerRequestDto,
  CustomerDto,
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
