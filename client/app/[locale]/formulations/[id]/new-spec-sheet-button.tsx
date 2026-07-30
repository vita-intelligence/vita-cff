"use client";

import { Button, Modal } from "@heroui/react";
import { FileText } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useCreateSpecification,
  type SpecificationSheetDto,
} from "@/services/specifications";
import type { FormulationVersionDto } from "@/services/formulations";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";
const LABEL_CLASS = "text-xs font-medium text-ink-700";
const HINT_CLASS = "text-xs text-ink-500";


/**
 * "Generate specification sheet" trigger shown on the formulation
 * detail page. Opens a modal that asks which saved version to lock
 * the sheet against, then redirects to the newly-created sheet's
 * detail page so the scientist lands on the rendered output they
 * just produced.
 *
 * Client attribution isn't collected here — a fresh sheet is a
 * trial artefact by default. The FINAL sheet (auto-created after
 * trial sign-off) is the one that ends up bound to a customer.
 */
export function NewSpecSheetButton({
  orgId,
  projectCode,
  versions,
  existingSheets = [],
}: {
  orgId: string;
  //: The project's own ``code`` — auto-seeded into the spec's code
  //: field on open so scientists aren't forced to re-type the same
  //: reference. They can still override before submitting; only the
  //: initial value is borrowed.
  projectCode: string;
  versions: readonly FormulationVersionDto[];
  //: Current sheets on the project. The BE enforces "one live draft
  //: per formulation" — when a regeneratable draft already exists,
  //: the button disables itself with a tooltip that points the
  //: scientist at the existing sheet's Regenerate action. A sheet
  //: locked by a signed proposal doesn't count against the quota
  //: (it's an audit artefact, not a live draft), so a fresh draft
  //: can co-exist alongside a signed one.
  existingSheets?: readonly SpecificationSheetDto[];
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const liveDraft = useMemo(
    () =>
      existingSheets.find((sheet) => {
        if (sheet.document_kind !== "draft") return false;
        const linked = sheet.linked_proposal;
        if (linked === null) return true;
        const signed =
          linked.customer_signed_at !== null || linked.status === "accepted";
        return !signed;
      }),
    [existingSheets],
  );

  // Only named ``Save version`` commits that passed the builder-
  // readiness gate at save time show up in the dropdown. Auto-drafts
  // (fired on every Save draft) are internal restore points — they
  // shouldn't be quotable. Mid-edit named saves (is_complete=false)
  // are hidden too, so a director can't sign a sheet against a
  // broken snapshot. Freshly-migrated existing rows carry
  // ``is_complete=true`` for is_auto=false via the 0062 backfill.
  const eligibleVersions = useMemo(
    () => versions.filter((v) => !v.is_auto && v.is_complete),
    [versions],
  );

  const [isOpen, setIsOpen] = useState(false);
  const [versionId, setVersionId] = useState<string>(
    eligibleVersions[0]?.id ?? "",
  );
  const [code, setCode] = useState(projectCode ?? "");
  const [coverNotes, setCoverNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateSpecification(orgId);

  // ``versions`` arrives async from TanStack Query, so the initial
  // state above captures ``""`` on first render and the submit button
  // stays disabled until the user re-picks a version. Sync whenever
  // the selected id is not in the current list (empty or stale).
  useEffect(() => {
    if (eligibleVersions.length === 0) return;
    const stillValid = eligibleVersions.some((v) => v.id === versionId);
    if (!stillValid) {
      setVersionId(eligibleVersions[0]!.id);
    }
  }, [eligibleVersions, versionId]);

  const reset = () => {
    setVersionId(eligibleVersions[0]?.id ?? "");
    setCode(projectCode ?? "");
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
        cover_notes: coverNotes.trim(),
      });
      close();
      router.push(`/specifications/${created.id}`);
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  const isBusy = createMutation.isPending;

  // Disable the trigger when there's no eligible version to lock the
  // sheet against. Covers both "no versions at all" and "all versions
  // are auto-drafts or mid-edit named saves" — the scientist has to
  // click Save version with a clean checklist first.
  if (eligibleVersions.length === 0) {
    return (
      <span title="Click Save version with a clean readiness checklist to enable this.">
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
      </span>
    );
  }

  // One-live-draft-per-project gate. When the project already has a
  // regeneratable draft, disable the trigger and point the operator
  // at the existing sheet — regenerating there preserves the
  // commercial fields the scientist has already typed.
  if (liveDraft) {
    const tooltip = tSpecs("new_sheet_live_draft_exists", {
      code: liveDraft.code || `#${liveDraft.id.slice(0, 8)}`,
    });
    return (
      <Link
        href={`/specifications/${liveDraft.id}`}
        title={tooltip}
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-500 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
      >
        <FileText className="h-4 w-4" />
        {tSpecs("new_sheet_open_existing")}
      </Link>
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
                    {eligibleVersions.map((v) => (
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
    </Modal>
  );
}
