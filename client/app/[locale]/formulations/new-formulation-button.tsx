"use client";

import { Button, Modal } from "@heroui/react";
import {
  Check,
  CircleOff,
  FlaskConical,
  Loader2,
  Plus,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, type FormEvent } from "react";

import { Chip } from "@/components/ui/chip";
import { MrpeasyItemPicker } from "@/components/mrpeasy/mrpeasy-item-picker";
import { PspItemPicker } from "@/components/psp/psp-item-picker";
import { useCreatePspFinishedProduct } from "@/services/psp";
import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useGenerateFormulationDraft,
  type AIProviderSlug,
  type IngredientSuggestionDto,
} from "@/services/ai";
import {
  applyStageTemplate,
  replaceFormulationLines,
  useCreateFormulation,
  useStageTemplates,
  type DosageForm,
  type FormulationLineInput,
} from "@/services/formulations";
import { useCreateProjectFromCFF } from "@/services/cff-submissions";
import { useOrganization } from "@/services/organizations";


interface ApiFieldErrors {
  fieldErrors?: Record<string, unknown>;
}


/**
 * Provider options the picker surfaces. Only Ollama today; OpenAI /
 * Anthropic / Groq / Gemini will slot in here (and in the backend
 * registry) once those adapters land. The ``free`` flag drives the
 * "Free" chip on the option.
 */
const PROVIDER_OPTIONS: readonly {
  readonly slug: AIProviderSlug;
  readonly labelKey: "providers.ollama";
  readonly free: true;
}[] = [
  { slug: "ollama", labelKey: "providers.ollama", free: true },
];


/**
 * The default dosage form list — mirrors the backend enum. Broken
 * out so the AI-populated dropdown can fall back cleanly when the
 * model returns an unexpected value (extremely rare with ``format=json``
 * + the constrained prompt, but defensive is cheap).
 */
const DOSAGE_FORMS: readonly DosageForm[] = [
  "capsule",
  "tablet",
  "powder",
  "gummy",
  "liquid",
  "other_solid",
];


/**
 * How the UI classifies a single AI-suggested ingredient, driven by
 * the backend ``auto_attach`` flag (which is ``confidence ≥ 0.75``
 * and has an item id) plus the user's manual override selection.
 *
 * ``auto`` — backend flagged high-confidence, ships straight into
 * the formulation lines unless the user opts out.
 * ``review`` — a match exists but the backend isn't confident; the
 * UI requires the scientist to pick one of the alternatives (or the
 * top match, or skip).
 * ``unmatched`` — no candidate scored above zero. Rendered for
 * transparency but never becomes a formulation line.
 */
type IngredientStatus = "auto" | "review" | "unmatched";


/** Per-ingredient UI state the scientist can override.
 *
 * ``selectedItemId`` — ``undefined`` means "use the backend default"
 * (the backend's top match for ``auto`` rows, or ``null`` for
 * ``review``/``unmatched`` rows until the user picks one).
 * ``null`` is an explicit opt-out — skip this ingredient entirely. */
interface IngredientChoice {
  readonly selectedItemId: string | null | undefined;
}


function statusForIngredient(
  ingredient: IngredientSuggestionDto,
): IngredientStatus {
  if (ingredient.auto_attach && ingredient.matched_item_id) return "auto";
  if (ingredient.matched_item_id) return "review";
  return "unmatched";
}


function resolvedItemId(
  ingredient: IngredientSuggestionDto,
  choice: IngredientChoice | undefined,
): string | null {
  if (choice && choice.selectedItemId !== undefined) {
    return choice.selectedItemId;
  }
  // Default: auto-attach rides on the top match; review/unmatched
  // wait for an explicit pick.
  return ingredient.auto_attach ? ingredient.matched_item_id : null;
}


/**
 * The "+ New project" surface used on the projects page AND on the
 * CFF inbox when an operator wants to spin up a project for a fresh
 * customer request.
 *
 * Two operating modes:
 *
 * * **Standalone** (default) — the button renders its own trigger
 *   and is opened by the operator. Post-create routes to the new
 *   project page.
 * * **CFF triage** — set ``cffSubmissionId`` and (usually)
 *   ``externallyOpen`` / ``onClose`` so the CFF detail modal can
 *   open this dialog as a sibling. Post-create routes through
 *   :func:`createProjectFromCFF` which (in one transaction)
 *   creates the project, attaches the CFF, and best-effort
 *   auto-assigns the sales person matched against the customer's
 *   account-manager email. Returns the same navigation result.
 */
export function NewFormulationButton({
  orgId,
  cffSubmissionId,
  initialDescription,
  externallyOpen,
  onClose: onExternalClose,
  onCFFCreated,
}: {
  readonly orgId: string;
  /** CFF id — when set, the post-create flow goes through the
   *  ``create-project-from-cff`` endpoint instead of the regular
   *  ``create_formulation`` so the CFF attach + sales auto-assign
   *  run atomically alongside the project insert. */
  readonly cffSubmissionId?: string;
  /** Pre-fill the description field on first render. Used by the
   *  CFF flow to seed "From CFF intake — <market segment>". */
  readonly initialDescription?: string;
  /** Externally controlled open-state. When provided the
   *  component's own ``Modal.Trigger`` is suppressed and parent
   *  state drives the dialog visibility. */
  readonly externallyOpen?: boolean;
  /** Called when the externally-controlled modal closes. */
  readonly onClose?: () => void;
  /** Fires after a successful CFF create-project response so the
   *  CFF page can show the sales-auto-assign outcome before
   *  navigating away. */
  readonly onCFFCreated?: (result: {
    readonly projectId: string;
    readonly projectCode: string;
    readonly projectName: string;
    readonly autoAssignedSalesPersonEmail: string | null;
    readonly cffSalesPersonEmailHint: string | null;
    readonly canAssignSalesPerson: boolean;
  }) => void;
}) {
  const tFormulations = useTranslations("formulations");
  const tAI = useTranslations("ai");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  // When MRPEasy is connected, the workspace treats the ERP as the
  // source of truth for product codes + names. The picker above the
  // code/name inputs is the only way to populate them, and the
  // inputs themselves render read-only so an operator can't type a
  // stray SKU that doesn't exist in MRPEasy. Mirrors the Dynamics-
  // managed-customers pattern: integration on → manual entry off.
  const organization = useOrganization(orgId);
  const mrpeasyLive = Boolean(organization?.mrpeasy_live);
  // PSP and MRPEasy are mutually exclusive server-side, so this is
  // effectively ``xor`` — but naming it ``sourcedLive`` makes the
  // "some upstream integration is populating these fields" intent
  // obvious at the field-lock sites below.
  const pspLive = Boolean(organization?.psp_live);
  const sourcedLive = mrpeasyLive || pspLive;

  const [internalOpen, setInternalOpen] = useState(false);
  // Single source of truth for "is the dialog open?": parent state
  // wins when present, otherwise we manage our own.
  const isOpen = externallyOpen ?? internalOpen;
  const isCFFMode = Boolean(cffSubmissionId);

  // AI draft state
  const [brief, setBrief] = useState("");
  const [provider, setProvider] = useState<AIProviderSlug>("ollama");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [ingredients, setIngredients] = useState<
    readonly IngredientSuggestionDto[]
  >([]);
  const [choices, setChoices] = useState<
    Readonly<Record<number, IngredientChoice>>
  >({});

  // Form state — ``code`` is the scientist's own project reference
  // (``MA210367``, ``FB-001``). It's mandatory and must be unique
  // per organisation; the backend rejects blank or duplicate codes
  // so the same string can travel through MRPeasy, the spec sheet
  // and the proposal without divergence.
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  // When the "Pick from PSP catalogue" picker is used at creation,
  // the picked item's uuid lands here. The formulation is then
  // linked back to that PSP finished product; every builder save
  // triggers a BOM push via ``push_bom_to_psp``. Null when the
  // scientist typed the code manually or PSP isn't the live
  // integration.
  const [pspFinishedProductUuid, setPspFinishedProductUuid] = useState<
    string | null
  >(null);
  // "Create new PSP item" branch state — collapsed by default, opens
  // an inline form the scientist can fill in without leaving the
  // dialog. Successful create populates ``pspFinishedProductUuid``
  // (same slot the picker uses) so the downstream flow doesn't need
  // to branch on whether the item was picked or created.
  const [pspCreateOpen, setPspCreateOpen] = useState(false);
  const [pspNewName, setPspNewName] = useState("");
  const [pspNewSku, setPspNewSku] = useState("");
  const [pspNewDescription, setPspNewDescription] = useState("");
  const [pspNewBarcode, setPspNewBarcode] = useState("");
  const [pspCreateError, setPspCreateError] = useState<string | null>(null);
  // Shown after a successful create so the scientist can see what
  // was just linked. Kept until the dialog closes.
  const [pspCreatedChip, setPspCreatedChip] = useState<{
    name: string;
    externalSku: string;
  } | null>(null);
  const [description, setDescription] = useState(initialDescription ?? "");
  const [dosageForm, setDosageForm] = useState<DosageForm>("capsule");
  // Optional stage template applied post-create so the Stages tab
  // isn't blank when the scientist lands there. Empty string = skip
  // (formulation created with no stages, matching legacy behaviour).
  const [stageTemplateId, setStageTemplateId] = useState<string>("");
  const [servingsPerPack, setServingsPerPack] = useState(60);
  const [servingSize, setServingSize] = useState(1);
  const [directionsOfUse, setDirectionsOfUse] = useState("");
  const [suggestedDosage, setSuggestedDosage] = useState("");
  const [appearance, setAppearance] = useState("");
  const [disintegrationSpec, setDisintegrationSpec] = useState("");
  const [error, setError] = useState<string | null>(null);

  const draftMutation = useGenerateFormulationDraft(orgId);
  const createMutation = useCreateFormulation(orgId);
  const createPspFinishedMutation = useCreatePspFinishedProduct(orgId);
  // Load once when the dialog mounts. staleTime on the hook keeps
  // subsequent opens cheap.
  const stageTemplatesQuery = useStageTemplates(orgId);
  const stageTemplates = stageTemplatesQuery.data?.items ?? [];
  // CFF triage path uses a dedicated endpoint that creates the
  // project + attaches the CFF + auto-assigns the sales person
  // in one transaction. Both hooks are instantiated so the choice
  // can branch per-submit without breaking React's rules-of-hooks.
  const cffCreateMutation = useCreateProjectFromCFF(orgId);
  // The lines endpoint needs the fresh ``formulation_id`` the
  // /formulations POST just returned. We call its raw API function
  // imperatively right after create — wiring a ``useReplaceLines``
  // hook against a ``useState`` id runs into a stale-closure bug
  // where the mutation fires before React re-renders with the new
  // id, emitting a malformed URL without the formulation segment.
  const [isAttachingLines, setIsAttachingLines] = useState(false);

  const reset = () => {
    setBrief("");
    setProvider("ollama");
    setIngredients([]);
    setChoices({});
    setDraftError(null);
    setCode("");
    setName("");
    setPspFinishedProductUuid(null);
    setPspCreateOpen(false);
    setPspNewName("");
    setPspNewSku("");
    setPspNewDescription("");
    setPspNewBarcode("");
    setPspCreateError(null);
    setPspCreatedChip(null);
    setDescription(initialDescription ?? "");
    setDosageForm("capsule");
    setStageTemplateId("");
    setServingsPerPack(60);
    setServingSize(1);
    setDirectionsOfUse("");
    setSuggestedDosage("");
    setAppearance("");
    setDisintegrationSpec("");
    setError(null);
    setIsAttachingLines(false);
  };

  const close = () => {
    if (externallyOpen !== undefined) {
      onExternalClose?.();
    } else {
      setInternalOpen(false);
    }
    reset();
  };

  const handleGenerate = async () => {
    setDraftError(null);
    if (!brief.trim()) return;
    try {
      const draft = await draftMutation.mutateAsync({
        brief: brief.trim(),
        provider,
      });
      // Normalise the AI's dosage form against the enum — anything
      // unexpected falls back to ``capsule`` so the select doesn't
      // render an invalid option.
      const normalisedDosageForm = (DOSAGE_FORMS as readonly string[]).includes(
        draft.dosage_form,
      )
        ? (draft.dosage_form as DosageForm)
        : "capsule";

      setName(draft.name);
      // ``draft.code`` is surfaced as a *suggestion* into the code
      // field — scientists almost always overwrite it with their
      // own MRPeasy / lab-book reference, but starting from the AI
      // value saves a few keystrokes when the suggestion is close.
      // The backend enforces uniqueness, so a collision on re-run
      // against the same org surfaces as a 400 the user can fix in
      // place rather than a silent auto-rewrite.
      setCode(draft.code ?? "");
      setDescription(draft.description);
      setDosageForm(normalisedDosageForm);
      setServingsPerPack(
        Number.isFinite(draft.servings_per_pack) && draft.servings_per_pack > 0
          ? draft.servings_per_pack
          : 60,
      );
      setServingSize(
        Number.isFinite(draft.serving_size) && draft.serving_size > 0
          ? draft.serving_size
          : 1,
      );
      setDirectionsOfUse(draft.directions_of_use);
      setSuggestedDosage(draft.suggested_dosage);
      setAppearance(draft.appearance);
      setDisintegrationSpec(draft.disintegration_spec);
      setIngredients(draft.ingredients);
      setChoices({});
    } catch (err) {
      setDraftError(extractDraftError(err, tAI, tErrors));
    }
  };

  const setChoice = (index: number, choice: IngredientChoice) => {
    setChoices((prev) => ({ ...prev, [index]: choice }));
  };

  /**
   * Fold the raw AI ingredients + user overrides into the line input
   * shape the formulations API expects. An ingredient contributes a
   * line only when a concrete ``item_id`` is resolved — opt-outs,
   * unmatched rows, and unattended ``review`` rows drop silently so
   * the builder stays clean after creation.
   */
  const linesToSave = useMemo<readonly FormulationLineInput[]>(() => {
    const out: FormulationLineInput[] = [];
    ingredients.forEach((ingredient, idx) => {
      const itemId = resolvedItemId(ingredient, choices[idx]);
      if (!itemId) return;
      out.push({
        item_id: itemId,
        label_claim_mg: String(Math.max(0, ingredient.label_claim_mg)),
        display_order: out.length,
        notes: ingredient.notes,
      });
    });
    return out;
  }, [ingredients, choices]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      // CFF triage path uses the dedicated endpoint so the project
      // create, CFF attach, and sales auto-assign land in one
      // transaction. The standalone path stays on the existing
      // ``useCreateFormulation`` hook so nothing changes for the
      // projects-page invocation.
      const projectId = isCFFMode
        ? await submitViaCFF()
        : await submitDirect();
      if (projectId === null) return;

      // Optional stage-template seed. Fires after the project (and
      // any AI-matched lines) exist so the wholesale-replace endpoint
      // can attach lines to the freshly-created stages. Silent-degrade
      // on failure — the project is already created, so we don't
      // want a template apply blip to poison the redirect.
      if (stageTemplateId) {
        try {
          await applyStageTemplate(orgId, projectId, stageTemplateId);
        } catch {
          // Non-fatal; scientist can re-apply from the Stages tab.
        }
      }

      close();
      router.push(`/formulations/${projectId}`);
    } catch (err) {
      const fieldErrors = (err as ApiFieldErrors).fieldErrors ?? {};
      const firstKey = Object.keys(fieldErrors)[0];
      const firstCode =
        firstKey && Array.isArray(fieldErrors[firstKey])
          ? String((fieldErrors[firstKey] as string[])[0] ?? "")
          : "";
      setError(
        firstCode ? translateCode(tErrors, firstCode) : tErrors("generic"),
      );
    }
  };


  /** Standalone create path: create the project, then attach the
   *  AI-matched ingredient lines as a sidecar call. Returns the
   *  new project id or ``null`` when a lines-attach failure has
   *  already surfaced an inline error to the operator. */
  const submitDirect = async (): Promise<string | null> => {
    const created = await createMutation.mutateAsync({
      name: name.trim(),
      code: code.trim(),
      description: description.trim(),
      dosage_form: dosageForm,
      servings_per_pack: servingsPerPack,
      serving_size: servingSize,
      directions_of_use: directionsOfUse.trim(),
      suggested_dosage: suggestedDosage.trim(),
      appearance: appearance.trim(),
      disintegration_spec: disintegrationSpec.trim(),
      psp_finished_product_uuid: pspFinishedProductUuid,
    });

    if (linesToSave.length > 0) {
      setIsAttachingLines(true);
      try {
        await replaceFormulationLines(orgId, created.id, {
          lines: linesToSave,
        });
      } catch {
        setError(tAI("create.lines_failed"));
        setIsAttachingLines(false);
        return null;
      }
      setIsAttachingLines(false);
    }
    return created.id;
  };


  /** CFF triage create path. Creates project + attaches CFF + runs
   *  sales auto-assignment atomically on the server, then attaches
   *  the AI-matched ingredient lines as the same sidecar call the
   *  standalone path uses. */
  const submitViaCFF = async (): Promise<string | null> => {
    const result = await cffCreateMutation.mutateAsync({
      submissionId: cffSubmissionId!,
      payload: {
        name: name.trim(),
        code: code.trim(),
        description: description.trim(),
        dosage_form: dosageForm,
        servings_per_pack: servingsPerPack,
        serving_size: servingSize,
        directions_of_use: directionsOfUse.trim(),
        suggested_dosage: suggestedDosage.trim(),
        appearance: appearance.trim(),
        disintegration_spec: disintegrationSpec.trim(),
      },
    });

    if (linesToSave.length > 0) {
      setIsAttachingLines(true);
      try {
        await replaceFormulationLines(orgId, result.project.id, {
          lines: linesToSave,
        });
      } catch {
        setError(tAI("create.lines_failed"));
        setIsAttachingLines(false);
        return null;
      }
      setIsAttachingLines(false);
    }

    onCFFCreated?.({
      projectId: result.project.id,
      projectCode: result.project.code,
      projectName: result.project.name,
      autoAssignedSalesPersonEmail:
        result.auto_assigned_sales_person?.email ?? null,
      cffSalesPersonEmailHint: result.cff_sales_person_email_hint,
      canAssignSalesPerson: result.can_assign_sales_person,
    });
    return result.project.id;
  };

  const isBusy =
    createMutation.isPending ||
    cffCreateMutation.isPending ||
    isAttachingLines;
  const isGenerating = draftMutation.isPending;

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (open) {
          if (externallyOpen === undefined) {
            setInternalOpen(true);
          }
        } else {
          close();
        }
      }}
    >
      {/* Suppress the internal trigger when the modal is opened
          by a parent — the CFF detail modal renders its own
          "Create new project" button and just flips the
          ``externallyOpen`` prop. */}
      {externallyOpen === undefined ? (
        <Modal.Trigger>
          <Button
            type="button"
            variant="primary"
            size="md"
            className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
          >
            <span className="inline-flex items-center gap-1.5">
              <Plus className="h-4 w-4" />
              {tFormulations("new_formulation")}
            </span>
          </Button>
        </Modal.Trigger>
      ) : null}
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="flex max-h-[90vh] flex-col overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form
              onSubmit={handleSubmit}
              className="flex min-h-0 flex-1 flex-col"
            >
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tFormulations("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6">
                {/* ------------------------------------------------- */}
                {/* AI draft panel                                    */}
                {/* ------------------------------------------------- */}
                <section className="flex flex-col gap-3 rounded-xl bg-gradient-to-br from-orange-50 to-ink-0 p-4 ring-1 ring-inset ring-orange-200">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-orange-700">
                    <Sparkles className="h-3.5 w-3.5" />
                    {tAI("draft.heading")}
                  </div>
                  <textarea
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder={tAI("draft.placeholder")}
                    rows={3}
                    disabled={isGenerating}
                    className="w-full resize-y rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none placeholder:text-ink-400 focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs text-ink-700">
                      <span>{tAI("draft.model_label")}</span>
                      <select
                        value={provider}
                        onChange={(e) =>
                          setProvider(e.target.value as AIProviderSlug)
                        }
                        disabled={isGenerating}
                        className="cursor-pointer rounded-lg bg-ink-0 px-2 py-1 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:opacity-60"
                      >
                        {PROVIDER_OPTIONS.map((opt) => (
                          <option key={opt.slug} value={opt.slug}>
                            {tAI(opt.labelKey)}
                            {opt.free ? ` — ${tAI("draft.free_tag")}` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={handleGenerate}
                      isDisabled={isGenerating || !brief.trim()}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
                    >
                      {isGenerating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5" />
                      )}
                      {isGenerating
                        ? tAI("draft.generating")
                        : tAI("draft.generate")}
                    </Button>
                  </div>
                  {draftError ? (
                    <p
                      role="alert"
                      className="rounded-lg bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
                    >
                      {draftError}
                    </p>
                  ) : null}
                </section>

                {/* ------------------------------------------------- */}
                {/* Core metadata                                     */}
                {/* ------------------------------------------------- */}
                {/* Upstream item picker. Both MRPEasy and PSP
                    versions self-gate on their respective ``*_live``
                    flag; since the two integrations are mutually
                    exclusive on the org, at most one renders. The
                    picked item auto-fills the code + name inputs
                    below via the same ``{code, title}`` callback
                    shape. When neither is live, the form behaves as
                    before with free-text entry. */}
                <MrpeasyItemPicker
                  orgId={orgId}
                  onPick={(item) => {
                    setCode(item.code);
                    setName(item.title);
                  }}
                />
                <PspItemPicker
                  orgId={orgId}
                  onPick={(item) => {
                    setCode(item.code);
                    setName(item.title);
                    setPspFinishedProductUuid(item.uuid);
                    setPspCreatedChip(null);
                  }}
                />
                {/* "Create new PSP item" branch — visible only when
                    PSP is the live integration. Fires a POST to
                    /integrations/psp/finished-products/ and populates
                    the same code/name/uuid state slots the picker
                    fills, so the downstream ``create_formulation``
                    call doesn't need to branch on how the item got
                    there. */}
                {pspLive ? (
                  <div className="rounded-lg bg-ink-50 p-3 ring-1 ring-inset ring-ink-200">
                    {pspCreatedChip ? (
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-ink-700">
                            New PSP item linked
                          </p>
                          <p className="mt-0.5 text-[11px] text-ink-600">
                            <span className="font-medium">
                              {pspCreatedChip.name}
                            </span>{" "}
                            · SKU {pspCreatedChip.externalSku}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPspCreatedChip(null);
                            setPspFinishedProductUuid(null);
                            setCode("");
                            setName("");
                          }}
                          className="rounded p-1 text-[11px] text-ink-500 hover:bg-ink-100"
                        >
                          Unlink
                        </button>
                      </div>
                    ) : !pspCreateOpen ? (
                      <button
                        type="button"
                        onClick={() => setPspCreateOpen(true)}
                        className="text-xs font-medium text-orange-600 hover:text-orange-700"
                      >
                        + Or create a brand-new PSP finished-product item
                      </button>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs font-medium text-ink-700">
                          Create new PSP item (finished product)
                        </p>
                        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] text-ink-600">
                              Name *
                            </span>
                            <input
                              value={pspNewName}
                              onChange={(e) => setPspNewName(e.target.value)}
                              placeholder="e.g. Vitamin C 500 mg — 60 ct"
                              maxLength={200}
                              className="w-full rounded-lg bg-ink-0 px-2.5 py-1.5 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] text-ink-600">
                              External SKU (optional)
                            </span>
                            <input
                              value={pspNewSku}
                              onChange={(e) => setPspNewSku(e.target.value)}
                              placeholder="Blank → auto NPD-FP-…"
                              maxLength={100}
                              className="w-full rounded-lg bg-ink-0 px-2.5 py-1.5 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                            />
                          </label>
                          <label className="flex flex-col gap-1 md:col-span-2">
                            <span className="text-[11px] text-ink-600">
                              Description (optional)
                            </span>
                            <input
                              value={pspNewDescription}
                              onChange={(e) =>
                                setPspNewDescription(e.target.value)
                              }
                              maxLength={500}
                              className="w-full rounded-lg bg-ink-0 px-2.5 py-1.5 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                            />
                          </label>
                          <label className="flex flex-col gap-1 md:col-span-2">
                            <span className="text-[11px] text-ink-600">
                              Barcode (GTIN, optional)
                            </span>
                            <input
                              value={pspNewBarcode}
                              onChange={(e) => setPspNewBarcode(e.target.value)}
                              placeholder="e.g. 05012345678900"
                              maxLength={32}
                              className="w-full rounded-lg bg-ink-0 px-2.5 py-1.5 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                            />
                          </label>
                        </div>
                        {pspCreateError ? (
                          <p className="rounded bg-red-50 p-2 text-[11px] text-red-700 ring-1 ring-inset ring-red-200">
                            {pspCreateError}
                          </p>
                        ) : null}
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setPspCreateOpen(false);
                              setPspCreateError(null);
                            }}
                            disabled={createPspFinishedMutation.isPending}
                            className="rounded-lg px-2.5 py-1 text-xs text-ink-700 hover:bg-ink-100 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              setPspCreateError(null);
                              const trimmedName = pspNewName.trim();
                              if (!trimmedName) {
                                setPspCreateError("Name is required.");
                                return;
                              }
                              try {
                                const res =
                                  await createPspFinishedMutation.mutateAsync({
                                    name: trimmedName,
                                    external_sku: pspNewSku.trim() || undefined,
                                    description:
                                      pspNewDescription.trim() || undefined,
                                    barcode: pspNewBarcode.trim() || undefined,
                                  });
                                setPspFinishedProductUuid(res.uuid);
                                // Prefer PSP's system numbering code
                                // (``MA00295``) — that's the value the
                                // scientist recognises. Fall back to
                                // the load-bearing ``external_sku`` on
                                // older PSP builds that don't emit
                                // ``code`` on the create response.
                                setCode(res.code || res.external_sku);
                                setName(res.name);
                                setPspCreatedChip({
                                  name: res.name,
                                  externalSku: res.code || res.external_sku,
                                });
                                setPspCreateOpen(false);
                              } catch (err) {
                                setPspCreateError(
                                  err instanceof Error
                                    ? err.message
                                    : "Couldn't create the PSP item.",
                                );
                              }
                            }}
                            disabled={createPspFinishedMutation.isPending}
                            className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-orange-600 disabled:opacity-50"
                          >
                            {createPspFinishedMutation.isPending
                              ? "Creating…"
                              : "Create + link"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : null}

                <div className="flex flex-col gap-1.5">
                  <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-ink-700">
                        {tFormulations("fields.code")}
                      </span>
                      <input
                        required
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        placeholder={
                          sourcedLive
                            ? tFormulations(
                                "mrpeasy_picker.locked_placeholder",
                              )
                            : tFormulations("placeholders.code")
                        }
                        maxLength={64}
                        readOnly={sourcedLive}
                        aria-readonly={sourcedLive}
                        // Read-only styling: muted background + a not-
                        // allowed cursor so the operator gets visual
                        // confirmation they can't type here, without
                        // killing copy-to-clipboard (which ``disabled``
                        // would block).
                        className={`w-full rounded-lg px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset outline-none focus:ring-2 focus:ring-orange-400 ${
                          sourcedLive
                            ? "cursor-not-allowed bg-ink-100 ring-ink-200"
                            : "bg-ink-0 ring-ink-200"
                        }`}
                      />
                    </label>
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-ink-700">
                        {tFormulations("fields.name")}
                      </span>
                      <input
                        required
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={
                          sourcedLive
                            ? tFormulations(
                                "mrpeasy_picker.locked_placeholder",
                              )
                            : tFormulations("placeholders.name")
                        }
                        readOnly={sourcedLive}
                        aria-readonly={sourcedLive}
                        className={`w-full rounded-lg px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset outline-none focus:ring-2 focus:ring-orange-400 ${
                          sourcedLive
                            ? "cursor-not-allowed bg-ink-100 ring-ink-200"
                            : "bg-ink-0 ring-ink-200"
                        }`}
                      />
                    </label>
                  </div>
                  {sourcedLive ? (
                    <p className="text-[11px] text-ink-500">
                      {tFormulations("mrpeasy_picker.locked_hint")}
                    </p>
                  ) : null}
                </div>

                {description ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      {tFormulations("fields.description")}
                    </span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={2}
                      className="w-full resize-y rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </label>
                ) : null}

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      {tFormulations("fields.dosage_form")}
                    </span>
                    <select
                      value={dosageForm}
                      onChange={(e) =>
                        setDosageForm(e.target.value as DosageForm)
                      }
                      className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    >
                      {DOSAGE_FORMS.map((f) => (
                        <option key={f} value={f}>
                          {tFormulations(`dosage_forms.${f}`)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      {tFormulations("fields.servings_per_pack")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={servingsPerPack}
                      onChange={(e) =>
                        setServingsPerPack(Number(e.target.value))
                      }
                      className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                  </label>
                </div>

                {/* Stage template — optional. Seeds the Stages tab
                    with a canonical route so the scientist doesn't
                    start with a blank canvas. Filtered by the picked
                    dosage form so the dropdown surfaces the most
                    relevant options first; templates without a
                    ``dosage_form`` hint always show. */}
                {stageTemplates.length > 0 ? (
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-ink-700">
                      Stage template
                    </span>
                    <select
                      value={stageTemplateId}
                      onChange={(e) => setStageTemplateId(e.target.value)}
                      className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    >
                      <option value="">— no template (blank) —</option>
                      {(() => {
                        const matching = stageTemplates.filter(
                          (t) => !t.dosage_form || t.dosage_form === dosageForm,
                        );
                        const others = stageTemplates.filter(
                          (t) => t.dosage_form && t.dosage_form !== dosageForm,
                        );
                        return (
                          <>
                            {matching.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name}
                                {t.stages.length > 0
                                  ? ` (${t.stages.length} stages)`
                                  : ""}
                              </option>
                            ))}
                            {others.length > 0 ? (
                              <optgroup label="Other dosage forms">
                                {others.map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.name}
                                    {t.stages.length > 0
                                      ? ` (${t.stages.length} stages)`
                                      : ""}
                                  </option>
                                ))}
                              </optgroup>
                            ) : null}
                          </>
                        );
                      })()}
                    </select>
                    <p className="text-[11px] text-ink-500">
                      Optional. Seeds the Stages tab on create; you
                      can also apply / re-apply from the Stages tab.
                    </p>
                  </label>
                ) : null}

                {/* ------------------------------------------------- */}
                {/* AI-only extras — surfaced only when populated so  */}
                {/* a hand-typed form stays compact.                  */}
                {/* ------------------------------------------------- */}
                {(directionsOfUse ||
                  suggestedDosage ||
                  appearance ||
                  disintegrationSpec) ? (
                  <div className="grid grid-cols-1 gap-5 border-t border-ink-100 pt-4 md:grid-cols-2">
                    {directionsOfUse ? (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-ink-700">
                          {tFormulations("fields.directions_of_use")}
                        </span>
                        <input
                          value={directionsOfUse}
                          onChange={(e) => setDirectionsOfUse(e.target.value)}
                          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </label>
                    ) : null}
                    {suggestedDosage ? (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-ink-700">
                          {tFormulations("fields.suggested_dosage")}
                        </span>
                        <input
                          value={suggestedDosage}
                          onChange={(e) => setSuggestedDosage(e.target.value)}
                          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </label>
                    ) : null}
                    {appearance ? (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-ink-700">
                          {tFormulations("fields.appearance")}
                        </span>
                        <input
                          value={appearance}
                          onChange={(e) => setAppearance(e.target.value)}
                          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </label>
                    ) : null}
                    {disintegrationSpec ? (
                      <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-ink-700">
                          {tFormulations("fields.disintegration_spec")}
                        </span>
                        <input
                          value={disintegrationSpec}
                          onChange={(e) =>
                            setDisintegrationSpec(e.target.value)
                          }
                          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}

                {/* ------------------------------------------------- */}
                {/* Ingredient suggestions                            */}
                {/*                                                   */}
                {/* Each row surfaces the AI's proposed ingredient    */}
                {/* alongside the matcher's catalogue pick. Auto-     */}
                {/* attach rows land as formulation lines on Create;  */}
                {/* review rows wait for an explicit pick; unmatched  */}
                {/* rows never persist but still appear for visibility*/}
                {/* so the scientist knows what the AI suggested.     */}
                {/* ------------------------------------------------- */}
                {ingredients.length > 0 ? (
                  <section className="flex flex-col gap-3 border-t border-ink-100 pt-4">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-ink-700">
                      <FlaskConical className="h-3.5 w-3.5 text-ink-500" />
                      {tAI("ingredients.heading", {
                        count: ingredients.length,
                      })}
                    </div>
                    <p className="text-xs text-ink-500">
                      {tAI("ingredients.hint")}
                    </p>
                    <ul className="flex flex-col gap-2">
                      {ingredients.map((ingredient, idx) => (
                        <IngredientRow
                          key={`${ingredient.name}-${idx}`}
                          ingredient={ingredient}
                          choice={choices[idx]}
                          onSelect={(selectedItemId) =>
                            setChoice(idx, { selectedItemId })
                          }
                          tAI={tAI}
                        />
                      ))}
                    </ul>
                  </section>
                ) : null}

                {error ? (
                  <p
                    role="alert"
                    className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={close}
                  isDisabled={isBusy}
                >
                  {tFormulations("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={isBusy || !name.trim() || !code.trim()}
                >
                  {tFormulations("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


/**
 * Map AI-specific DRF error payloads to translated human text.
 *
 * The backend emits one ``detail`` code per failure mode — we branch
 * on the code so the user sees something actionable ("Start Ollama")
 * instead of a generic error.
 */
function extractDraftError(
  err: unknown,
  tAI: ReturnType<typeof useTranslations<"ai">>,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (err instanceof ApiError) {
    // ``status === 0`` is our normalizer's signal for network failures
    // — axios timeouts (ECONNABORTED), DNS errors, connection refused.
    // Surface the AI-specific timeout copy so the user knows to retry
    // or pick a smaller model rather than seeing a generic error.
    if (err.status === 0) return tAI("errors.provider_timeout");

    const detail = err.fieldErrors.detail;
    const first =
      Array.isArray(detail) && detail.length > 0 ? String(detail[0]) : "";
    switch (first) {
      case "provider_unreachable":
        return tAI("errors.provider_unreachable");
      case "provider_timeout":
        return tAI("errors.provider_timeout");
      case "provider_bad_response":
      case "ai_response_invalid":
        return tAI("errors.provider_bad_response");
      default:
        if (first) return translateCode(tErrors, first);
    }
  }
  return tErrors("generic");
}


function formatMg(value: number): string {
  if (!Number.isFinite(value)) return "0";
  // Whole numbers render without the trailing .0; fractional values
  // keep one decimal so "12.5 mg" stays readable without being chatty.
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}


/**
 * Status-aware chip for a single AI ingredient suggestion.
 *
 * ``auto`` rows show a green check + the matched raw material name
 * pre-filled; the scientist can still open the dropdown to swap in
 * an alternative or opt out. ``review`` rows show an amber warning
 * and force a pick — the dropdown defaults to the top match so the
 * scientist just confirms rather than retypes. ``unmatched`` rows
 * are grey and informational; no dropdown, because there's nothing
 * in the catalogue to choose.
 */
function IngredientRow({
  ingredient,
  choice,
  onSelect,
  tAI,
}: {
  ingredient: IngredientSuggestionDto;
  choice: IngredientChoice | undefined;
  onSelect: (itemId: string | null | undefined) => void;
  tAI: ReturnType<typeof useTranslations<"ai">>;
}) {
  const status = statusForIngredient(ingredient);
  const resolved = resolvedItemId(ingredient, choice);

  // All valid catalogue picks for this ingredient: top match plus
  // the backend-returned alternatives, deduped. Sorted by descending
  // confidence so the dropdown's first entry is always the strongest
  // candidate the backend found.
  const options = useMemo(() => {
    const seen = new Set<string>();
    const entries: {
      item_id: string;
      item_name: string;
      internal_code: string;
      confidence: number;
    }[] = [];
    if (ingredient.matched_item_id) {
      entries.push({
        item_id: ingredient.matched_item_id,
        item_name: ingredient.matched_item_name,
        internal_code: ingredient.matched_item_internal_code,
        confidence: ingredient.confidence,
      });
      seen.add(ingredient.matched_item_id);
    }
    for (const alt of ingredient.alternatives) {
      if (seen.has(alt.item_id)) continue;
      entries.push(alt);
      seen.add(alt.item_id);
    }
    return entries;
  }, [
    ingredient.alternatives,
    ingredient.confidence,
    ingredient.matched_item_id,
    ingredient.matched_item_internal_code,
    ingredient.matched_item_name,
  ]);

  const toneClass =
    status === "auto"
      ? "border-emerald-300 bg-emerald-50 text-emerald-800"
      : status === "review"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-ink-200 bg-ink-50 text-ink-600";

  const statusLabel =
    status === "auto"
      ? tAI("ingredients.matched_label")
      : status === "review"
        ? tAI("ingredients.review_needed_label")
        : tAI("ingredients.unmatched_label");

  const Icon = status === "auto"
    ? Check
    : status === "review"
      ? TriangleAlert
      : CircleOff;

  // The select's value encodes three distinct states so the
  // <option> list can describe them unambiguously:
  //   ""       — default (auto uses top match; review/unmatched = no pick yet)
  //   "__skip" — explicit opt-out
  //   "<uuid>" — concrete item pick
  const SKIP_VALUE = "__skip";
  const selectValue =
    choice?.selectedItemId === null
      ? SKIP_VALUE
      : choice?.selectedItemId ?? "";

  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border p-3 text-sm ${toneClass}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-ink-0/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
          <Icon className="h-3 w-3" />
          {statusLabel}
        </span>
        <span className="font-medium">{ingredient.name}</span>
        {ingredient.label_claim_mg > 0 ? (
          <span className="text-xs font-medium">
            · {formatMg(ingredient.label_claim_mg)} mg
          </span>
        ) : null}
        {status === "auto" && ingredient.mg_per_serving ? (
          <span className="ml-auto text-[11px] text-emerald-700">
            ≈ {formatMg(Number(ingredient.mg_per_serving))} mg raw powder
          </span>
        ) : null}
      </div>
      {status === "unmatched" ? (
        <p className="text-xs">{tAI("ingredients.no_match")}</p>
      ) : (
        <select
          value={selectValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value === SKIP_VALUE) return onSelect(null);
            if (value === "") return onSelect(undefined);
            onSelect(value);
          }}
          className="w-full cursor-pointer rounded-md bg-ink-0 px-2 py-1.5 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        >
          {status === "review" ? (
            <option value="">{tAI("ingredients.pick_placeholder")}</option>
          ) : null}
          {options.map((opt) => (
            <option key={opt.item_id} value={opt.item_id}>
              {opt.item_name}
              {opt.internal_code ? ` (${opt.internal_code})` : ""}
              {" · "}
              {(opt.confidence * 100).toFixed(0)}%
            </option>
          ))}
          <option value={SKIP_VALUE}>{tAI("ingredients.unlink")}</option>
        </select>
      )}
      {status === "auto" && resolved === ingredient.matched_item_id ? (
        <p className="text-[11px] text-emerald-700/80">
          {ingredient.matched_item_name}
          {ingredient.matched_item_internal_code
            ? ` (${ingredient.matched_item_internal_code})`
            : ""}
        </p>
      ) : null}
    </li>
  );
}
