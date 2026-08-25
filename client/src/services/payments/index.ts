import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiClient } from "@/lib/api";
import { useOrgFeed } from "@/lib/live/use-org-feed";
import { rootQueryKey } from "@/lib/query";

import { labelDesignKeys } from "@/services/label-design";


export type PaymentStatus = "pending" | "approved" | "voided";
export type PaymentKind = "deposit" | "final";
export type PaymentMethod =
  | "bank_transfer"
  | "card"
  | "stripe"
  | "other";


export interface PaymentInvoiceDto {
  readonly id: string;
  readonly url: string | null;
  readonly filename: string;
  readonly mime: string;
  readonly byte_size: number;
  readonly uploaded_by_email: string;
  readonly uploaded_at: string;
}


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
  /** ``custom`` or ``ready_to_go`` — drives whether the finance card
   *  parenthesises the code alongside the display name. Empty string
   *  when the payment isn't linked to a formulation (deposits). */
  readonly formulation_project_type: "" | "custom" | "ready_to_go";
  /** Storefront-facing product name for RTG SKUs (rtg_display_name,
   *  e.g. "Ultimate Fat Burner Drink"), falling back to the internal
   *  formulation.name for Custom projects. Empty string when the
   *  payment isn't linked to a formulation. */
  readonly formulation_display_name: string;
  /** Set on ``deposit`` payments only. */
  readonly proposal: string | null;
  readonly proposal_code: string;
  readonly proposal_deposit_percent: string | null;
  /** Denormalized customer identity. ``customer`` is the FK id or
   *  ``null`` for legacy imported rows that pre-date the storefront
   *  checkout wiring; the three mirrors carry the address-book fields
   *  the card renders (falls back to an empty string when unlinked). */
  readonly customer: string | null;
  readonly customer_company: string;
  readonly customer_name: string;
  readonly customer_email: string;
  readonly label_design: string | null;
  readonly amount: string;
  readonly currency: string;
  readonly method: PaymentMethod;
  readonly external_reference: string;
  readonly invoice_number: string;
  readonly invoices: ReadonlyArray<PaymentInvoiceDto>;
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
  invoices: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/invoices/`,
  invoice: (orgId: string, paymentId: string, fileId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/invoices/${fileId}/`,
  pspInvoices: (orgId: string, paymentId: string) =>
    `/api/organizations/${orgId}/payments/${paymentId}/psp-invoices/`,
  awaitingDeposits: (orgId: string) =>
    `/api/organizations/${orgId}/payments/awaiting-deposits/`,
};

/** One PSP-side ``CustomerInvoice`` mirrored onto the finance detail
 *  page. Amounts arrive as strings so JS number imprecision never
 *  touches money display. Draft invoices are surfaced too (with
 *  their status chip) so the finance user sees the full picture. */
export interface PspInvoiceDto {
  readonly uuid: string;
  readonly kind: string;
  readonly status: string;
  readonly currency_code: string;
  readonly subtotal: string;
  readonly tax_amount: string;
  readonly grand_total: string;
  readonly invoice_date: string | null;
  readonly due_date: string | null;
  readonly sent_at: string | null;
  readonly cancelled_at: string | null;
  readonly inserted_at: string;
}

export interface PspInvoicesResponse {
  readonly invoices: ReadonlyArray<PspInvoiceDto>;
  /** ``false`` when the payment kind doesn't map to a PSP CO uuid
   *  (currently: deposit payments). FE hides the card entirely in
   *  that case rather than showing "no invoices" which reads as an
   *  operator problem. */
  readonly supported: boolean;
}


export interface AwaitingDepositDto {
  readonly proposal_id: string;
  readonly proposal_code: string;
  readonly proposal_accepted_at: string | null;
  /** Percent as decimal string, e.g. ``"50.00"``. */
  readonly deposit_percent: string;
  /** Amount as decimal string, e.g. ``"29621.78"``; may be null when
   *  the proposal has no priced subtotal yet (rare). */
  readonly deposit_amount: string | null;
  readonly currency: string;
  /** First bundled formulation on the proposal — the anchor product
   *  the deposit is being paid against. Null when the proposal has
   *  no lines yet (defensive; shouldn't happen in practice). */
  readonly formulation_id: string | null;
  readonly formulation_code: string;
  readonly formulation_name: string;
  readonly line_count: number;
  readonly customer_name: string;
  readonly customer_company: string;
  readonly customer_email: string;
}


export interface AwaitingDepositsPage {
  readonly items: ReadonlyArray<AwaitingDepositDto>;
  readonly total: number;
  readonly has_more: boolean;
  readonly next_offset: number | null;
}


export async function fetchAwaitingDeposits(
  orgId: string,
  options: {
    readonly search?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {},
): Promise<AwaitingDepositsPage> {
  const params = new URLSearchParams();
  if (options.search) params.set("search", options.search);
  if (typeof options.limit === "number")
    params.set("limit", String(options.limit));
  if (typeof options.offset === "number")
    params.set("offset", String(options.offset));
  const qs = params.toString();
  const url = qs
    ? `${paymentsEndpoints.awaitingDeposits(orgId)}?${qs}`
    : paymentsEndpoints.awaitingDeposits(orgId);
  const { data } = await apiClient.get<AwaitingDepositsPage>(url);
  return data;
}


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


export async function fetchPspInvoicesForPayment(
  orgId: string,
  paymentId: string,
): Promise<PspInvoicesResponse> {
  const { data } = await apiClient.get<PspInvoicesResponse>(
    paymentsEndpoints.pspInvoices(orgId, paymentId),
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
  pspInvoices: (orgId: string, paymentId: string) =>
    [
      ...rootQueryKey,
      "payments",
      orgId,
      "psp-invoices",
      paymentId,
    ] as const,
  pendingProjects: (orgId: string, search: string) =>
    [
      ...rootQueryKey,
      "payments",
      orgId,
      "pending-projects",
      search,
    ] as const,
  awaitingDeposits: (orgId: string, search: string) =>
    [
      ...rootQueryKey,
      "payments",
      orgId,
      "awaiting-deposits",
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


/** PSP-side CustomerInvoices for the CO this payment mirrors.
 *  Silent-degrade on the backend so a PSP outage returns
 *  ``{invoices: [], supported: true}`` instead of an error.
 *  ``supported: false`` (deposit payments) → FE hides the card. */
export function usePspInvoicesForPayment(
  orgId: string,
  paymentId: string,
): UseQueryResult<PspInvoicesResponse> {
  return useQuery({
    queryKey: paymentsQueryKeys.pspInvoices(orgId, paymentId),
    queryFn: () => fetchPspInvoicesForPayment(orgId, paymentId),
    enabled: Boolean(orgId && paymentId),
  });
}


export function useAwaitingDeposits(
  orgId: string,
  search: string = "",
): UseInfiniteQueryResult<
  { pages: AwaitingDepositsPage[]; pageParams: unknown[] },
  Error
> {
  return useInfiniteQuery({
    queryKey: paymentsQueryKeys.awaitingDeposits(orgId, search),
    queryFn: ({ pageParam }) =>
      fetchAwaitingDeposits(orgId, {
        search,
        limit: PENDING_PAGE_SIZE,
        offset: (pageParam as number) ?? 0,
      }),
    initialPageParam: 0 as number,
    getNextPageParam: (last: AwaitingDepositsPage) =>
      last.has_more ? last.next_offset : undefined,
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


export async function uploadPaymentInvoice(
  orgId: string,
  paymentId: string,
  file: File,
): Promise<PaymentInvoiceDto> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await apiClient.post<{ file: PaymentInvoiceDto }>(
    paymentsEndpoints.invoices(orgId, paymentId),
    form,
    { headers: { "Content-Type": "multipart/form-data" } },
  );
  return data.file;
}


export async function deletePaymentInvoice(
  orgId: string,
  paymentId: string,
  fileId: string,
): Promise<void> {
  await apiClient.delete(paymentsEndpoints.invoice(orgId, paymentId, fileId));
}


export function useUploadPaymentInvoice(orgId: string, paymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadPaymentInvoice(orgId, paymentId, file),
    onSuccess: () => {
      qc.refetchQueries({
        queryKey: paymentsQueryKeys.detail(orgId, paymentId),
      });
    },
  });
}


export function useDeletePaymentInvoice(orgId: string, paymentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      deletePaymentInvoice(orgId, paymentId, fileId),
    onSuccess: () => {
      qc.refetchQueries({
        queryKey: paymentsQueryKeys.detail(orgId, paymentId),
      });
    },
  });
}


/**
 * Live-feed subscription — thin wrapper over :func:`useOrgFeed`.
 *
 * The generic org feed handles every entity kind (payments, CFF,
 * projects, proposals, trial batches, label designs, specifications)
 * on one WebSocket per (tab, org). Kept as a payments-flavoured
 * export purely so existing call sites don't have to change and so
 * pages that only care about payments don't have to reach into the
 * ``lib/live`` module — reads more naturally next to the other
 * ``services/payments`` hooks.
 */
export function usePaymentsLive(orgId: string): void {
  useOrgFeed(orgId);
}


// ---------------------------------------------------------------------------
// Sample pricing — org-level settings module
// ---------------------------------------------------------------------------

/** One "buy N samples, get X% off" row on the config. Rendered as an
 *  editable table row on the settings page + used by the portal
 *  sample-selection picker (PR #3) to run the live discount math. */
export interface SamplePricingDiscountTierDto {
  readonly id?: string;
  readonly quantity_threshold: number;
  //: Percent as decimal string (matches how the BE returns Decimals).
  readonly discount_percent: string;
  readonly sort_order?: number;
}


export interface SamplePricingConfigDto {
  readonly id: string;
  readonly free_samples_included: number;
  //: Per-unit price for anything beyond the free allowance. Decimal
  //: string to dodge JS number precision on money.
  readonly price_per_extra_sample: string;
  //: ISO-4217 (3-char); empty string means "fall back to company
  //: default at render time" — matches the codebase's "never
  //: hardcode currency" rule.
  readonly currency_code: string;
  //: One-off fee charged when a customer picks "Vita designs" on the
  //: label workflow. 0 disables the gate entirely — the customer
  //: goes straight to the design brief step. Decimal string.
  readonly label_design_fee_amount: string;
  readonly discount_tiers: ReadonlyArray<SamplePricingDiscountTierDto>;
  readonly updated_at: string;
}


export interface SamplePricingSaveBody {
  readonly free_samples_included: number;
  readonly price_per_extra_sample: string;
  readonly currency_code: string;
  readonly label_design_fee_amount: string;
  readonly tiers: ReadonlyArray<{
    readonly quantity_threshold: number;
    readonly discount_percent: string;
  }>;
}


const samplePricingEndpoint = (orgId: string) =>
  `/api/organizations/${orgId}/sample-pricing/`;


export async function fetchSamplePricingConfig(
  orgId: string,
): Promise<SamplePricingConfigDto> {
  const { data } = await apiClient.get<SamplePricingConfigDto>(
    samplePricingEndpoint(orgId),
  );
  return data;
}


export async function saveSamplePricingConfig(
  orgId: string,
  body: SamplePricingSaveBody,
): Promise<SamplePricingConfigDto> {
  const { data } = await apiClient.put<SamplePricingConfigDto>(
    samplePricingEndpoint(orgId),
    body,
  );
  return data;
}


export const samplePricingQueryKeys = {
  config: (orgId: string) =>
    [...rootQueryKey, "sample-pricing", orgId] as const,
} as const;


export function useSamplePricingConfig(
  orgId: string,
): UseQueryResult<SamplePricingConfigDto> {
  return useQuery({
    queryKey: samplePricingQueryKeys.config(orgId),
    queryFn: () => fetchSamplePricingConfig(orgId),
    enabled: Boolean(orgId),
  });
}


export function useSaveSamplePricingConfig(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SamplePricingSaveBody) =>
      saveSamplePricingConfig(orgId, body),
    onSuccess: (fresh) => {
      qc.setQueryData(samplePricingQueryKeys.config(orgId), fresh);
    },
  });
}
