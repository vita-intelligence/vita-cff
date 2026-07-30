"use client";

import { Button, Modal } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";
const LABEL_CLASS = "text-xs font-medium text-ink-700";


/**
 * Confirmation modal for reject / revert transitions. The BE gate
 * (:class:`MissingTransitionReason`) refuses these moves without a
 * written explanation — the modal captures it and gates its submit
 * button until the operator has typed something non-empty.
 *
 * Reused for four transitions: ``in_review → draft``,
 * ``approved → draft``, ``sent → rejected``, ``rejected → draft``.
 * The parent picks the copy variant via ``variant``.
 */
export function ReasonModal({
  variant,
  isOpen,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  variant: "reject" | "revert";
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const tSpecs = useTranslations("specifications");
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (isOpen) setReason("");
  }, [isOpen]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  const heading =
    variant === "reject"
      ? tSpecs("reason.reject_title")
      : tSpecs("reason.revert_title");
  const subtitle =
    variant === "reject"
      ? tSpecs("reason.reject_subtitle")
      : tSpecs("reason.revert_subtitle");
  const submitLabel =
    variant === "reject"
      ? tSpecs("reason.reject_submit")
      : tSpecs("reason.revert_submit");

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {heading}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">{subtitle}</p>

                <label className="flex flex-col gap-1.5">
                  <span className={LABEL_CLASS}>
                    {tSpecs("reason.label")}
                  </span>
                  <textarea
                    rows={4}
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={tSpecs("reason.placeholder")}
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
                  className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                  onClick={onClose}
                  isDisabled={busy}
                >
                  {tSpecs("create.cancel")}
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:bg-ink-200 disabled:text-ink-500"
                  isDisabled={busy || !reason.trim()}
                >
                  {submitLabel}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
