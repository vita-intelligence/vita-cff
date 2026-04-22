"use client";

/**
 * Modal wrapper around :component:`SignaturePad` that any status-
 * transition flow can reuse.
 *
 * The dialog drives a minimal three-state handshake: open → user
 * draws → user confirms or cancels. ``onConfirm`` receives the
 * captured data URL and is responsible for the actual API call +
 * follow-up navigation; this component only handles the capture
 * UX and disables the confirm button until something has been
 * drawn, so parents never have to re-check "is it empty".
 */

import { Button, Modal } from "@heroui/react";
import { useRef, useState } from "react";

import {
  SignaturePad,
  type SignaturePadHandle,
} from "./signature-pad";


interface Props {
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly subtitle?: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly busy?: boolean;
  readonly errorMessage?: string | null;
  readonly padLabel?: string;
  readonly onConfirm: (dataUrl: string) => Promise<void> | void;
}


export function SignatureDialog({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  confirmLabel,
  cancelLabel = "Cancel",
  busy = false,
  errorMessage = null,
  padLabel,
  onConfirm,
}: Props) {
  const padRef = useRef<SignaturePadHandle | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!dataUrl) return;
    await onConfirm(dataUrl);
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (!open) {
          padRef.current?.clear();
          setDataUrl(null);
        }
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {title}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 px-6 py-6">
              {subtitle ? (
                <p className="text-sm text-ink-500">{subtitle}</p>
              ) : null}
              {isOpen ? (
                <SignaturePad
                  ref={padRef}
                  onChange={setDataUrl}
                  ariaLabel={padLabel}
                  disabled={busy}
                />
              ) : null}
              {errorMessage ? (
                <p
                  role="alert"
                  className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {errorMessage}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="rounded-lg px-4 py-2 font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={() => onOpenChange(false)}
                isDisabled={busy}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="rounded-lg bg-orange-500 px-4 py-2 font-medium text-ink-0 hover:bg-orange-600 disabled:opacity-40"
                onClick={handleConfirm}
                isDisabled={busy || !dataUrl}
              >
                {confirmLabel}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
