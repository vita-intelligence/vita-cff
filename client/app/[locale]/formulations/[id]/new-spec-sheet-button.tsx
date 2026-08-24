"use client";

import { Button, Modal } from "@heroui/react";
import { FileText, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Link, useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  useCreateSpecification,
  type SpecificationDocumentKind,
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
  documentKind = "draft",
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
  //: What kind of spec sheet to create. Default ``draft`` matches
  //: the spec-sheets tab's default surface. Set to ``final`` from
  //: the trial-batch banner so the button creates the FINAL,
  //: customer-facing spec once the customer has confirmed done.
  //: The button copy + gate logic switch accordingly — the draft
  //: gate becomes a final gate (one FINAL per project, mirroring
  //: the BE rule).
  documentKind?: SpecificationDocumentKind;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const isFinal = documentKind === "final";

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

  // Only relevant when documentKind === "final". BE enforces one
  // FINAL per project (``FinalSpecAlreadyExists``); we mirror that
  // by disabling the trigger and pointing to the existing sheet.
  const existingFinal = useMemo(
    () => existingSheets.find((sheet) => sheet.document_kind === "final"),
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
        document_kind: documentKind,
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

  // FINAL variant: one FINAL per project (BE-enforced). When one
  // exists, link out instead of showing the create trigger.
  if (isFinal && existingFinal) {
    return (
      <Link
        href={`/specifications/${existingFinal.id}`}
        title="A final specification already exists for this project"
        className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
      >
        <ShieldCheck className="h-4 w-4 text-emerald-600" />
        Open final specification
      </Link>
    );
  }

  // DRAFT variant: one-live-draft-per-project gate. When the project
  // already has a regeneratable draft, disable the trigger and point
  // the operator at the existing sheet — regenerating there
  // preserves the commercial fields the scientist has already typed.
  if (!isFinal && liveDraft) {
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
          className={
            "inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-ink-0 " +
            (isFinal
              ? "bg-emerald-600 hover:bg-emerald-700"
              : "bg-orange-500 hover:bg-orange-600")
          }
        >
          {isFinal ? (
            <ShieldCheck className="h-4 w-4" />
          ) : (
            <FileText className="h-4 w-4" />
          )}
          {isFinal ? "Create final specification" : tSpecs("new_sheet")}
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
              <Modal.Header className="flex items-center justify-between gap-3 border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {isFinal
                    ? "Create final specification sheet"
                    : tSpecs("create.title")}
                </Modal.Heading>
                {/* Explicit badge so the scientist can't mistake this
                    modal for the ordinary draft-create flow. Green
                    tone matches the banner it opens from. */}
                <span
                  className={
                    "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 " +
                    (isFinal
                      ? "bg-emerald-500/10 text-emerald-800 ring-emerald-500/30"
                      : "bg-ink-100 text-ink-700 ring-ink-200")
                  }
                >
                  {isFinal ? (
                    <>
                      <ShieldCheck className="h-3 w-3" /> Final
                    </>
                  ) : (
                    "Draft"
                  )}
                </span>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                {isFinal ? (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-50/70 p-3 text-xs text-emerald-950">
                    <p className="font-semibold">
                      This is the customer-facing final specification.
                    </p>
                    <p className="mt-1">
                      Pin the recipe version the customer approved. Once
                      created, the customer will be asked to sign it —
                      that signature authorises full production.
                    </p>
                  </div>
                ) : (
                  <p className="text-sm text-ink-500">
                    {tSpecs("create.subtitle")}
                  </p>
                )}

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
                  className={
                    "h-10 rounded-lg px-4 text-sm font-medium text-ink-0 " +
                    (isFinal
                      ? "bg-emerald-600 hover:bg-emerald-700"
                      : "bg-orange-500 hover:bg-orange-600")
                  }
                  isDisabled={isBusy || !versionId}
                >
                  {isFinal
                    ? "Create final spec"
                    : tSpecs("create.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
