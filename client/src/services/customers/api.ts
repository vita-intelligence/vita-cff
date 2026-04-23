import { apiClient } from "@/lib/api";

import { customersEndpoints } from "./endpoints";
import type {
  CreateCustomerRequestDto,
  CustomerDto,
  UpdateCustomerRequestDto,
} from "./types";


export async function fetchCustomers(
  orgId: string,
  search?: string,
): Promise<CustomerDto[]> {
  const { data } = await apiClient.get<CustomerDto[]>(
    customersEndpoints.list(orgId, search),
  );
  return data;
}

export async function fetchCustomer(
  orgId: string,
  customerId: string,
): Promise<CustomerDto> {
  const { data } = await apiClient.get<CustomerDto>(
    customersEndpoints.detail(orgId, customerId),
  );
  return data;
}

export async function createCustomer(
  orgId: string,
  payload: CreateCustomerRequestDto,
): Promise<CustomerDto> {
  const { data } = await apiClient.post<CustomerDto>(
    customersEndpoints.list(orgId),
    payload,
  );
  return data;
}

export async function updateCustomer(
  orgId: string,
  customerId: string,
  payload: UpdateCustomerRequestDto,
): Promise<CustomerDto> {
  const { data } = await apiClient.patch<CustomerDto>(
    customersEndpoints.detail(orgId, customerId),
    payload,
  );
  return data;
}

export async function deleteCustomer(
  orgId: string,
  customerId: string,
): Promise<void> {
  await apiClient.delete(customersEndpoints.detail(orgId, customerId));
}
