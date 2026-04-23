"use client";

import { Button, Modal } from "@heroui/react";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import { CustomerPicker } from "@/components/customers/customer-picker";
import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useCreateSpecification } from "@/services/specifications";
import type { CustomerDto } from "@/services/customers";
import type { FormulationVersionDto } from "@/services/formulations";

import { CustomerFormModal } from "../../customers/customers-list";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";
const LABEL_CLASS = "text-xs font-medium text-ink-700";
const HINT_CLASS = "text-xs text-ink-500";


/**
 * "Generate specification sheet" trigger shown on the formulation
 * detail page. Opens a modal that asks which saved version to lock
 * the sheet against plus the client context, then redirects to the
 * newly-created sheet's detail page so the scientist lands on the
 * rendered output they just produced.
 */
export function NewSpecSheetButton({
  orgId,
  projectCode,
  versions,
}: {
  orgId: string;
  //: The project's own ``code`` — auto-seeded into the spec's code
  //: field on open so scientists aren't forced to re-type the same
  //: reference. They can still override before submitting; only the
  //: initial value is borrowed.
  projectCode: string;
  versions: readonly FormulationVersionDto[];
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [versionId, setVersionId] = useState<string>(versions[0]?.id ?? "");
  const [code, setCode] = useState(projectCode ?? "");
  //: When a customer is picked from the address book, ``customer``
  //: holds the full record and its ``name`` / ``email`` / ``company``
  //: flow straight into the POST payload. When no picker match
  //: exists (truly-new client), ``customerCreating`` opens the
  //: customer create modal so they become addressable for future
  //: proposals / sheets too.
  const [customer, setCustomer] = useState<CustomerDto | null>(null);
  const [customerCreating, setCustomerCreating] = useState(false);
  const [coverNotes, setCoverNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateSpecification(orgId);

  // ``versions`` arrives async from TanStack Query, so the initial
  // state above captures ``""`` on first render and the submit button
  // stays disabled until the user re-picks a version. Sync whenever
  // the selected id is not in the current list (empty or stale).
  useEffect(() => {
    if (versions.length === 0) return;
    const stillValid = versions.some((v) => v.id === versionId);
    if (!stillValid) {
      setVersionId(versions[0]!.id);
    }
  }, [versions, versionId]);

  const reset = () => {
    setVersionId(versions[0]?.id ?? "");
    setCode(projectCode ?? "");
    setCustomer(null);
    setCoverNotes("");
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
        // Seeded from the picked customer; empty strings when no
        // customer is selected yet (the scientist can still fill
        // them in via Edit details after the sheet exists, matching
        // how the proposal create flow treats a nameless draft).
        client_name: customer?.name ?? "",
        client_email: customer?.email ?? "",
        client_company: customer?.company ?? "",
        cover_notes: coverNotes.trim(),
      });
      close();
      router.push(`/specifications/${created.id}`);
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const isBusy = createMutation.isPending;

  if (versions.length === 0) {
    return (
      <Button
        type="button"
        variant="outline"
        size="md"
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-500 ring-1 ring-inset ring-ink-200"
        isDisabled
      >
        <FileText className="h-4 w-4" />
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
          variant="primary"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <FileText className="h-4 w-4" />
          {tSpecs("new_sheet")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            {/*
              ``display: contents`` hides the <form> element from CSS
              layout so Header/Body/Footer stay as direct flex children
              of the dialog.
            */}
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tSpecs("create.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tSpecs("create.subtitle")}
                </p>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>
                    {tSpecs("create.version")}
                  </span>
                  <select
                    value={versionId}
                    onChange={(e) => setVersionId(e.target.value)}
                    className={`cursor-pointer ${INPUT_CLASS}`}
                  >
                    {versions.map((v) => (
                      <option key={v.id} value={v.id}>
                        v{v.version_number}
                        {v.label ? ` — ${v.label}` : ""}
                      </option>
                    ))}
                  </select>
                  <p className={HINT_CLASS}>
                    {tSpecs("create.version_picker_hint")}
                  </p>
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>{tSpecs("create.code")}</span>
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>

                <CustomerPicker
                  orgId={orgId}
                  value={customer}
                  onChange={setCustomer}
                  onCreateNew={() => setCustomerCreating(true)}
                  label={tSpecs("create.client")}
                  hint={tSpecs("create.client_picker_hint")}
                />

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>
                    {tSpecs("create.cover_notes")}
                  </span>
                  <textarea
                    rows={3}
                    value={coverNotes}
                    onChange={(e) => setCoverNotes(e.target.value)}
                    className={INPUT_CLASS}
                  />
                </label>

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
                  size="md"
                  className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={close}
                  isDisabled={isBusy}
                >
                  {tSpecs("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={isBusy || !versionId}
                >
                  {tSpecs("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      {/* Mount inside the outer Modal so the create-customer dialog
          stacks above the spec dialog instead of dismissing it. On
          create we snap the new customer into the picker so the
          scientist doesn't have to re-find it. Mirrors the proposal
          create flow. */}
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
