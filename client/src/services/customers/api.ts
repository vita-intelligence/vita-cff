import { apiClient } from "@/lib/api";

import { customersEndpoints } from "./endpoints";
import type {
  CreateCustomerRequestDto,
  CustomerDto,
  DynamicsContactSuggestion,
  DynamicsIntegrationConfigDto,
  DynamicsIntegrationConfigUpdateDto,
  DynamicsSearchResponse,
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


// ---------------------------------------------------------------------------
// Microsoft Dynamics integration
// ---------------------------------------------------------------------------


export async function fetchDynamicsConfig(
  orgId: string,
): Promise<DynamicsIntegrationConfigDto> {
  const { data } = await apiClient.get<DynamicsIntegrationConfigDto>(
    customersEndpoints.dynamicsConfig(orgId),
  );
  return data;
}


export async function saveDynamicsConfig(
  orgId: string,
  payload: DynamicsIntegrationConfigUpdateDto,
): Promise<DynamicsIntegrationConfigDto> {
  const { data } = await apiClient.put<DynamicsIntegrationConfigDto>(
    customersEndpoints.dynamicsConfig(orgId),
    payload,
  );
  return data;
}


export async function clearDynamicsConfig(
  orgId: string,
): Promise<DynamicsIntegrationConfigDto> {
  const { data } = await apiClient.delete<DynamicsIntegrationConfigDto>(
    customersEndpoints.dynamicsConfig(orgId),
  );
  return data;
}


export async function testDynamicsConnection(
  orgId: string,
): Promise<DynamicsIntegrationConfigDto> {
  const { data } = await apiClient.post<DynamicsIntegrationConfigDto>(
    customersEndpoints.dynamicsTest(orgId),
    {},
  );
  return data;
}


export async function searchDynamicsContacts(
  orgId: string,
  query: string,
  limit = 10,
): Promise<DynamicsSearchResponse> {
  const { data } = await apiClient.get<DynamicsSearchResponse>(
    customersEndpoints.dynamicsSearch(orgId, query, limit),
  );
  return data;
}


export async function importCustomerFromDynamics(
  orgId: string,
  contact: DynamicsContactSuggestion,
): Promise<CustomerDto> {
  const { data } = await apiClient.post<CustomerDto>(
    customersEndpoints.dynamicsImport(orgId),
    contact,
  );
  return data;
}
