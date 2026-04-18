"use client";

import { Button, Modal } from "@heroui/react";
import {
  FlaskConical,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

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
  type DosageForm,
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

  const reset = () => {
    setBrief("");
    setProvider("ollama");
    setIngredients([]);
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
    } catch (err) {
      setDraftError(extractDraftError(err, tAI, tErrors));
    }
  };

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

  const isBusy = createMutation.isPending;
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
                {/* Ingredient suggestions — read-only for V1.        */}
                {/* AI3 will link these to real catalogue items.      */}
                {/* ------------------------------------------------- */}
                {ingredients.length > 0 ? (
                  <section className="flex flex-col gap-2 border-t border-ink-100 pt-4">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-ink-700">
                      <FlaskConical className="h-3.5 w-3.5 text-ink-500" />
                      {tAI("ingredients.heading", {
                        count: ingredients.length,
                      })}
                    </div>
                    <p className="text-xs text-ink-500">
                      {tAI("ingredients.hint")}
                    </p>
                    <ul className="flex flex-wrap gap-1.5">
                      {ingredients.map((ingredient, idx) => (
                        <li key={`${ingredient.name}-${idx}`}>
                          <Chip tone="orange">
                            {ingredient.name}
                            {ingredient.label_claim_mg > 0 ? (
                              <span className="ml-1 font-medium">
                                · {formatMg(ingredient.label_claim_mg)} mg
                              </span>
                            ) : null}
                          </Chip>
                        </li>
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
