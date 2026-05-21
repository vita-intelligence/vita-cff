"use client";

import {
  ExternalLink,
  Loader2,
  Plus,
  PoundSterling,
  Trash2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { Button, Modal } from "@heroui/react";

import { Link, useRouter } from "@/i18n/navigation";
import { LinkIconSlot } from "@/components/loading/link-pending-spinner";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  PROPOSAL_TEMPLATE_TYPES,
  useCreateProposal,
  useDeleteProposal,
  useInfiniteProposals,
  type ProposalListItemDto,
  type ProposalStatus,
  type ProposalTemplateType,
} from "@/services/proposals";
import {
  useFormulationVersions,
  useInfiniteFormulations,
  type FormulationVersionDto,
} from "@/services/formulations";
import { type CustomerDto } from "@/services/customers";
import {
  useInfiniteSpecifications,
  type SpecificationSheetDto,
} from "@/services/specifications";

import { CustomerPicker } from "@/components/customers/customer-picker";
import { MrpeasyPriceHint } from "@/components/mrpeasy/mrpeasy-price-hint";
import { useOrganization } from "@/services/organizations";
import { CustomerFormModal } from "../customers/customers-list";
import {
  ProposalsFilterBar,
  useProposalsFiltersState,
} from "./proposals-filter-bar";


/**
 * Org-wide proposals list. Same shape as the per-project panel but
 * un-scoped — renders every proposal in the caller's organization
 * so a sales user can find a quote without knowing which project
 * it started on.
 *
 * The create modal asks for a formulation + version to seed the
 * first line; scientists add additional products (potentially from
 * different projects) from the proposal detail page's lines panel.
 */
export function ProposalsOrgList({ orgId }: { orgId: string }) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");

  const filters = useProposalsFiltersState();
  // Backend queries on ``applied`` only — the pending state stays
  // local to the bar until the user hits Apply.
  const applied = filters.applied;
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
  } = useInfiniteProposals(orgId, {
    statuses: applied.statuses,
    search: applied.search || undefined,
    salesPersonId: applied.salesPersonId || undefined,
    validUntilFrom: applied.validUntilFrom || undefined,
    validUntilTo: applied.validUntilTo || undefined,
  });
  const deleteMutation = useDeleteProposal(orgId);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Flatten the cursor pages into a single roster. ``useMemo`` keeps
  // the array reference stable across re-renders that didn't touch
  // the data — the row components are otherwise free to re-render
  // on every parent paint, which is wasted work when only the
  // filter bar's pending state changed.
  const proposals: readonly ProposalListItemDto[] = useMemo(
    () => data?.pages.flatMap((page) => page.results) ?? [],
    [data],
  );

  const handleDelete = useCallback(
    async (proposalId: string) => {
      if (!confirm(tProposals("list.delete_confirm"))) return;
      setDeleteError(null);
      try {
        await deleteMutation.mutateAsync(proposalId);
      } catch (err) {
        setDeleteError(extractApiErrorMessage(err, tErrors));
      }
    },
    [deleteMutation, tErrors, tProposals],
  );

  // IntersectionObserver-driven infinite scroll. A sentinel ``<li>``
  // rendered just past the last row triggers ``fetchNextPage`` when
  // it enters the viewport — the standard pagination pattern,
  // without the layout fragility a window virtualiser would add for
  // what is realistically a few-hundred-row list. The real perf win
  // is server-side (pagination + dropped ``lines`` array); on the
  // client, plain DOM rows perform fine until the page count is in
  // the thousands, at which point swapping in a virtualiser is a
  // localised change.
  const sentinelRef = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    if (!hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            hasNextPage &&
            !isFetchingNextPage &&
            !isFetching
          ) {
            void fetchNextPage();
            // One trigger per observe cycle — the next page's render
            // re-mounts the sentinel below the new tail, which then
            // arms a fresh observation. Avoids back-to-back fires
            // while React is still committing the new rows.
            break;
          }
        }
      },
      // ``rootMargin: 200px`` so the load fires while the sentinel
      // is still ~200px below the viewport edge — the next page lands
      // on screen before the user actually reaches the bottom, so
      // scrolling feels continuous rather than stutter-loading at
      // each cursor boundary.
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetching, fetchNextPage]);

  const showEmpty = !isLoading && proposals.length === 0;

  return (
    <section className="mt-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-1000 md:text-2xl">
            {tProposals("list.title")}
          </h1>
          <p className="mt-0.5 text-sm text-ink-500">
            {tProposals("list.org_subtitle")}
          </p>
        </div>
        <OrgNewProposalButton orgId={orgId} />
      </header>

      <div className="mt-4">
        <ProposalsFilterBar
          orgId={orgId}
          filters={filters}
          isFetching={isFetching}
        />
      </div>

      {deleteError ? (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {deleteError}
        </p>
      ) : null}

      {isLoading ? (
        <p className="mt-6 text-sm text-ink-500">
          {tProposals("list.loading")}
        </p>
      ) : showEmpty ? (
        <div className="mt-6 rounded-xl bg-ink-50 px-4 py-8 text-center ring-1 ring-inset ring-ink-200">
          <PoundSterling className="mx-auto h-6 w-6 text-ink-400" />
          <p className="mt-2 text-sm text-ink-500">
            {filters.appliedAnyActive
              ? tProposals("list.no_matches_filtered")
              : tProposals("list.empty")}
          </p>
          {filters.appliedAnyActive ? (
            <p className="mt-1 text-xs text-ink-400">
              {tProposals("list.no_matches_hint")}
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-ink-100">
            {proposals.map((proposal) => (
              <OrgProposalRow
                key={proposal.id}
                proposal={proposal}
                onDelete={handleDelete}
                deletePending={deleteMutation.isPending}
              />
            ))}
            {/* Sentinel — rendered only while another page is
                available. IntersectionObserver above watches this
                node and calls ``fetchNextPage`` when it enters the
                viewport (with a 200px head-start), so the next page
                lands before the user reaches the visible bottom. */}
            {hasNextPage ? (
              <li
                ref={sentinelRef}
                aria-hidden
                className="h-1"
              />
            ) : null}
          </ul>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-500">
            <span>
              {tProposals("list.row_count", { count: proposals.length })}
              {hasNextPage ? ` · ${tProposals("list.scroll_hint")}` : ""}
            </span>
            {isFetchingNextPage ? (
              <span className="inline-flex items-center gap-1 text-ink-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                {tProposals("list.loading")}
              </span>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}


function OrgProposalRow({
  proposal,
  onDelete,
  deletePending,
}: {
  proposal: ProposalListItemDto;
  onDelete: (id: string) => void;
  deletePending: boolean;
}) {
  const tProposals = useTranslations("proposals");
  const total = proposal.total_excl_vat ?? proposal.subtotal ?? null;
  // Once the director has approved a proposal the trash button
  // disappears: an approved record carries internal signatures that
  // would orphan on delete, and ``sent`` / ``accepted`` / ``rejected``
  // are part of the audit trail. The backend mirrors this lock via
  // :class:`ProposalNotMutable` so a crafted DELETE can't bypass.
  const isTerminal =
    proposal.status === "approved" ||
    proposal.status === "sent" ||
    proposal.status === "accepted" ||
    proposal.status === "rejected";
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link
          href={`/proposals/${proposal.id}`}
          className="text-sm font-medium text-ink-1000 hover:text-orange-700"
        >
          {proposal.code} ·{" "}
          {proposal.customer_company ||
            proposal.customer_name ||
            tProposals("list.no_customer")}
        </Link>
        <span className="text-xs text-ink-500">
          {/* Project (formulation) name surfaces the recipe the
              proposal is quoting against. Listed first so a scientist
              scanning the page can match a proposal to "what is this
              actually selling" without clicking through. Falls back
              gracefully if the formulation link is missing on a
              legacy row. */}
          {proposal.formulation_name ? (
            <>
              <span className="font-medium text-ink-700">
                {proposal.formulation_name}
              </span>
              {" · "}
            </>
          ) : null}
          {tProposals(
            `template_type.${proposal.template_type}` as "template_type.custom",
          )}
          {" · "}
          {proposal.lines_count}{" "}
          {tProposals("list.products_count", {
            count: proposal.lines_count,
          })}
          {total !== null ? ` · ${total} ${proposal.currency}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <StatusChip status={proposal.status} />
        <Link
          href={`/proposals/${proposal.id}`}
          prefetch={false}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <LinkIconSlot idleIcon={<ExternalLink className="h-3.5 w-3.5" />} />
          {tProposals("list.view")}
        </Link>
        {isTerminal ? null : (
          <button
            type="button"
            aria-label={tProposals("list.delete")}
            onClick={() => onDelete(proposal.id)}
            disabled={deletePending}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-500 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </li>
  );
}


function StatusChip({ status }: { status: ProposalStatus }) {
  const tProposals = useTranslations("proposals");
  const variants: Record<ProposalStatus, string> = {
    draft: "bg-ink-100 text-ink-700 ring-ink-200",
    in_review: "bg-warning/10 text-warning ring-warning/20",
    approved: "bg-orange-500/10 text-orange-700 ring-orange-500/30",
    sent: "bg-orange-500/10 text-orange-700 ring-orange-500/30",
    accepted: "bg-success/10 text-success ring-success/30",
    rejected: "bg-danger/10 text-danger ring-danger/30",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ring-inset ${variants[status]}`}
    >
      {tProposals(`status.${status}` as "status.draft")}
    </span>
  );
}


/** Org-scoped create — picks any formulation in the org rather
 *  than starting inside one project. Creates a draft proposal with
 *  a single line; the scientist adds more lines from the detail
 *  page (the `Products on this proposal` panel supports any
 *  formulation via the same `AddLineForm`). */
function OrgNewProposalButton({ orgId }: { orgId: string }) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  // Dynamics-managed orgs hide every manual "Create new customer"
  // affordance — the Dataverse import is the only inbound path. The
  // flag rides on the org payload (already cached from SSR via the
  // bootstrap endpoint) so this read is free.
  const organization = useOrganization(orgId);
  const dynamicsManaged = Boolean(
    organization?.dynamics_customers_managed,
  );

  const [isOpen, setIsOpen] = useState(false);
  const [template, setTemplate] = useState<ProposalTemplateType>("custom");
  const [formulationId, setFormulationId] = useState<string>("");
  // ``formulationSearch`` is what the user is typing right now;
  // ``formulationSearchDebounced`` is what we forward to the backend
  // — staggered by 200 ms so each keystroke doesn't fire its own
  // request. Both feed the same filtered list under the picker.
  const [formulationSearch, setFormulationSearch] = useState<string>("");
  const [formulationSearchDebounced, setFormulationSearchDebounced] =
    useState<string>("");
  useEffect(() => {
    const handle = setTimeout(
      () => setFormulationSearchDebounced(formulationSearch.trim()),
      200,
    );
    return () => clearTimeout(handle);
  }, [formulationSearch]);
  // ``has_open_proposal=false`` excludes formulations that already
  // carry a proposal in a non-terminal status (``draft`` /
  // ``in_review`` / ``approved`` / ``sent``). The filter runs at SQL
  // level via an EXISTS subquery on the backend — that keeps
  // pagination honest (50/page = 50 *eligible* projects, not 50
  // minus whatever the client later filtered out) and avoids a
  // second round-trip to fetch every proposal just to compute the
  // busy set client-side.
  const formulationsQuery = useInfiniteFormulations(orgId, {
    ordering: "name",
    pageSize: 50,
    search: formulationSearchDebounced || undefined,
    hasOpenProposal: false,
  });
  const versionsQuery = useFormulationVersions(orgId, formulationId);
  const [versionId, setVersionId] = useState<string>("");
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [quantity, setQuantity] = useState<string>("1");
  const [unitCost, setUnitCost] = useState<string>("");
  const [margin, setMargin] = useState<string>("30");
  //: When ``true``, the rep has explicitly opened the override panel
  //: to retype cost / margin against the spec's signed values. When
  //: ``false`` (default), the spec is the single source of truth and
  //: we don't forward cost / margin / price in the create payload —
  //: the backend pulls them from the attached spec instead.
  const [pricingOverride, setPricingOverride] = useState(false);
  //: Optional spec-sheet attachment. Empty = no bundled spec; any
  //: value = SpecificationSheet UUID. The backend validates tenancy
  //: and the OneToOne uniqueness (one proposal per sheet) and
  //: rejects with ``specification_sheet_not_in_org`` when crossed.
  const [specSheetId, setSpecSheetId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateProposal(orgId);
  const specSheetsQuery = useInfiniteSpecifications(orgId, { pageSize: 100 });

  // Project status no longer gates the source list — proposals can
  // be raised during ``in_development`` / ``pilot`` once the recipe
  // has a director-signed spec sheet. We narrow at the *version*
  // level instead: only formulations whose
  // ``approved_version_number`` has been wired (auto-set when a
  // spec sheet hits ``status=approved``) survive the filter, so the
  // picker never offers something the backend would reject.
  //
  // Projects with an open proposal are filtered out *server-side*
  // via ``has_open_proposal=false`` (see ``hasOpenProposal`` above);
  // the only filter that stays on the client is the approved-version
  // gate because that field is already on the row.
  const formulations = (
    formulationsQuery.data?.pages.flatMap((p) => p.results) ?? []
  ).filter((f) => f.approved_version_number !== null);
  // Track which version of the picked formulation is the
  // director-approved snapshot so the version <select> can be
  // narrowed down to that one entry (mirrors the per-project picker
  // rule). With the auto-wiring above this is the same number as
  // the spec sheet that last director-signed against the recipe.
  const pickedFormulation = formulations.find((f) => f.id === formulationId);
  const approvedVersionNumber =
    pickedFormulation?.approved_version_number ?? null;
  const sellableVersions: readonly FormulationVersionDto[] = (
    versionsQuery.data ?? []
  ).filter((v) => v.version_number === approvedVersionNumber);

  // Auto-select the single approved version once the picked
  // formulation's versions have loaded — saves the user a click
  // since the version dropdown only ever has one valid option.
  useEffect(() => {
    if (sellableVersions.length === 0) {
      if (versionId !== "") setVersionId("");
      return;
    }
    if (!sellableVersions.some((v) => v.id === versionId)) {
      setVersionId(sellableVersions[0]!.id);
    }
  }, [sellableVersions, versionId]);

  // Flatten the infinite pages into a single list. 100/page is enough
  // that most orgs will never paginate here; the picker is a simple
  // <select> so we don't need infinite-scroll UX inside it.
  const specSheets: readonly SpecificationSheetDto[] =
    specSheetsQuery.data?.pages.flatMap((p) => p.results) ?? [];

  // Gross margin: price = cost / (1 - margin/100). See service
  // ``suggest_unit_price`` for the full edge-case rationale.
  const derivedUnitPrice = (() => {
    const c = Number.parseFloat(unitCost);
    const m = Number.parseFloat(margin);
    if (!Number.isFinite(c) || c <= 0) return null;
    if (!Number.isFinite(m) || m < 0 || m >= 100) return null;
    return c / (1 - m / 100);
  })();

  const close = () => {
    setIsOpen(false);
    setFormulationId("");
    setVersionId("");
    setFormulationSearch("");
    setFormulationSearchDebounced("");
    setCustomer(null);
    setQuantity("1");
    setUnitCost("");
    setMargin("30");
    setPricingOverride(false);
    setTemplate("custom");
    setSpecSheetId("");
    setError(null);
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!versionId) {
      setError(tProposals("create.invalid_input"));
      return;
    }
    try {
      // Quantity is the only required field. Cost / margin / price
      // only get forwarded when sales has explicitly opened the
      // override panel and typed something. Otherwise the backend
      // does the right thing on its own: an attached spec's signed
      // pricing flows in via the auto-fill; an un-priced or absent
      // spec leaves the proposal's pricing columns blank for sales
      // to fill in later from the proposal detail page.
      const basePayload = {
        formulation_version_id: versionId,
        template_type: template,
        // Link the address-book record when one was picked. The
        // backend seeds the proposal's customer_* fields from this
        // customer, so we don't need to forward the individual
        // name / email / company values here — they fall out of the
        // FK lookup server-side.
        customer_id: customer?.id ?? null,
        specification_sheet_id: specSheetId || null,
        customer_name: customer?.name ?? "",
        customer_email: customer?.email ?? "",
        customer_company: customer?.company ?? "",
        quantity: Math.max(1, Number.parseInt(quantity, 10) || 1),
      };
      const created = await createMutation.mutateAsync(
        pricingOverride
          ? {
              ...basePayload,
              unit_price:
                derivedUnitPrice !== null
                  ? derivedUnitPrice.toFixed(4)
                  : null,
              material_cost_per_pack: unitCost ? unitCost : null,
              margin_percent: margin ? margin : null,
            }
          : basePayload,
      );
      close();
      router.push(`/proposals/${created.id}`);
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? setIsOpen(true) : close())}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          {tProposals("create.trigger")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tProposals("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tProposals("create.org_subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.formulation")}
                  </span>
                  <input
                    type="search"
                    value={formulationSearch}
                    onChange={(e) => setFormulationSearch(e.target.value)}
                    placeholder={tProposals(
                      "create.formulation_search_placeholder",
                    )}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                  <select
                    value={formulationId}
                    onChange={(e) => {
                      setFormulationId(e.target.value);
                      setVersionId("");
                      // Swapping the formulation invalidates any
                      // previously-picked spec — they're scoped to
                      // a specific formulation, so drop it.
                      setSpecSheetId("");
                    }}
                    disabled={formulations.length === 0}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
                  >
                    <option value="">—</option>
                    {formulations.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.code ? `${f.code} · ${f.name}` : f.name}
                      </option>
                    ))}
                  </select>
                  <PickerHint
                    loading={formulationsQuery.isLoading}
                    loadingText={tProposals("create.formulation_loading")}
                  >
                    {formulations.length === 0
                      ? formulationSearchDebounced
                        ? tProposals(
                            "create.formulation_empty_search",
                            { query: formulationSearchDebounced },
                          )
                        : tProposals("create.formulation_empty_approved")
                      : tProposals("create.formulation_hint_approved_only")}
                  </PickerHint>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    disabled={
                      !formulationId ||
                      versionsQuery.isLoading ||
                      sellableVersions.length === 0
                    }
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
                  >
                    <option value="">—</option>
                    {sellableVersions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number}
                        {v.label ? ` — ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                  <PickerHint
                    loading={
                      Boolean(formulationId) && versionsQuery.isLoading
                    }
                    loadingText={tProposals("create.version_loading")}
                  >
                    {!formulationId
                      ? null
                      : sellableVersions.length === 0
                        ? tProposals("create.version_empty_approved")
                        : tProposals("create.version_hint_approved_only")}
                  </PickerHint>
                </label>

                <fieldset className="flex flex-col gap-1.5">
                  <legend className="text-xs font-medium text-ink-700">
                    {tProposals("create.template_type")}
                  </legend>
                  <div className="flex gap-2">
                    {PROPOSAL_TEMPLATE_TYPES.map((key) => (
                      <label
                        key={key}
                        className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium ring-1 ring-inset transition-colors ${
                          template === key
                            ? "bg-orange-500 text-ink-0 ring-orange-500"
                            : "bg-ink-0 text-ink-700 ring-ink-200 hover:bg-ink-50"
                        }`}
                      >
                        <input
                          type="radio"
                          name="template_type"
                          value={key}
                          checked={template === key}
                          onChange={() => setTemplate(key)}
                          className="sr-only"
                        />
                        {tProposals(
                          `template_type.${key}` as "template_type.custom",
                        )}
                      </label>
                    ))}
                  </div>
                </fieldset>

                {/* Optional bundled specification sheet. Attaching a
                    sheet enables the kiosk's "Accept and sign both
                    documents" flow — the proposal and the spec move
                    through signatures together. Default "none" means
                    the proposal stands alone; scientists attach a
                    sheet later from the proposal detail page too. */}
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("create.specification_sheet")}
                  </span>
                  <select
                    value={specSheetId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setSpecSheetId(nextId);
                      // Picking a fresh spec resets the override —
                      // the new spec's signed values become the
                      // displayed truth again. Sales has to opt back
                      // into typing a custom rate explicitly.
                      setPricingOverride(false);
                      if (!nextId) return;
                      // Pre-seed the (hidden) cost / margin inputs
                      // with the spec's signed values so the override
                      // panel, when revealed, starts from the spec's
                      // numbers rather than an empty form. Quantity
                      // intentionally stays as the user typed —
                      // order size is a proposal-level concern, not
                      // a spec-level constant.
                      //
                      // Both fields are guarded with truthiness
                      // because the DRF DecimalField serializer emits
                      // ``null`` for unset values; ``String(null)``
                      // would render the literal word "null" in the
                      // input on a spec that never had pricing typed.
                      const picked = specSheets.find(
                        (s) => s.id === nextId,
                      );
                      if (!picked) return;
                      if (picked.unit_cost) {
                        setUnitCost(String(picked.unit_cost));
                      }
                      // Margin autopopulate: prefer the explicit
                      // ``margin_percent`` the scientist typed; fall
                      // back to deriving it from cost + final price
                      // when the spec was priced via ``final_price``
                      // directly (a common path — sales sometimes
                      // skips the margin field and types the customer
                      // price). The old "only ``margin_percent``"
                      // branch left the form stuck at its hardcoded
                      // ``"30"`` default on those specs, which made it
                      // look like autopopulate was broken.
                      // ``cost / (1 − margin/100) = price``  ⇒
                      // ``margin = (1 − cost/price) × 100``.
                      if (picked.margin_percent) {
                        setMargin(String(picked.margin_percent));
                      } else if (
                        picked.unit_cost &&
                        picked.final_price
                      ) {
                        const cost = Number(picked.unit_cost);
                        const price = Number(picked.final_price);
                        if (
                          Number.isFinite(cost) &&
                          Number.isFinite(price) &&
                          price > 0 &&
                          cost > 0 &&
                          cost < price
                        ) {
                          const derived = (1 - cost / price) * 100;
                          setMargin(derived.toFixed(2));
                        }
                      }
                    }}
                    disabled={!formulationId || specSheetsQuery.isLoading}
                    className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-100"
                  >
                    <option value="">
                      {tProposals("create.specification_sheet_none")}
                    </option>
                    {
                      // Strict scope: only sheets attached to the
                      // picked formulation AND beyond draft/in_review
                      // (the backend would reject anything earlier as
                      // "spec not approved" — no point offering it).
                      //
                      // Rows that are already linked to a non-rejected
                      // proposal are rendered with ``disabled`` so they
                      // stay visible (sales searching for "where did
                      // SPEC-A go?" sees it grayed-out instead of
                      // missing) but cannot be picked — selecting one
                      // would either create a duplicate proposal
                      // against the same spec or fail the backend's
                      // OneToOne uniqueness check.
                      (formulationId
                        ? specSheets.filter(
                            (s) =>
                              s.formulation_id === formulationId &&
                              s.status !== "draft" &&
                              s.status !== "in_review",
                          )
                        : []
                      ).map((sheet) => {
                        const baseLabel = [
                          sheet.code,
                          sheet.formulation_name,
                          `v${sheet.formulation_version_number}`,
                        ]
                          .filter(Boolean)
                          .join(" · ");
                        const kindTag =
                          sheet.document_kind === "final"
                            ? " [FINAL]"
                            : " [DRAFT]";
                        // ``In use`` set: linked to a proposal that
                        // hasn't been rejected. Rejected proposals
                        // release the spec so the team can try
                        // again with adjusted terms.
                        const linkedProposalStatus =
                          sheet.linked_proposal?.status;
                        const isBusy = Boolean(
                          sheet.linked_proposal &&
                            linkedProposalStatus !== "rejected",
                        );
                        // Status chip — "Approved" reads as "ready
                        // to attach"; "Sent · PROP-0042" /
                        // "Accepted · PROP-0042" reads as "in use,
                        // here's the deal it's bundled with".
                        let chip = "";
                        if (sheet.linked_proposal && isBusy) {
                          const statusLabel = tProposals(
                            `create.spec_status.${sheet.status}` as
                              "create.spec_status.approved",
                          );
                          chip = ` · ${statusLabel} · ${sheet.linked_proposal.code}`;
                        } else if (sheet.status !== "approved") {
                          // Approved + free needs no chip — that's
                          // the ideal pick. Anything else surfaces
                          // the lifecycle stage as context.
                          chip = ` · ${tProposals(
                            `create.spec_status.${sheet.status}` as
                              "create.spec_status.approved",
                          )}`;
                        }
                        return (
                          <option
                            key={sheet.id}
                            value={sheet.id}
                            disabled={isBusy}
                          >
                            {baseLabel}
                            {kindTag}
                            {chip}
                          </option>
                        );
                      })
                    }
                  </select>
                  {(() => {
                    // Yellow inline warning when the picked spec has
                    // no pricing on file. Sales can still proceed
                    // — they just have to type the price below
                    // by hand instead of relying on the autofill.
                    if (!specSheetId) return null;
                    const picked = specSheets.find(
                      (s) => s.id === specSheetId,
                    );
                    if (!picked) return null;
                    if (picked.final_price || picked.unit_cost) return null;
                    return (
                      <p className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-yellow-100 px-2 py-1 text-[11px] font-medium text-yellow-800 ring-1 ring-inset ring-yellow-300">
                        {tProposals("create.spec_no_price_warning")}
                      </p>
                    );
                  })()}
                  <PickerHint
                    loading={
                      Boolean(formulationId) && specSheetsQuery.isLoading
                    }
                    loadingText={tProposals(
                      "create.specification_sheet_loading",
                    )}
                  >
                    {formulationId
                      ? tProposals("create.specification_sheet_hint")
                      : tProposals(
                          "create.specification_sheet_hint_pick_formulation",
                        )}
                  </PickerHint>
                </label>

                <CustomerPicker
                  orgId={orgId}
                  value={customer}
                  onChange={setCustomer}
                  onCreateNew={() => setCustomerCreating(true)}
                  dynamicsManaged={dynamicsManaged}
                />

                {(() => {
                  // Quantity is always visible — it's the one number
                  // that's genuinely per-order and the only thing
                  // sales has to type by default. Cost + margin live
                  // behind an "Adjust pricing" toggle: by default the
                  // spec's signed numbers drive the proposal (or, if
                  // no spec is attached yet, the proposal is created
                  // without pricing and sales fills it in later from
                  // the proposal detail page).
                  const pickedSpec = specSheetId
                    ? specSheets.find((s) => s.id === specSheetId) ?? null
                    : null;
                  const specHasPricing = Boolean(
                    pickedSpec &&
                      (pickedSpec.unit_cost || pickedSpec.final_price),
                  );
                  const specCurrency = (
                    pickedSpec?.currency || "GBP"
                  ).toUpperCase();
                  // Prefer the explicit final price the director
                  // signed; fall back to cost + margin derivation
                  // only if the legacy row has no final_price.
                  const specPrice =
                    pickedSpec && pickedSpec.final_price
                      ? Number(pickedSpec.final_price).toFixed(2)
                      : pickedSpec &&
                          pickedSpec.unit_cost &&
                          pickedSpec.margin_percent
                        ? (
                            Number(pickedSpec.unit_cost) /
                            (1 - Number(pickedSpec.margin_percent) / 100)
                          ).toFixed(2)
                        : null;

                  return (
                    <>
                      <label className="flex w-32 flex-col gap-1.5">
                        <span className="text-xs font-medium text-ink-700">
                          {tProposals("create.quantity")}
                        </span>
                        <input
                          type="number"
                          min={1}
                          value={quantity}
                          onChange={(e) => setQuantity(e.target.value)}
                          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </label>

                      {/* Read-only summary of the spec's signed
                       *  pricing. Renders only when a priced spec
                       *  is attached and sales hasn't opened the
                       *  override — gives them visibility into the
                       *  numbers the customer will see without
                       *  letting them retype. */}
                      {pickedSpec && specHasPricing && !pricingOverride ? (
                        <div className="flex flex-col gap-2 rounded-xl bg-amber-50 px-3 py-3 ring-1 ring-inset ring-amber-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                              {tProposals("create.spec_pricing_label")}
                            </span>
                            <button
                              type="button"
                              onClick={() => setPricingOverride(true)}
                              className="text-[11px] font-medium text-amber-900 underline-offset-2 hover:underline"
                            >
                              {tProposals("create.adjust_pricing")}
                            </button>
                          </div>
                          <div className="grid grid-cols-3 gap-2 text-xs text-amber-900">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase tracking-wide text-amber-800">
                                {tProposals("create.unit_cost")}
                              </span>
                              <span className="font-semibold text-amber-950">
                                {pickedSpec.unit_cost
                                  ? `${specCurrency} ${Number(pickedSpec.unit_cost).toFixed(2)}`
                                  : "—"}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase tracking-wide text-amber-800">
                                {tProposals("create.margin_percent")}
                              </span>
                              <span className="font-semibold text-amber-950">
                                {(() => {
                                  // Same derive-from-cost-and-price
                                  // fallback as the onChange seeder
                                  // above. Without it, a spec priced
                                  // through ``final_price`` (no
                                  // explicit ``margin_percent``) shows
                                  // "—" in this card even though the
                                  // margin is mathematically known.
                                  if (pickedSpec.margin_percent) {
                                    return `${Number(
                                      pickedSpec.margin_percent,
                                    ).toFixed(1)} %`;
                                  }
                                  if (
                                    pickedSpec.unit_cost &&
                                    pickedSpec.final_price
                                  ) {
                                    const cost = Number(
                                      pickedSpec.unit_cost,
                                    );
                                    const price = Number(
                                      pickedSpec.final_price,
                                    );
                                    if (
                                      Number.isFinite(cost) &&
                                      Number.isFinite(price) &&
                                      price > 0 &&
                                      cost > 0 &&
                                      cost < price
                                    ) {
                                      return `${((1 - cost / price) * 100).toFixed(1)} %`;
                                    }
                                  }
                                  return "—";
                                })()}
                              </span>
                            </div>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-[10px] uppercase tracking-wide text-amber-800">
                                {tProposals("create.customer_pays")}
                              </span>
                              <span className="font-semibold text-amber-950">
                                {specPrice
                                  ? `${specCurrency} ${specPrice}`
                                  : "—"}
                              </span>
                            </div>
                          </div>
                          {/* MRPEasy hint: the catalogue-suggested
                              price for this project's code. Sales
                              uses it as a sanity check against the
                              director-signed spec price beside it.
                              No autofill button here — the spec's
                              pricing is the source of truth on the
                              proposal; MRPEasy is reference only. */}
                          {pickedFormulation ? (
                            <MrpeasyPriceHint
                              orgId={orgId}
                              code={pickedFormulation.code ?? ""}
                              currency={specCurrency}
                              className="self-start"
                            />
                          ) : null}
                        </div>
                      ) : null}

                      {/* Override panel — only rendered when sales
                       *  explicitly opens it, OR when no priced spec
                       *  is attached AND they want to type pricing
                       *  ad-hoc. Default state stays clean: just the
                       *  Quantity input above. */}
                      {pricingOverride ? (
                        <div className="flex flex-col gap-2 rounded-xl bg-ink-50 px-3 py-3 ring-1 ring-inset ring-ink-200">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-700">
                              {tProposals("create.custom_pricing_label")}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                // Collapse back: when a priced spec
                                // is attached, also re-seed from it
                                // so the next override starts fresh.
                                if (pickedSpec && specHasPricing) {
                                  setUnitCost(
                                    pickedSpec.unit_cost
                                      ? String(pickedSpec.unit_cost)
                                      : "",
                                  );
                                  setMargin(
                                    pickedSpec.margin_percent
                                      ? String(pickedSpec.margin_percent)
                                      : "30",
                                  );
                                }
                                setPricingOverride(false);
                              }}
                              className="text-[11px] font-medium text-ink-700 underline-offset-2 hover:underline"
                            >
                              {pickedSpec && specHasPricing
                                ? tProposals("create.use_spec_pricing")
                                : tProposals("create.cancel_pricing")}
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <label className="flex flex-col gap-1.5">
                              <span className="text-xs font-medium text-ink-700">
                                {tProposals("create.unit_cost")}
                              </span>
                              <input
                                type="number"
                                step="0.0001"
                                value={unitCost}
                                onChange={(e) =>
                                  setUnitCost(e.target.value)
                                }
                                className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                              />
                            </label>
                            <label className="flex flex-col gap-1.5">
                              <span className="text-xs font-medium text-ink-700">
                                {tProposals("create.margin_percent")}
                              </span>
                              <input
                                type="number"
                                step="0.1"
                                value={margin}
                                onChange={(e) => setMargin(e.target.value)}
                                className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                              />
                            </label>
                          </div>
                          <div
                            className={`rounded-lg px-3 py-2 text-sm font-medium ring-1 ring-inset ${
                              derivedUnitPrice === null
                                ? "bg-ink-0 text-ink-500 ring-ink-200"
                                : "bg-success/10 text-success ring-success/30"
                            }`}
                          >
                            {derivedUnitPrice === null
                              ? tProposals("create.price_placeholder")
                              : tProposals("create.price_derived", {
                                  price: derivedUnitPrice.toFixed(2),
                                })}
                          </div>
                        </div>
                      ) : !pickedSpec || !specHasPricing ? (
                        // No spec attached (or spec has no pricing
                        // on file) and override isn't open yet —
                        // surface a quiet hint so sales knows where
                        // to type ad-hoc cost / margin if they need.
                        <button
                          type="button"
                          onClick={() => setPricingOverride(true)}
                          className="self-start text-xs font-medium text-ink-700 underline-offset-2 hover:underline"
                        >
                          {tProposals("create.adjust_pricing")}
                        </button>
                      ) : null}
                    </>
                  );
                })()}

                {error ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={close}
                  isDisabled={createMutation.isPending}
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                >
                  {tProposals("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  isDisabled={createMutation.isPending}
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                >
                  {tProposals("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* Mount inside the outer Modal so the create-customer dialog
          stacks above the proposal dialog instead of dismissing it.
          On create we snap the new customer into the picker so the
          scientist doesn't have to re-find it. */}
      <CustomerFormModal
        orgId={orgId}
        mode="create"
        isOpen={customerCreating}
        onClose={() => setCustomerCreating(false)}
        initial={null}
        onCreated={(c) => setCustomer(c)}
      />
    </Modal>
  );
}


/**
 * Tiny shared subhint under a picker dropdown. Shows a spinning
 * Loader2 + ``loadingText`` while the underlying query is in flight,
 * otherwise falls through to the static ``children`` hint. Lets
 * users tell "the list is loading" apart from "the list really is
 * empty" — pickers without this look identical in either state.
 */
function PickerHint({
  loading,
  loadingText,
  children,
}: {
  loading: boolean;
  loadingText: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-500">
        <Loader2 className="h-3 w-3 animate-spin" />
        {loadingText}
      </span>
    );
  }
  if (children === null || children === false) return null;
  return (
    <span className="text-[11px] text-ink-500">{children}</span>
  );
}
