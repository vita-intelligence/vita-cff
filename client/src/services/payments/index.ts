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
export type PaymentKind = "deposit" | "final";
export type PaymentMethod =
  | "bank_transfer"
  | "card"
  | "stripe"
  | "other";


export interface PaymentDto {
  readonly id: string;
  /** ``deposit`` — bundle-level, per-proposal, unlocks trial batches.
   *  ``final`` — per-formulation, unlocks label design. Existing rows
   *  pre-migration default to ``final`` (label-gate flow). */
  readonly kind: PaymentKind;
  /** Set on ``final`` payments only. ``null`` on ``deposit`` (deposits
   *  are bundle-level and identify their target via ``proposal``). */
  readonly formulation: string | null;
  readonly formulation_code: string;
  readonly formulation_name: string;
  /** Set on ``deposit`` payments only. */
  readonly proposal: string | null;
  readonly proposal_code: string;
  readonly proposal_deposit_percent: string | null;
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
  readonly assigned_finance_officer: string | null;
  readonly assigned_finance_officer_email: string;
  readonly created_at: string;
  readonly updated_at: string;
}


export interface PaymentCreateBody {
  /** ``final`` (default) requires ``formulation``; ``deposit``
   *  requires ``proposal``. */
  readonly kind?: PaymentKind;
  readonly formulation?: string;
  readonly proposal?: string;
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
  detail: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/`,
  approve: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/approve/`,
  void: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/void/`,
  assignFinanceOfficer: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/assign-finance-officer/`,
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


export async function fetchPayment(
  orgId: string,
  paymentId: string,
): Promise<PaymentDto> {
  const { data } = await apiClient.get<PaymentDto>(
    paymentsEndpoints.detail(orgId, paymentId),
  );
  return data;
}


export interface PaymentEditBody {
  readonly amount?: string;
  readonly currency?: string;
  readonly method?: PaymentMethod;
  readonly external_reference?: string;
  readonly invoice_number?: string;
  readonly paid_at?: string;
  readonly notes?: string;
}


export async function patchPayment(
  orgId: string,
  paymentId: string,
  body: PaymentEditBody,
): Promise<PaymentDto> {
  const { data } = await apiClient.patch<PaymentDto>(
    paymentsEndpoints.detail(orgId, paymentId),
    body,
  );
  return data;
}


export async function assignPaymentFinanceOfficer(
  orgId: string,
  paymentId: string,
  financeOfficerId: string | null,
): Promise<PaymentDto> {
  const { data } = await apiClient.post<PaymentDto>(
    paymentsEndpoints.assignFinanceOfficer(orgId, paymentId),
    { finance_officer_id: financeOfficerId },
  );
  return data;
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
  detail: (orgId: string, paymentId: string) =>
    [...rootQueryKey, "payments", orgId, "detail", paymentId] as const,
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


export function usePayment(
  orgId: string,
  paymentId: string,
): UseQueryResult<PaymentDto> {
  return useQuery({
    queryKey: paymentsQueryKeys.detail(orgId, paymentId),
    queryFn: () => fetchPayment(orgId, paymentId),
    enabled: Boolean(orgId && paymentId),
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


export function usePatchPayment(orgId: string, paymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PaymentEditBody) =>
      patchPayment(orgId, paymentId, body),
    onSuccess: () => {
      qc.refetchQueries({
        queryKey: paymentsQueryKeys.detail(orgId, paymentId),
      });
      _invalidatePaymentLists(qc, orgId);
    },
  });
}


export function useAssignPaymentFinanceOfficer(
  orgId: string,
  paymentId: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (financeOfficerId: string | null) =>
      assignPaymentFinanceOfficer(orgId, paymentId, financeOfficerId),
    onSuccess: () => {
      qc.refetchQueries({
        queryKey: paymentsQueryKeys.detail(orgId, paymentId),
      });
      _invalidatePaymentLists(qc, orgId);
    },
  });
}
