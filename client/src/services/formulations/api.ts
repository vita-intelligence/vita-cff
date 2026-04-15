/**
 * Raw Axios calls for the formulations domain.
 */

import { apiClient } from "@/lib/api";

import { formulationsEndpoints } from "./endpoints";
import type {
  CreateFormulationRequestDto,
  FormulationDto,
  FormulationTotalsDto,
  FormulationVersionDto,
  FormulationsListQuery,
  PaginatedFormulationsDto,
  ReplaceLinesRequestDto,
  RollbackRequestDto,
  SaveVersionRequestDto,
  UpdateFormulationRequestDto,
} from "./types";

export interface FetchFormulationsPageArgs extends FormulationsListQuery {
  /** Full ``next``/``previous`` URL from a prior cursor response. */
  readonly cursorUrl?: string | null;
}

export async function fetchFormulationsPage(
  orgId: string,
  args: FetchFormulationsPageArgs = {},
): Promise<PaginatedFormulationsDto> {
  if (args.cursorUrl) {
    const url = new URL(args.cursorUrl, "http://placeholder.local");
    const { data } = await apiClient.get<PaginatedFormulationsDto>(
      `${url.pathname}${url.search}`,
    );
    return data;
  }

  const params: Record<string, string> = {};
  if (args.ordering) params.ordering = args.ordering;
  if (args.pageSize) params.page_size = String(args.pageSize);
  const { data } = await apiClient.get<PaginatedFormulationsDto>(
    formulationsEndpoints.list(orgId),
    { params },
  );
  return data;
}

/**
 * @deprecated Use :func:`fetchFormulationsPage` — the list endpoint
 * is paginated and this helper just flattens the first page.
 */
export async function fetchFormulations(
  orgId: string,
): Promise<FormulationDto[]> {
  const page = await fetchFormulationsPage(orgId);
  return [...page.results];
}

export async function fetchFormulation(
  orgId: string,
  formulationId: string,
): Promise<FormulationDto> {
  const { data } = await apiClient.get<FormulationDto>(
    formulationsEndpoints.detail(orgId, formulationId),
  );
  return data;
}

export async function createFormulation(
  orgId: string,
  payload: CreateFormulationRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.list(orgId),
    payload,
  );
  return data;
}

export async function updateFormulation(
  orgId: string,
  formulationId: string,
  payload: UpdateFormulationRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.patch<FormulationDto>(
    formulationsEndpoints.detail(orgId, formulationId),
    payload,
  );
  return data;
}

export async function deleteFormulation(
  orgId: string,
  formulationId: string,
): Promise<void> {
  await apiClient.delete(formulationsEndpoints.detail(orgId, formulationId));
}

export async function replaceFormulationLines(
  orgId: string,
  formulationId: string,
  payload: ReplaceLinesRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.put<FormulationDto>(
    formulationsEndpoints.lines(orgId, formulationId),
    payload,
  );
  return data;
}

export async function computeFormulationTotals(
  orgId: string,
  formulationId: string,
): Promise<FormulationTotalsDto> {
  const { data } = await apiClient.get<FormulationTotalsDto>(
    formulationsEndpoints.compute(orgId, formulationId),
  );
  return data;
}

export async function fetchFormulationVersions(
  orgId: string,
  formulationId: string,
): Promise<FormulationVersionDto[]> {
  const { data } = await apiClient.get<FormulationVersionDto[]>(
    formulationsEndpoints.versions(orgId, formulationId),
  );
  return data;
}

export async function saveFormulationVersion(
  orgId: string,
  formulationId: string,
  payload: SaveVersionRequestDto,
): Promise<FormulationVersionDto> {
  const { data } = await apiClient.post<FormulationVersionDto>(
    formulationsEndpoints.versions(orgId, formulationId),
    payload,
  );
  return data;
}

export async function rollbackFormulation(
  orgId: string,
  formulationId: string,
  payload: RollbackRequestDto,
): Promise<FormulationDto> {
  const { data } = await apiClient.post<FormulationDto>(
    formulationsEndpoints.rollback(orgId, formulationId),
    payload,
  );
  return data;
}
