"use client";

import { Button, Modal } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useEffect, useState, type FormEvent } from "react";

import type { SpecificationSheetDto } from "@/services/specifications";


const INPUT_CLASS =
  "w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400";
const LABEL_CLASS = "text-xs font-medium text-ink-700";
const HINT_CLASS = "text-xs text-ink-500";


type DeliveryMethod = "public_link" | "email" | "other";


/**
 * Send-to-customer confirmation modal.
 *
 * Captures the two evidence fields the BE requires to release the
 * sheet into the ``sent`` state:
 *
 * * ``delivery_method`` — how did the customer receive the sheet?
 *   The three-way radio keeps the vocabulary controlled so the audit
 *   query "how did we send this?" is aggregable.
 * * ``delivery_recipient`` — where / to whom did we send it? For
 *   ``email`` this is the email address; for ``public_link`` we
 *   auto-fill with the sheet's public preview URL when one exists;
 *   for ``other`` it's a free-text note (courier, in-person, etc.).
 *
 * The parent handles the mutation call so this component doesn't
 * need to know about the specifications hooks — it just yields
 * the two validated fields back on confirm.
 */
export function SendModal({
  isOpen,
  onClose,
  onConfirm,
  sheet,
  busy,
  error,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (payload: {
    delivery_method: DeliveryMethod;
    delivery_recipient: string;
  }) => void;
  sheet: SpecificationSheetDto;
  busy: boolean;
  error: string | null;
}) {
  const tSpecs = useTranslations("specifications");

  const [method, setMethod] = useState<DeliveryMethod>("public_link");
  const [emailRecipient, setEmailRecipient] = useState("");
  const [otherNote, setOtherNote] = useState("");

  // Public preview URL — synthesised from the sheet's public token so
  // an operator sending the auto-link doesn't have to hunt for it in
  // another tab. Empty when the token isn't set yet (the send flow
  // itself later triggers token rotation on the FE, but that logic
  // stays in the share panel; here we just use whatever's stored).
  const publicUrl = sheet.public_token
    ? `${typeof window !== "undefined" ? window.location.origin : ""}/public/specifications/${sheet.public_token}`
    : "";

  useEffect(() => {
    if (!isOpen) return;
    setMethod("public_link");
    setEmailRecipient(sheet.client_email ?? "");
    setOtherNote("");
  }, [isOpen, sheet.client_email]);

  const effectiveRecipient =
    method === "public_link"
      ? publicUrl
      : method === "email"
        ? emailRecipient.trim()
        : otherNote.trim();

  const canSubmit = !busy && effectiveRecipient.length > 0;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    onConfirm({
      delivery_method: method,
      delivery_recipient: effectiveRecipient,
    });
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <form onSubmit={handleSubmit} style={{ display: "contents" }}>
              <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                <Modal.Heading className="text-base font-semibold text-ink-1000">
                  {tSpecs("send.title")}
                </Modal.Heading>
              </Modal.Header>
              <Modal.Body className="flex flex-col gap-4 px-6 py-6">
                <p className="text-sm text-ink-500">
                  {tSpecs("send.subtitle")}
                </p>

                <fieldset className="flex flex-col gap-2">
                  <legend className={LABEL_CLASS}>
                    {tSpecs("send.method_label")}
                  </legend>
                  <MethodOption
                    value="public_link"
                    checked={method === "public_link"}
                    onSelect={setMethod}
                    label={tSpecs("send.method_public_link")}
                    description={tSpecs("send.method_public_link_hint")}
                  />
                  <MethodOption
                    value="email"
                    checked={method === "email"}
                    onSelect={setMethod}
                    label={tSpecs("send.method_email")}
                    description={tSpecs("send.method_email_hint")}
                  />
                  <MethodOption
                    value="other"
                    checked={method === "other"}
                    onSelect={setMethod}
                    label={tSpecs("send.method_other")}
                    description={tSpecs("send.method_other_hint")}
                  />
                </fieldset>

                {method === "public_link" ? (
                  <div className="flex flex-col gap-1.5">
                    <span className={LABEL_CLASS}>
                      {tSpecs("send.recipient_public_link")}
                    </span>
                    <input
                      type="text"
                      readOnly
                      value={publicUrl}
                      placeholder={tSpecs(
                        "send.recipient_public_link_missing",
                      )}
                      className={`${INPUT_CLASS} bg-ink-50 text-ink-600`}
                    />
                    <p className={HINT_CLASS}>
                      {publicUrl
                        ? tSpecs("send.recipient_public_link_hint")
                        : tSpecs("send.recipient_public_link_missing_hint")}
                    </p>
                  </div>
                ) : null}

                {method === "email" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className={LABEL_CLASS}>
                      {tSpecs("send.recipient_email")}
                    </span>
                    <input
                      type="email"
                      autoFocus
                      value={emailRecipient}
                      onChange={(e) => setEmailRecipient(e.target.value)}
                      placeholder="client@example.com"
                      className={INPUT_CLASS}
                    />
                    <p className={HINT_CLASS}>
                      {tSpecs("send.recipient_email_hint")}
                    </p>
                  </label>
                ) : null}

                {method === "other" ? (
                  <label className="flex flex-col gap-1.5">
                    <span className={LABEL_CLASS}>
                      {tSpecs("send.recipient_other")}
                    </span>
                    <input
                      type="text"
                      autoFocus
                      value={otherNote}
                      onChange={(e) => setOtherNote(e.target.value)}
                      placeholder={tSpecs("send.recipient_other_placeholder")}
                      className={INPUT_CLASS}
                    />
                    <p className={HINT_CLASS}>
                      {tSpecs("send.recipient_other_hint")}
                    </p>
                  </label>
                ) : null}

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
                  isDisabled={!canSubmit}
                >
                  {tSpecs("send.submit")}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function MethodOption({
  value,
  checked,
  onSelect,
  label,
  description,
}: {
  value: DeliveryMethod;
  checked: boolean;
  onSelect: (v: DeliveryMethod) => void;
  label: string;
  description: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
        checked
          ? "border-orange-400 bg-orange-50 ring-1 ring-inset ring-orange-200"
          : "border-ink-200 hover:bg-ink-50"
      }`}
    >
      <input
        type="radio"
        name="delivery-method"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-0.5 h-4 w-4"
      />
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink-1000">{label}</span>
        <span className="text-xs text-ink-500">{description}</span>
      </div>
    </label>
  );
}
