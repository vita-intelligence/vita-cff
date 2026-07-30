"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, Modal } from "@heroui/react";
import { AlertTriangle, Building2, Paperclip } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import {
  proposalsQueryKeys,
  useCreateProposalBundle,
} from "@/services/proposals";
import { specificationsQueryKeys } from "@/services/specifications";
import { type SpecificationSheetDto } from "@/services/specifications";


/**
 * Modal for the /signed page's bulk-select flow: pick N approved
 * sheets, get ONE proposal with a line per sheet. Quantity is
 * captured per row (defaults to 1); deposit % is proposal-wide
 * (defaults to 50, matches the single-spec modal).
 *
 * Customer identity comes from the first sheet's ``linked_customer``
 * (the /signed picker guarantees every selection carries the same
 * one — the backend re-verifies).
 */
export function BulkCreateProposalModal({
  orgId,
  sheets,
  isOpen,
  onClose,
}: {
  orgId: string;
  sheets: readonly SpecificationSheetDto[];
  isOpen: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("signed");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const queryClient = useQueryClient();

  const linkedCustomer = sheets[0]?.linked_customer ?? null;

  //: Per-row quantity, keyed by sheet id. Kept as strings so an empty
  //: intermediate state ("user cleared the field to retype") doesn't
  //: force us into an aggressive default. Coerced to ``max(1, int)``
  //: on submit.
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [deposit, setDeposit] = useState<string>("50");
  const [error, setError] = useState<string | null>(null);

  const createMutation = useCreateProposalBundle(orgId);

  //: Seed / re-seed quantities every time the sheet set changes. A
  //: sheet dropped from the selection between modal opens shouldn't
  //: leak its previous quantity when it's re-added.
  useEffect(() => {
    if (!isOpen) return;
    setQuantities((prev) => {
      const next: Record<string, string> = {};
      for (const s of sheets) {
        next[s.id] = prev[s.id] ?? "1";
      }
      return next;
    });
    setError(null);
  }, [isOpen, sheets]);

  const reset = () => {
    setQuantities({});
    setDeposit("50");
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const customerLabel = useMemo(() => {
    if (!linkedCustomer) return null;
    return (
      linkedCustomer.company ||
      linkedCustomer.name ||
      linkedCustomer.email ||
      null
    );
  }, [linkedCustomer]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (sheets.length === 0) return;

    //: Deposit gate mirrors the single-spec modal — 0..100, empty
    //: → server default (50).
    let depositPayload: string | null = null;
    const depositTrim = deposit.trim();
    if (depositTrim) {
      const depositNum = Number.parseFloat(depositTrim);
      if (
        !Number.isFinite(depositNum) ||
        depositNum < 0 ||
        depositNum > 100
      ) {
        setError(t("bulk_create_proposal.errors.generic"));
        return;
      }
      depositPayload = depositTrim;
    }

    const payload = {
      sheets: sheets.map((s) => ({
        sheet_id: s.id,
        quantity: Math.max(1, Number.parseInt(quantities[s.id] ?? "1", 10) || 1),
      })),
      ...(depositPayload !== null ? { deposit_percent: depositPayload } : {}),
    };

    try {
      const created = await createMutation.mutateAsync(payload);
      queryClient.invalidateQueries({
        queryKey: specificationsQueryKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposalsQueryKeys.all,
      });
      close();
      router.push(`/proposals/${created.id}`);
    } catch (err) {
      //: Map the two custom BE codes to human-friendly messages —
      //: everything else (400 field errors, network) falls through to
      //: the generic translator.
      const code = extractBundleCode(err);
      if (code === "bundle_mixed_customers") {
        setError(t("bulk_create_proposal.errors.mixed_customers"));
      } else if (code === "bundle_requires_linked_customer") {
        setError(t("bulk_create_proposal.errors.requires_customer"));
      } else {
        setError(extractApiErrorMessage(err, tErrors));
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => (!open ? close() : undefined)}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {t("bulk_create_proposal.title", { count: sheets.length })}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {t("bulk_create_proposal.subtitle")}
                </p>

                {customerLabel ? (
                  <div className="flex items-start gap-2 rounded-xl bg-sky-50 px-3 py-2 text-xs text-sky-950 ring-1 ring-inset ring-sky-200">
                    <Building2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-700" />
                    <div className="flex min-w-0 flex-col">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-sky-800">
                        {t("bulk_create_proposal.customer_chip")}
                      </span>
                      <span className="font-semibold tracking-tight text-ink-1000">
                        {customerLabel}
                      </span>
                    </div>
                  </div>
                ) : null}

                <ul className="flex flex-col gap-2">
                  {sheets.map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center gap-3 rounded-xl bg-ink-50 px-3 py-2 ring-1 ring-inset ring-ink-200"
                    >
                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-500" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-semibold tracking-tight text-ink-1000">
                          {s.code || s.formulation_name || s.id}
                        </span>
                        <span className="truncate text-[11px] text-ink-500">
                          {s.formulation_name}
                          {" · "}
                          {t("card.version", {
                            version: s.formulation_version_number,
                          })}
                        </span>
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] font-medium text-ink-600">
                        <span>{t("bulk_create_proposal.quantity_label")}</span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={quantities[s.id] ?? "1"}
                          onChange={(e) =>
                            setQuantities((prev) => ({
                              ...prev,
                              [s.id]: e.target.value,
                            }))
                          }
                          className="h-8 w-16 rounded-md bg-ink-0 px-2 text-right text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-orange-500"
                        />
                      </label>
                    </li>
                  ))}
                </ul>

                <label className="flex flex-col gap-1 text-xs font-medium text-ink-600">
                  <span>{t("bulk_create_proposal.deposit_label")}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    className="h-9 w-24 rounded-md bg-ink-0 px-2 text-right text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-orange-500"
                  />
                  <span className="text-[11px] font-normal text-ink-500">
                    {t("bulk_create_proposal.deposit_hint")}
                  </span>
                </label>

                {error ? (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2 text-xs font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{error}</span>
                  </p>
                ) : null}
              </Modal.Body>
              <div className="flex items-center justify-end gap-2 border-t border-ink-200 px-6 py-4">
                <Button
                  type="button"
                  onPress={close}
                  isDisabled={createMutation.isPending}
                  variant="ghost"
                >
                  {t("bulk_create_proposal.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  isDisabled={
                    createMutation.isPending ||
                    sheets.length === 0 ||
                    !linkedCustomer
                  }
                >
                  {createMutation.isPending
                    ? t("bulk_create_proposal.submit_pending")
                    : t("bulk_create_proposal.submit")}
                </Button>
              </div>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


//: Reach into the axios-shaped error payload for the machine-readable
//: ``code`` string the BE writes on 4xx responses. Falls back to
//: ``null`` if the payload doesn't match the expected shape.
function extractBundleCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { response?: { data?: unknown } }).response?.data;
  if (!data || typeof data !== "object") return null;
  const sheets = (data as { sheets?: unknown }).sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) return null;
  const first = sheets[0];
  if (typeof first !== "string") return null;
  return first;
}
