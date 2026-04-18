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
import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useGenerateFormulationDraft,
  type AIProviderSlug,
  type IngredientSuggestionDto,
} from "@/services/ai";
import {
  useCreateFormulation,
  useReplaceLines,
  type DosageForm,
  type FormulationLineInput,
} from "@/services/formulations";


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


export function NewFormulationButton({ orgId }: { orgId: string }) {
  const tFormulations = useTranslations("formulations");
  const tAI = useTranslations("ai");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);

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

  // Form state
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [dosageForm, setDosageForm] = useState<DosageForm>("capsule");
  const [servingsPerPack, setServingsPerPack] = useState(60);
  const [servingSize, setServingSize] = useState(1);
  const [directionsOfUse, setDirectionsOfUse] = useState("");
  const [suggestedDosage, setSuggestedDosage] = useState("");
  const [appearance, setAppearance] = useState("");
  const [disintegrationSpec, setDisintegrationSpec] = useState("");
  const [error, setError] = useState<string | null>(null);

  const draftMutation = useGenerateFormulationDraft(orgId);
  const createMutation = useCreateFormulation(orgId);
  // ``createdId`` is scoped to the single modal session so the
  // ``useReplaceLines`` hook never outlives the modal.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const replaceLinesMutation = useReplaceLines(
    orgId,
    createdId ?? "",
  );

  const reset = () => {
    setBrief("");
    setProvider("ollama");
    setIngredients([]);
    setChoices({});
    setDraftError(null);
    setName("");
    setCode("");
    setDescription("");
    setDosageForm("capsule");
    setServingsPerPack(60);
    setServingSize(1);
    setDirectionsOfUse("");
    setSuggestedDosage("");
    setAppearance("");
    setDisintegrationSpec("");
    setError(null);
    setCreatedId(null);
  };

  const close = () => {
    setIsOpen(false);
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
      setCode(draft.code);
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
      });

      // Attach the matched ingredients as formulation lines in a
      // second call. A failure here isn't fatal — the header is
      // already persisted, so we navigate onward and surface a
      // soft warning so the scientist knows to add the lines
      // manually from the builder.
      if (linesToSave.length > 0) {
        setCreatedId(created.id);
        try {
          await replaceLinesMutation.mutateAsync({ lines: linesToSave });
        } catch {
          setError(tAI("create.lines_failed"));
          // Drop back before navigating so the user can see the
          // soft warning rather than blow past it.
          setCreatedId(null);
          return;
        }
      }

      close();
      router.push(`/formulations/${created.id}`);
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

  const isBusy = createMutation.isPending || replaceLinesMutation.isPending;
  const isGenerating = draftMutation.isPending;

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => (open ? setIsOpen(true) : close())}>
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
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tFormulations("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex max-h-[75vh] flex-col gap-5 overflow-y-auto px-6 py-6">
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
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tFormulations("fields.name")}
                  </span>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={tFormulations("placeholders.name")}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-ink-700">
                    {tFormulations("fields.code")}
                  </span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={tFormulations("placeholders.code")}
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                  />
                </label>

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
                  isDisabled={isBusy || !name.trim()}
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
