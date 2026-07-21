/**
 * TanStack Query hooks for the formulations domain.
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
  assignFormulationLeadScientist,
  assignFormulationSalesPerson,
  cloneFormulation,
  computeFormulationTotals,
  createFormulation,
  deleteFormulation,
  fetchFormulation,
  fetchFormulationVersions,
  fetchFormulations,
  fetchFormulationsPage,
  fetchProjectOverview,
  applyStageTemplate,
  createStageTemplate,
  deleteStageTemplate,
  fetchStageTemplates,
  updateStageTemplate,
  type ApplyStageTemplateResponseDto,
  type StageTemplateDto,
  type StageTemplateListResponseDto,
  type UpsertStageTemplateRequestDto,
  pullPspBomIntoFormulation,
  type PullPspBomResponseDto,
  replaceFormulationLines,
  rollbackFormulation,
  saveFormulationVersion,
  setApprovedVersion,
  syncFormulationToPsp,
  type SyncPspResponseDto,
  type SyncPspStageBomsDto,
  updateFormulation,
  upsertFormulationStages,
  deleteFormulationFile,
  deleteFormulationPhoto,
  fetchFormulationFiles,
  fetchFormulationPhotos,
  updateFormulationPhoto,
  uploadFormulationFile,
  uploadFormulationPhoto,
  type FormulationFileDto,
  type FormulationFilesListDto,
  type FormulationPhotoDto,
  type FormulationPhotosListDto,
} from "./api";
import type {
  AssignLeadScientistRequestDto,
  AssignSalesPersonRequestDto,
  CloneFormulationRequestDto,
  CreateFormulationRequestDto,
  FormulationDto,
  FormulationTotalsDto,
  FormulationVersionDto,
  PaginatedFormulationsDto,
  ProjectOverviewDto,
  ReplaceLinesRequestDto,
  RollbackRequestDto,
  SaveVersionRequestDto,
  UpdateFormulationRequestDto,
  UpsertStagesRequestDto,
} from "./types";

export const formulationsQueryKeys = {
  all: [...rootQueryKey, "formulations"] as const,
  list: (orgId: string) =>
    [...formulationsQueryKeys.all, orgId, "list"] as const,
  infinite: (
    orgId: string,
    opts: {
      ordering: string;
      search?: string;
      hasOpenProposal?: boolean;
      statuses?: readonly string[];
      salesPersonId?: string;
      projectType?: string;
    },
  ) =>
    [
      ...formulationsQueryKeys.all,
      orgId,
      "infinite",
      opts.ordering,
      opts.search ?? "",
      // Encode the tri-state explicitly so ``undefined`` (no filter)
      // and ``false`` (filter applied, only eligible projects) live
      // in different cache slots.
      opts.hasOpenProposal === undefined
        ? "any"
        : opts.hasOpenProposal
          ? "open"
          : "free",
      // Sort the statuses array so cache hits are insensitive to the
      // chip-toggle order. Empty array collapses to "" so the cache
      // key stays the same as "no filter applied".
      [...(opts.statuses ?? [])].sort().join(","),
      opts.salesPersonId ?? "",
      opts.projectType ?? "",
    ] as const,
  detail: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "detail", formulationId] as const,
  totals: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "totals", formulationId] as const,
  versions: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "versions", formulationId] as const,
  overview: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "overview", formulationId] as const,
  photos: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "photos", formulationId] as const,
  files: (orgId: string, formulationId: string) =>
    [...formulationsQueryKeys.all, orgId, "files", formulationId] as const,
  stageTemplates: (orgId: string) =>
    [...formulationsQueryKeys.all, orgId, "stage-templates"] as const,
} as const;

export function useFormulations(
  orgId: string,
): UseQueryResult<FormulationDto[], ApiError> {
  return useQuery<FormulationDto[], ApiError>({
    queryKey: formulationsQueryKeys.list(orgId),
    queryFn: () => fetchFormulations(orgId),
  });
}

/**
 * Cursor-paginated infinite-scroll fetch for the formulations list.
 *
 * Mirrors :func:`useInfiniteItems` on the catalogues service: the
 * caller passes ordering + page size, and the hook re-keys on those
 * so switching filters starts a clean paged cache. ``initialFirstPage``
 * lets the server render hydrate the first page without an extra
 * round-trip after hydration.
 */
export function useInfiniteFormulations(
  orgId: string,
  options: {
    ordering: string;
    pageSize?: number;
    search?: string;
    /** When set, the backend filters on whether the formulation has
     *  at least one non-terminal proposal attached. ``false`` =
     *  "only formulations free of open proposals" (used by the new-
     *  proposal modal); ``true`` = the inverse; omitted = no
     *  filter. */
    hasOpenProposal?: boolean;
    /** Multi-select project_status filter for the list bar. */
    statuses?: readonly string[];
    /** UUID of the assigned sales person, or ``"unassigned"`` for
     *  the no-owner bucket. */
    salesPersonId?: string;
    /** ``custom`` vs ``ready_to_go``. */
    projectType?: string;
    initialFirstPage?: PaginatedFormulationsDto | null;
  },
): UseInfiniteQueryResult<
  InfiniteData<PaginatedFormulationsDto, string | null>,
  ApiError
> {
  const {
    ordering,
    pageSize,
    search,
    hasOpenProposal,
    statuses,
    salesPersonId,
    projectType,
    initialFirstPage,
  } = options;
  const normalisedSearch = search?.trim() ?? "";
  // Any filter narrowing the list invalidates the unfiltered SSR
  // seed; only feed the initial page when no filter is active.
  const filtersActive =
    Boolean(normalisedSearch) ||
    (statuses?.length ?? 0) > 0 ||
    Boolean(salesPersonId) ||
    Boolean(projectType);
  return useInfiniteQuery<
    PaginatedFormulationsDto,
    ApiError,
    InfiniteData<PaginatedFormulationsDto, string | null>,
    readonly unknown[],
    string | null
  >({
    queryKey: formulationsQueryKeys.infinite(orgId, {
      ordering,
      search: normalisedSearch,
      hasOpenProposal,
      statuses,
      salesPersonId,
      projectType,
    }),
    queryFn: ({ pageParam }) =>
      fetchFormulationsPage(orgId, {
        ordering,
        pageSize,
        search: normalisedSearch || undefined,
        hasOpenProposal,
        statuses,
        salesPersonId,
        projectType,
        cursorUrl: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    getPreviousPageParam: (first) => first.previous,
    initialData:
      initialFirstPage && !filtersActive
        ? {
            pages: [initialFirstPage],
            pageParams: [null],
          }
        : undefined,
  });
}

export function useFormulation(
  orgId: string,
  formulationId: string,
): UseQueryResult<FormulationDto, ApiError> {
  return useQuery<FormulationDto, ApiError>({
    queryKey: formulationsQueryKeys.detail(orgId, formulationId),
    queryFn: () => fetchFormulation(orgId, formulationId),
  });
}

export function useFormulationTotals(
  orgId: string,
  formulationId: string,
  options: { enabled?: boolean } = {},
): UseQueryResult<FormulationTotalsDto, ApiError> {
  return useQuery<FormulationTotalsDto, ApiError>({
    queryKey: formulationsQueryKeys.totals(orgId, formulationId),
    queryFn: () => computeFormulationTotals(orgId, formulationId),
    enabled: options.enabled ?? true,
  });
}

export function useFormulationVersions(
  orgId: string,
  formulationId: string,
): UseQueryResult<FormulationVersionDto[], ApiError> {
  return useQuery<FormulationVersionDto[], ApiError>({
    queryKey: formulationsQueryKeys.versions(orgId, formulationId),
    queryFn: () => fetchFormulationVersions(orgId, formulationId),
  });
}

export function useProjectOverview(
  orgId: string,
  formulationId: string,
  options: { initialData?: ProjectOverviewDto } = {},
): UseQueryResult<ProjectOverviewDto, ApiError> {
  return useQuery<ProjectOverviewDto, ApiError>({
    queryKey: formulationsQueryKeys.overview(orgId, formulationId),
    queryFn: () => fetchProjectOverview(orgId, formulationId),
    initialData: options.initialData,
    // Fresh-on-write contract is enforced by explicit
    // ``invalidateQueries`` calls in the mutation hooks (save_version,
    // batch updates, …) so we deliberately do NOT use
    // ``refetchOnMount: "always"`` here. The previous setting fired a
    // fresh ``/overview/`` request on every component mount even
    // when the cache was milliseconds old, which on a single-worker
    // backend turned tab-switches inside a project workspace into
    // queued backend round-trips. Default ``staleTime`` (60s)
    // governs everything below the mutation-driven invalidation.
  });
}

export function useCreateFormulation(
  orgId: string,
): UseMutationResult<FormulationDto, ApiError, CreateFormulationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, CreateFormulationRequestDto>({
    mutationFn: (payload) => createFormulation(orgId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
    },
  });
}

export function useUpdateFormulation(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, UpdateFormulationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, UpdateFormulationRequestDto>({
    mutationFn: (payload) => updateFormulation(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
      // The project-overview card reads ``code`` / ``name`` /
      // ``description`` off a separate query, so an edit through
      // this mutation must kick it too — otherwise the header
      // keeps printing the stale code until a full refetch.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
    },
  });
}

export function useAssignSalesPerson(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, AssignSalesPersonRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, AssignSalesPersonRequestDto>({
    mutationFn: (payload) =>
      assignFormulationSalesPerson(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      // The overview card shows the sales person too, so kick that
      // cache as well. Totals are unaffected — leave them alone.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
    },
  });
}


/**
 * Mirror of :func:`useAssignSalesPerson` for the R&D lead pointer.
 * Same cache invalidations because the overview snapshot now carries
 * ``lead_scientist`` alongside ``sales_person``.
 */
export function useAssignLeadScientist(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, AssignLeadScientistRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, AssignLeadScientistRequestDto>({
    mutationFn: (payload) =>
      assignFormulationLeadScientist(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
    },
  });
}


export function useDeleteFormulation(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (formulationId) => deleteFormulation(orgId, formulationId),
    onSuccess: (_, formulationId) => {
      queryClient.removeQueries({
        queryKey: formulationsQueryKeys.detail(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
    },
  });
}

export function useReplaceLines(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, ReplaceLinesRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, ReplaceLinesRequestDto>({
    mutationFn: (payload) =>
      replaceFormulationLines(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
    },
  });
}

/** Wholesale-replace the formulation's production-stage graph.
 *  Updates the detail cache with the fresh formulation (which now
 *  carries the new stage list + line stage_id assignments), so the
 *  builder re-renders without a separate refetch. */
export function useUpsertStages(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, UpsertStagesRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, UpsertStagesRequestDto>({
    mutationFn: (payload) =>
      upsertFormulationStages(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      // Save-stages triggers the auto-sync-BOM-to-PSP cascade in the
      // service layer — each stage's PSP BOM may have new lines.
      // Invalidate every ``[psp, orgId, items, ...]`` query so the
      // stage cards refetch fresh BOMs on the next render.
      queryClient.invalidateQueries({ queryKey: ["psp", orgId, "items"] });
    },
  });
}


export function useSaveVersion(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  FormulationVersionDto,
  ApiError,
  SaveVersionRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<FormulationVersionDto, ApiError, SaveVersionRequestDto>({
    mutationFn: (payload) =>
      saveFormulationVersion(orgId, formulationId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, formulationId),
      });
    },
  });
}

export function useSyncFormulationToPsp(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  SyncPspResponseDto,
  ApiError,
  { stageBoms?: SyncPspStageBomsDto } | void
> {
  const queryClient = useQueryClient();
  return useMutation<
    SyncPspResponseDto,
    ApiError,
    { stageBoms?: SyncPspStageBomsDto } | void
  >({
    mutationFn: (args) =>
      syncFormulationToPsp(orgId, formulationId, args ?? {}),
    onSuccess: (result) => {
      if (!result.synced) return;
      // ``_ensure_finished_product`` may have just written back the
      // finished-product uuid; refresh the formulation detail so the
      // "Open on PSP" chip and the stage cards pick up the new link
      // without a full reload.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.detail(orgId, formulationId),
      });
      // Every stage's PSP BOM was just re-pushed — bust the cached
      // per-stage BOM reads so the strip re-fetches from PSP.
      queryClient.invalidateQueries({ queryKey: ["psp", orgId, "items"] });
    },
  });
}

/**
 * Wholesale-hydrate the finished-stage BOM from PSP's active primary
 * BOM. On success, the server has already saved a ``pre-pull-from-psp``
 * version snapshot so the pre-pull state is in the version drawer for
 * rollback. Invalidates detail + totals + versions so the builder
 * reloads the fresh lines + refreshed version list without a page
 * refresh.
 */
export function usePullPspBom(
  orgId: string,
  formulationId: string,
): UseMutationResult<PullPspBomResponseDto, ApiError, void> {
  const queryClient = useQueryClient();
  return useMutation<PullPspBomResponseDto, ApiError, void>({
    mutationFn: () => pullPspBomIntoFormulation(orgId, formulationId),
    onSuccess: (result) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        result.formulation,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, formulationId),
      });
    },
  });
}


export function useRollbackFormulation(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, RollbackRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, RollbackRequestDto>({
    mutationFn: (payload) =>
      rollbackFormulation(orgId, formulationId, payload),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, formulationId),
      });
    },
  });
}

/**
 * Duplicate a formulation's recipe — either into a brand-new project
 * or onto an existing one. The mutation invalidates the list (so a
 * "new" mode result appears in /formulations) and, for a "replace"
 * result, also kicks the target's detail / overview / totals /
 * versions caches so the builder repaints with the cloned recipe
 * without a hard refresh.
 */
export function useCloneFormulation(
  orgId: string,
  sourceFormulationId: string,
): UseMutationResult<FormulationDto, ApiError, CloneFormulationRequestDto> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, CloneFormulationRequestDto>({
    mutationFn: (payload) =>
      cloneFormulation(orgId, sourceFormulationId, payload),
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.list(orgId),
      });
      // ``result`` is the new (mode=new) or updated (mode=replace)
      // formulation. Either way, kicking its caches ensures the
      // builder we redirect to renders the fresh recipe rather than
      // any stale per-id cache.
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.detail(orgId, result.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, result.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.versions(orgId, result.id),
      });
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, result.id),
      });
    },
  });
}

/** Mark a specific version as the current approved recipe, or
 *  clear the pointer by passing ``null``. The backend requires the
 *  ``formulations.approve`` capability — the button surfaces a
 *  friendly ``forbidden`` message when that's missing. */
export function useSetApprovedVersion(
  orgId: string,
  formulationId: string,
): UseMutationResult<FormulationDto, ApiError, number | null> {
  const queryClient = useQueryClient();
  return useMutation<FormulationDto, ApiError, number | null>({
    mutationFn: (versionNumber) =>
      setApprovedVersion(orgId, formulationId, versionNumber),
    onSuccess: (updated) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        updated,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.overview(orgId, formulationId),
      });
    },
  });
}


// ---- Photos + files ------------------------------------------------

export function useFormulationPhotos(
  orgId: string,
  formulationId: string,
): UseQueryResult<FormulationPhotosListDto, ApiError> {
  return useQuery<FormulationPhotosListDto, ApiError>({
    queryKey: formulationsQueryKeys.photos(orgId, formulationId),
    queryFn: () => fetchFormulationPhotos(orgId, formulationId),
    enabled: Boolean(orgId && formulationId),
  });
}

export function useUploadFormulationPhoto(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  { photo: FormulationPhotoDto },
  ApiError,
  { file: File; caption?: string; is_primary?: boolean }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args) => uploadFormulationPhoto(orgId, formulationId, args),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.photos(orgId, formulationId),
      });
    },
  });
}

export function useUpdateFormulationPhoto(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  { photo: FormulationPhotoDto },
  ApiError,
  { photoId: string; patch: { caption?: string; is_primary?: boolean } }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ photoId, patch }) =>
      updateFormulationPhoto(orgId, formulationId, photoId, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.photos(orgId, formulationId),
      });
    },
  });
}

export function useDeleteFormulationPhoto(
  orgId: string,
  formulationId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (photoId: string) =>
      deleteFormulationPhoto(orgId, formulationId, photoId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.photos(orgId, formulationId),
      });
    },
  });
}

export function useFormulationFiles(
  orgId: string,
  formulationId: string,
): UseQueryResult<FormulationFilesListDto, ApiError> {
  return useQuery<FormulationFilesListDto, ApiError>({
    queryKey: formulationsQueryKeys.files(orgId, formulationId),
    queryFn: () => fetchFormulationFiles(orgId, formulationId),
    enabled: Boolean(orgId && formulationId),
  });
}

export function useUploadFormulationFile(
  orgId: string,
  formulationId: string,
): UseMutationResult<
  { file: FormulationFileDto },
  ApiError,
  { file: File; kind?: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args) => uploadFormulationFile(orgId, formulationId, args),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.files(orgId, formulationId),
      });
    },
  });
}

export function useDeleteFormulationFile(
  orgId: string,
  formulationId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) =>
      deleteFormulationFile(orgId, formulationId, fileId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.files(orgId, formulationId),
      });
    },
  });
}


/**
 * Fetch the org's stage templates. Enabled by default because the
 * New-formulation dialog + Stages tab picker both need the list up
 * front — but honours ``enabled`` so callers can gate on dialog open.
 */
export function useStageTemplates(
  orgId: string,
  args: { enabled?: boolean } = {},
): UseQueryResult<StageTemplateListResponseDto, ApiError> {
  const { enabled = true } = args;
  return useQuery<StageTemplateListResponseDto, ApiError>({
    queryKey: formulationsQueryKeys.stageTemplates(orgId),
    queryFn: () => fetchStageTemplates(orgId),
    enabled: Boolean(orgId) && enabled,
    // Templates change rarely — a 10-min stale window is plenty.
    staleTime: 10 * 60 * 1000,
  });
}


export function useApplyStageTemplate(
  orgId: string,
  formulationId: string,
): UseMutationResult<ApplyStageTemplateResponseDto, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<ApplyStageTemplateResponseDto, ApiError, string>({
    mutationFn: (templateId: string) =>
      applyStageTemplate(orgId, formulationId, templateId),
    onSuccess: (result) => {
      queryClient.setQueryData(
        formulationsQueryKeys.detail(orgId, formulationId),
        result.formulation,
      );
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.totals(orgId, formulationId),
      });
    },
  });
}


export function useCreateStageTemplate(
  orgId: string,
): UseMutationResult<
  StageTemplateDto,
  ApiError,
  UpsertStageTemplateRequestDto
> {
  const queryClient = useQueryClient();
  return useMutation<
    StageTemplateDto,
    ApiError,
    UpsertStageTemplateRequestDto
  >({
    mutationFn: (payload) => createStageTemplate(orgId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.stageTemplates(orgId),
      });
    },
  });
}


export function useUpdateStageTemplate(
  orgId: string,
): UseMutationResult<
  StageTemplateDto,
  ApiError,
  { templateId: string; patch: Partial<UpsertStageTemplateRequestDto> }
> {
  const queryClient = useQueryClient();
  return useMutation<
    StageTemplateDto,
    ApiError,
    { templateId: string; patch: Partial<UpsertStageTemplateRequestDto> }
  >({
    mutationFn: ({ templateId, patch }) =>
      updateStageTemplate(orgId, templateId, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.stageTemplates(orgId),
      });
    },
  });
}


export function useDeleteStageTemplate(
  orgId: string,
): UseMutationResult<void, ApiError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (templateId: string) =>
      deleteStageTemplate(orgId, templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: formulationsQueryKeys.stageTemplates(orgId),
      });
    },
  });
}
