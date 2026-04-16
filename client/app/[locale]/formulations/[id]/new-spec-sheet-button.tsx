"use client";

import { Button, Modal } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useCreateSpecification,
} from "@/services/specifications";
import type { FormulationVersionDto } from "@/services/formulations";


/**
 * "Generate specification sheet" trigger shown on the formulation
 * detail page. Opens a modal that asks which saved version to lock
 * the sheet against plus the client context, then redirects to the
 * newly-created sheet's detail page so the scientist lands on the
 * rendered output they just produced.
 */
export function NewSpecSheetButton({
  orgId,
  versions,
}: {
  orgId: string;
  versions: readonly FormulationVersionDto[];
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [versionId, setVersionId] = useState<string>(
    versions[0]?.id ?? "",
  );
  const [code, setCode] = useState("");
  const [clientName, setClientName] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [clientCompany, setClientCompany] = useState("");
  const [coverNotes, setCoverNotes] = useState("");
  const [totalWeightLabel, setTotalWeightLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateSpecification(orgId);

  const reset = () => {
    setVersionId(versions[0]?.id ?? "");
    setCode("");
    setClientName("");
    setClientEmail("");
    setClientCompany("");
    setCoverNotes("");
    setTotalWeightLabel("");
    setError(null);
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!versionId) return;
    try {
      const created = await createMutation.mutateAsync({
        formulation_version_id: versionId,
        code: code.trim(),
        client_name: clientName.trim(),
        client_email: clientEmail.trim(),
        client_company: clientCompany.trim(),
        cover_notes: coverNotes.trim(),
        total_weight_label: totalWeightLabel.trim(),
      });
      close();
      router.push(`/specifications/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const isBusy = createMutation.isPending;

  // When there are no saved versions yet, render a disabled trigger
  // with a hint rather than a broken modal — the scientist needs to
  // save at least one version before a sheet makes sense.
  if (versions.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        size="md"
        className="rounded-none border-2 font-bold tracking-wider uppercase"
        isDisabled
      >
        {tSpecs("new_sheet")}
      </Button>
    );
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (open ? setIsOpen(true) : close())}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="outline"
          size="md"
          className="rounded-none border-2 font-bold tracking-wider uppercase"
        >
          {tSpecs("new_sheet")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="border-2 border-ink-1000 bg-ink-0 p-0">
            <form onSubmit={handleSubmit}>
              <Modal.Header className="flex items-center justify-between border-b-2 border-ink-1000 px-6 py-4">
                <Modal.Heading className="font-mono text-xs tracking-widest uppercase text-ink-700">
                  {tSpecs("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-5 px-6 py-6">
                <p className="text-sm text-ink-600">
                  {tSpecs("create.subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tSpecs("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    className="w-full cursor-pointer border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number}
                        {v.label ? ` — ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                  <p className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                    {tSpecs("create.version_picker_hint")}
                  </p>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tSpecs("create.code")}
                  </span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

                <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                      {tSpecs("create.client_company")}
                    </span>
                    <input
                      value={clientCompany}
                      onChange={(e) => setClientCompany(e.target.value)}
                      className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                      {tSpecs("create.client_name")}
                    </span>
                    <input
                      value={clientName}
                      onChange={(e) => setClientName(e.target.value)}
                      className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tSpecs("create.client_email")}
                  </span>
                  <input
                    type="email"
                    value={clientEmail}
                    onChange={(e) => setClientEmail(e.target.value)}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tSpecs("create.total_weight_label")}
                  </span>
                  <input
                    value={totalWeightLabel}
                    onChange={(e) => setTotalWeightLabel(e.target.value)}
                    placeholder="TBC"
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                  <p className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                    {tSpecs("create.total_weight_label_hint")}
                  </p>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
                    {tSpecs("create.cover_notes")}
                  </span>
                  <textarea
                    rows={3}
                    value={coverNotes}
                    onChange={(e) => setCoverNotes(e.target.value)}
                    className="w-full border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
                  />
                </label>

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
                  {tSpecs("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-none font-bold tracking-wider uppercase"
                  isDisabled={isBusy || !versionId}
                >
                  {tSpecs("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function extractErrorMessage(
  error: unknown,
  tErrors: ReturnType<typeof useTranslations<"errors">>,
): string {
  if (error instanceof ApiError) {
    for (const codes of Object.values(error.fieldErrors)) {
      if (Array.isArray(codes) && codes.length > 0) {
        return translateCode(tErrors, String(codes[0]));
      }
    }
  }
  return tErrors("generic");
}
