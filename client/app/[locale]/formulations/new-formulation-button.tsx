"use client";

import { Button, Modal } from "@heroui/react";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { translateCode } from "@/lib/errors/translate";
import {
  useCreateFormulation,
  type DosageForm,
} from "@/services/formulations";

interface ApiFieldErrors {
  fieldErrors?: Record<string, unknown>;
}

export function NewFormulationButton({ orgId }: { orgId: string }) {
  const tFormulations = useTranslations("formulations");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [dosageForm, setDosageForm] = useState<DosageForm>("capsule");
  const [servingsPerPack, setServingsPerPack] = useState(60);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateFormulation(orgId);

  const reset = () => {
    setName("");
    setCode("");
    setDosageForm("capsule");
    setServingsPerPack(60);
    setError(null);
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const created = await createMutation.mutateAsync({
        name: name.trim(),
        code: code.trim(),
        dosage_form: dosageForm,
        servings_per_pack: servingsPerPack,
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
              <Modal.Body className="flex flex-col gap-5 px-6 py-6">
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
                      {(
                        [
                          "capsule",
                          "tablet",
                          "powder",
                          "gummy",
                          "liquid",
                          "other_solid",
                        ] as const
                      ).map((f) => (
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
