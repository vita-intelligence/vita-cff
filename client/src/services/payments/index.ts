import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { rootQueryKey } from "@/lib/query";

import { labelDesignKeys } from "@/services/label-design";


export type PaymentStatus = "pending" | "approved" | "voided";
export type PaymentMethod =
  | "bank_transfer"
  | "card"
  | "stripe"
  | "other";


export interface PaymentDto {
  readonly id: string;
  readonly formulation: string;
  readonly formulation_code: string;
  readonly formulation_name: string;
  readonly label_design: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly method: PaymentMethod;
  readonly external_reference: string;
  readonly invoice_number: string;
  readonly paid_at: string;
  readonly recorded_by: string;
  readonly recorded_by_email: string;
  readonly approved_by: string | null;
  readonly approved_by_email: string;
  readonly approved_at: string | null;
  readonly status: PaymentStatus;
  readonly notes: string;
  readonly created_at: string;
  readonly updated_at: string;
}


export interface PaymentCreateBody {
  readonly formulation: string;
  readonly amount: string;
  readonly currency?: string;
  readonly method?: PaymentMethod;
  readonly external_reference?: string;
  readonly invoice_number?: string;
  readonly paid_at: string;
  readonly notes?: string;
}


const paymentsEndpoints = {
  list: (orgId: string) => `/api/organizations/${orgId}/payments/`,
  approve: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/approve/`,
  void: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/void/`,
  pendingProjects: (orgId: string) =>
    `/api/organizations/${orgId}/payments/pending-projects/`,
};


export interface PendingProjectDto {
  readonly formulation_id: string;
  readonly formulation_code: string;
  readonly formulation_name: string;
  readonly label_design_id: string;
  readonly label_design_created_at: string;
  readonly proposal_code: string;
  readonly proposal_id: string | null;
  /** Quoted total (``subtotal``) from the linked proposal — used to
   *  pre-populate the record-payment dialog so finance doesn't have
   *  to look up the figure manually. ``null`` when the proposal
   *  carries no pricing yet. */
  readonly proposal_amount: string | null;
  /** ISO-4217 currency code from the linked proposal (e.g. "GBP"). */
  readonly proposal_currency: string;
  readonly customer_name: string;
  readonly customer_company: string;
  readonly customer_email: string;
}


export interface PendingProjectsPage {
  readonly items: ReadonlyArray<PendingProjectDto>;
  readonly total: number;
  readonly has_more: boolean;
  readonly next_offset: number | null;
}


export async function fetchPendingPaymentProjects(
  orgId: string,
  options: {
    readonly search?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<PendingProjectsPage> {
  const params = new URLSearchParams();
  if (options.search) params.set("search", options.search);
  if (typeof options.limit === "number")
    params.set("limit", String(options.limit));
  if (typeof options.offset === "number")
    params.set("offset", String(options.offset));
  const qs = params.toString();
  const url = qs
    ? `${paymentsEndpoints.pendingProjects(orgId)}?${qs}`
    : paymentsEndpoints.pendingProjects(orgId);
  const { data } = await apiClient.get<PendingProjectsPage>(url);
  return data;
}


export async function fetchPayments(
  orgId: string,
  status?: string,
): Promise<ReadonlyArray<PaymentDto>> {
  const url = status
    ? `${paymentsEndpoints.list(orgId)}?status=${encodeURIComponent(status)}`
    : paymentsEndpoints.list(orgId);
  const { data } = await apiClient.get<{ items: PaymentDto[] }>(url);
  return data.items;
}


export async function recordPayment(
  orgId: string,
  body: PaymentCreateBody,
): Promise<PaymentDto> {
  const { data } = await apiClient.post<PaymentDto>(
    paymentsEndpoints.list(orgId),
    body,
  );
  return data;
}


export async function approvePayment(
  orgId: string,
  paymentId: string,
): Promise<PaymentDto> {
  const { data } = await apiClient.post<PaymentDto>(
    paymentsEndpoints.approve(orgId, paymentId),
    {},
  );
  return data;
}


export async function voidPayment(
  orgId: string,
  paymentId: string,
  notes: string,
): Promise<PaymentDto> {
  const { data } = await apiClient.post<PaymentDto>(
    paymentsEndpoints.void(orgId, paymentId),
    { notes },
  );
  return data;
}


export const paymentsQueryKeys = {
  list: (orgId: string, status?: string) =>
    [...rootQueryKey, "payments", orgId, status ?? "all"] as const,
  pendingProjects: (orgId: string, search: string) =>
    [
      ...rootQueryKey,
      "payments",
      orgId,
      "pending-projects",
      search,
    ] as const,
} as const;


const PENDING_PAGE_SIZE = 20;


export function usePayments(
  orgId: string,
  status?: string,
): UseQueryResult<ReadonlyArray<PaymentDto>> {
  return useQuery({
    queryKey: paymentsQueryKeys.list(orgId, status),
    queryFn: () => fetchPayments(orgId, status),
    enabled: Boolean(orgId),
  });
}


export function usePendingPaymentProjects(
  orgId: string,
  search: string = "",
): UseInfiniteQueryResult<
  { pages: PendingProjectsPage[]; pageParams: unknown[] },
  Error
> {
  return useInfiniteQuery({
    queryKey: paymentsQueryKeys.pendingProjects(orgId, search),
    queryFn: ({ pageParam }) =>
      fetchPendingPaymentProjects(orgId, {
        search,
        limit: PENDING_PAGE_SIZE,
        offset: (pageParam as number) ?? 0,
      }),
    initialPageParam: 0 as number,
    getNextPageParam: (last: PendingProjectsPage) =>
      last.has_more ? last.next_offset : undefined,
    enabled: Boolean(orgId),
  });
}


function _invalidatePaymentLists(
  qc: ReturnType<typeof useQueryClient>,
  orgId: string,
) {
  // Invalidate every (status) variant of the payments list.
  qc.invalidateQueries({ queryKey: [...rootQueryKey, "payments", orgId] });
  // The LabelDesign for the paid project transitions on approve, so
  // the label-design caches also need a refresh.
  qc.invalidateQueries({ queryKey: labelDesignKeys.all });
}


export function useRecordPayment(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PaymentCreateBody) => recordPayment(orgId, body),
    onSuccess: () => _invalidatePaymentLists(qc, orgId),
  });
}


export function useApprovePayment(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) => approvePayment(orgId, paymentId),
    onSuccess: () => _invalidatePaymentLists(qc, orgId),
  });
}


export function useVoidPayment(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { paymentId: string; notes: string }) =>
      voidPayment(orgId, args.paymentId, args.notes),
    onSuccess: () => _invalidatePaymentLists(qc, orgId),
  });
}
