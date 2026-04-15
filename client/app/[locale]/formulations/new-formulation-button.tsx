"use client";

import { Button, Modal } from "@heroui/react";
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
          className="rounded-none font-bold tracking-wider uppercase"
        >
          {tFormulations("new_formulation")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="border-2 border-ink-1000 bg-ink-0 p-0">
            <form onSubmit={handleSubmit}>
              <Modal.Header className="flex items-center justify-between border-b-2 border-ink-1000 px-6 py-4">
                <Modal.Heading className="font-mono text-xs tracking-widest uppercase text-ink-700">
                  {tFormulations("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-5 px-6 py-6">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tFormulations("fields.name")}
                  </span>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={tFormulations("placeholders.name")}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tFormulations("fields.code")}
                  </span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={tFormulations("placeholders.code")}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                      {tFormulations("fields.dosage_form")}
                    </span>
                    <select
                      value={dosageForm}
                      onChange={(e) =>
                        setDosageForm(e.target.value as DosageForm)
                      }
                      className="w-full cursor-pointer border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
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
                    <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                      {tFormulations("fields.servings_per_pack")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      value={servingsPerPack}
                      onChange={(e) =>
                        setServingsPerPack(Number(e.target.value))
                      }
                      className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                    />
                  </label>
                </div>

                {error ? (
                  <p
                    role="alert"
                    className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
                  >
                    {error}
                  </p>
                ) : null}
              </Modal.Body>
              <Modal.Footer className="flex items-center justify-end gap-3 border-t-2 border-ink-1000 px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  className="rounded-none border-2 font-bold tracking-wider uppercase"
                  onClick={close}
                  isDisabled={isBusy}
                >
                  {tFormulations("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-none font-bold tracking-wider uppercase"
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
