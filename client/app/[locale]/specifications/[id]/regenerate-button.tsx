"use client";

import { Button, Modal } from "@heroui/react";
import { Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, type FormEvent } from "react";

import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useFormulationVersions } from "@/services/formulations";
import {
  useRegenerateSpecification,
  type SpecificationSheetDto,
} from "@/services/specifications";


type LockState =
  | { readonly kind: "unlinked" }
  | { readonly kind: "draft"; readonly code: string }
  | { readonly kind: "sent"; readonly code: string }
  | { readonly kind: "signed"; readonly code: string };


/**
 * Derive the regeneration gate state from ``sheet.linked_proposal``.
 * Mirrors the BE ``_proposal_lock_state`` so the FE renders the same
 * verdict without a preflight call. Signed = hard block; sent =
 * confirmation required; draft / unlinked = go ahead.
 */
function deriveLockState(sheet: SpecificationSheetDto): LockState {
  const linked = sheet.linked_proposal;
  if (linked === null) return { kind: "unlinked" };
  const code = linked.code || `#${linked.id.slice(0, 8)}`;
  if (linked.customer_signed_at !== null || linked.status === "accepted") {
    return { kind: "signed", code };
  }
  if (linked.status === "approved" || linked.status === "sent") {
    return { kind: "sent", code };
  }
  return { kind: "draft", code };
}


/**
 * "Regenerate" trigger on the sheet toolbar. Auto-selects the newest
 * named + complete formulation version and fires the mutation on
 * click — scientists don't pick a target, they just want the freshest
 * numbers.
 *
 * When the linked proposal is in ``sent`` state we detour through a
 * confirmation modal so the operator explicitly acknowledges the
 * customer will see a changed document. Signed proposals hard-block
 * the button entirely with a "create amendment instead" tooltip.
 */
export function RegenerateButton({
  orgId,
  sheet,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmedSent, setConfirmedSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lock = useMemo(() => deriveLockState(sheet), [sheet]);

  const { data: versions = [] } = useFormulationVersions(
    orgId,
    sheet.formulation_id,
  );

  // Newest named + complete version strictly newer than the
  // currently pinned one. Regenerate is a forward-only bump —
  // "regenerating" onto an older version would be a rollback, not
  // a refresh, and that's not what the button reads as. Sorted
  // descending so ``[0]`` is the latest candidate.
  const targetVersion = useMemo(() => {
    const candidates = versions
      .filter(
        (v) =>
          !v.is_auto &&
          v.is_complete &&
          v.version_number > sheet.formulation_version_number,
      )
      .sort((a, b) => b.version_number - a.version_number);
    return candidates[0];
  }, [versions, sheet.formulation_version_number]);

  const mutation = useRegenerateSpecification(orgId, sheet.id);

  const runRegenerate = async (force: boolean) => {
    if (!targetVersion) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        formulation_version_id: targetVersion.id,
        force,
      });
      setConfirmOpen(false);
      router.refresh();
    } catch (err) {
      setError(extractApiErrorMessage(err, tErrors));
    }
  };

  const onTriggerClick = () => {
    if (lock.kind === "sent") {
      setConfirmedSent(false);
      setError(null);
      setConfirmOpen(true);
      return;
    }
    void runRegenerate(false);
  };

  // Signed → button visible but disabled with a tooltip that
  // explains the amendment path.
  if (lock.kind === "signed") {
    return (
      <span
        title={tSpecs("regenerate.hint_signed", { code: lock.code })}
        className="inline-flex"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          isDisabled
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-400 ring-1 ring-inset ring-ink-200"
        >
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4" />
            {tSpecs("regenerate.button")}
          </span>
        </Button>
      </span>
    );
  }

  // No newer complete version yet → tooltip explains why the button
  // is dormant. Keeps the surface visible so the operator learns the
  // action exists once they save a new version.
  if (!targetVersion) {
    return (
      <span
        title={tSpecs("regenerate.hint_no_newer", {
          current: sheet.formulation_version_number,
        })}
        className="inline-flex"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          isDisabled
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-400 ring-1 ring-inset ring-ink-200"
        >
          <span className="inline-flex items-center gap-1.5">
            <RefreshCw className="h-4 w-4" />
            {tSpecs("regenerate.button")}
          </span>
        </Button>
      </span>
    );
  }

  const busy = mutation.isPending;

  return (
    <>
      <span
        title={tSpecs("regenerate.tooltip", {
          current: sheet.formulation_version_number,
          target: targetVersion.version_number,
        })}
        className="inline-flex"
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTriggerClick}
          isDisabled={busy}
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-60"
        >
          <span className="inline-flex items-center gap-1.5">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            {tSpecs("regenerate.button_with_target", {
              target: targetVersion.version_number,
            })}
          </span>
        </Button>
      </span>

      {/* Inline error banner (kept out of the modal so the happy path
          — no modal — still surfaces failures next to the trigger).
          Only shows when the mutation errored outside the sent-force
          modal flow. */}
      {error && !confirmOpen ? (
        <span
          role="alert"
          className="rounded-lg bg-danger/10 px-2 py-1 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </span>
      ) : null}

      {/* Only opens when the linked proposal is in ``sent`` state —
          customer has (or is about to) receive the document, so we
          require the operator to confirm before mutating. */}
      {lock.kind === "sent" ? (
        <Modal
          isOpen={confirmOpen}
          onOpenChange={(open) => {
            setConfirmOpen(open);
            if (!open) setError(null);
          }}
        >
          <Modal.Backdrop>
            <Modal.Container size="md">
              <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
                <form
                  onSubmit={(event: FormEvent<HTMLFormElement>) => {
                    event.preventDefault();
                    if (!confirmedSent) return;
                    void runRegenerate(true);
                  }}
                  style={{ display: "contents" }}
                >
                  <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                    <Modal.Heading className="text-base font-semibold text-ink-1000">
                      {tSpecs("regenerate.title")}
                    </Modal.Heading>
                  </Modal.Header>
                  <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                    <p className="text-sm text-ink-500">
                      {tSpecs("regenerate.subtitle_sent", {
                        current: sheet.formulation_version_number,
                        target: targetVersion.version_number,
                      })}
                    </p>

                    <div className="flex flex-col gap-2 rounded-xl bg-amber-50 p-3 ring-1 ring-inset ring-amber-200">
                      <div className="flex items-start gap-2 text-sm text-amber-900">
                        <ShieldAlert className="mt-0.5 h-4 w-4 flex-none" />
                        <span>
                          {tSpecs("regenerate.warn_sent", {
                            code: lock.code,
                          })}
                        </span>
                      </div>
                      <label className="flex items-center gap-2 text-xs font-medium text-amber-950">
                        <input
                          type="checkbox"
                          checked={confirmedSent}
                          onChange={(e) =>
                            setConfirmedSent(e.target.checked)
                          }
                          className="h-4 w-4 rounded border-amber-300"
                        />
                        {tSpecs("regenerate.confirm_sent")}
                      </label>
                    </div>

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
                      className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                      onClick={() => setConfirmOpen(false)}
                      isDisabled={busy}
                    >
                      {tSpecs("create.cancel")}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="md"
                      className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:bg-ink-200 disabled:text-ink-500"
                      isDisabled={busy || !confirmedSent}
                    >
                      {tSpecs("regenerate.submit")}
                    </Button>
                  </Modal.Footer>
                </form>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}
    </>
  );
}
