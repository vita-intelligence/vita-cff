"use client";

/**
 * Compose-and-send modal for the "Send to client" CTA on the
 * proposal detail page (status === ``approved``).
 *
 * The modal pre-fills three editable fields:
 *
 *   * **To** — defaults to ``proposal.customer_email``; sales can
 *     override or clear.
 *   * **Subject** — defaults to ``"Your proposal from Vita NPD —
 *     <PROPOSAL_CODE>"``.
 *   * **Body** — a friendly cover-letter template addressing the
 *     ``dear_name`` and pointing to the kiosk URL. The backend
 *     wraps this body in a branded HTML template with an "Open
 *     proposal" button before sending; the plain-text version
 *     mailed alongside is what the sales person typed verbatim.
 *
 * Send is atomic on the backend: the SMTP send + the
 * ``approved → sent`` transition succeed or fail together. If the
 * SMTP layer rejects the message, the proposal stays at
 * ``approved`` and we surface the error inside the modal so the
 * sales person can retry without losing their edits.
 */

import { Button, Modal } from "@heroui/react";
import { CheckCircle2, Send, TestTube2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { ApiError } from "@/lib/api";
import { extractApiErrorMessage } from "@/lib/errors/translate";
import { useCurrentUser } from "@/services/accounts";
import {
  useSendProposalTestEmail,
  useSendProposalToClient,
  type ProposalDto,
} from "@/services/proposals";


interface Props {
  readonly orgId: string;
  readonly proposal: ProposalDto;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSent: () => void;
}


export function SendToClientModal({
  orgId,
  proposal,
  isOpen,
  onOpenChange,
  onSent,
}: Props) {
  const tProposals = useTranslations("proposals");
  const tErrors = useTranslations("errors");

  // Form state seeded from the proposal each time the modal opens.
  // Reseeding on open (not on mount) means a sales person who
  // closes the modal, edits the proposal's customer email in the
  // side panel, then reopens the modal sees the fresh recipient
  // instead of a stale draft.
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testRecipient, setTestRecipient] = useState("");
  const [testStatus, setTestStatus] = useState<
    | { readonly kind: "idle" }
    | { readonly kind: "ok"; readonly recipient: string }
    | { readonly kind: "error"; readonly message: string }
  >({ kind: "idle" });

  // Logged-in user's email seeds the test-send field. ``staleTime: 0``
  // keeps this hook cheap — the cached row from the app shell is
  // reused; we just need the email column.
  const currentUserQuery = useCurrentUser();
  const currentUserEmail = currentUserQuery.data?.email ?? "";

  useEffect(() => {
    if (!isOpen) return;
    setRecipient(proposal.customer_email || "");
    setSubject(
      tProposals("detail.send_to_client.default_subject", {
        code: proposal.code,
      }),
    );
    setBody(
      tProposals("detail.send_to_client.default_body", {
        name:
          proposal.dear_name ||
          proposal.customer_name ||
          tProposals("detail.send_to_client.fallback_greeting"),
        code: proposal.code,
      }),
    );
    setError(null);
    setTestStatus({ kind: "idle" });
    setTestRecipient(currentUserEmail);
  }, [isOpen, proposal, tProposals, currentUserEmail]);

  const mutation = useSendProposalToClient(orgId, proposal.id);
  const testMutation = useSendProposalTestEmail(orgId, proposal.id);

  const recipientValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.trim());
  const canSend =
    recipientValid && subject.trim().length > 0 && body.trim().length > 0;

  const handleSend = async () => {
    if (!canSend || mutation.isPending) return;
    setError(null);
    try {
      await mutation.mutateAsync({
        recipient: recipient.trim(),
        subject: subject.trim(),
        body_text: body,
      });
      onSent();
      onOpenChange(false);
    } catch (err) {
      // Atomic: backend kept the proposal at ``approved`` if SMTP
      // failed, so the user can retry by re-clicking Send without
      // losing their edits. Surface the codified error so the i18n
      // layer renders the right copy.
      if (err instanceof ApiError) {
        setError(extractApiErrorMessage(err, tErrors));
      } else {
        setError(tProposals("detail.send_to_client.error_generic"));
      }
    }
  };

  const testRecipientTrimmed = testRecipient.trim();
  const testRecipientValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    testRecipientTrimmed,
  );

  const handleSendTest = async () => {
    if (testMutation.isPending) return;
    if (!testRecipientValid) {
      setTestStatus({
        kind: "error",
        message: tProposals("detail.send_to_client.invalid_email"),
      });
      return;
    }
    setTestStatus({ kind: "idle" });
    try {
      const result = await testMutation.mutateAsync({
        recipient: testRecipientTrimmed,
        subject: subject.trim(),
        body_text: body,
      });
      // Re-derive the recipient from the server response so we show
      // exactly the address the email landed at (the backend may
      // have substituted the caller's own email if we sent an empty
      // recipient).
      setTestStatus({ kind: "ok", recipient: result.recipient });
    } catch (err) {
      if (err instanceof ApiError) {
        setTestStatus({
          kind: "error",
          message: extractApiErrorMessage(err, tErrors),
        });
      } else {
        setTestStatus({
          kind: "error",
          message: tProposals("detail.send_to_client.error_generic"),
        });
      }
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (mutation.isPending) return;
        onOpenChange(open);
      }}
    >
      <Modal.Backdrop>
        <Modal.Container size="lg">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tProposals("detail.send_to_client.title", {
                  code: proposal.code,
                })}
              </Modal.Heading>
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-4 px-6 py-5">
              <p className="text-xs text-ink-500">
                {tProposals("detail.send_to_client.subtitle")}
              </p>

              <Field
                label={tProposals("detail.send_to_client.to_label")}
                hint={
                  !recipientValid && recipient.length > 0
                    ? tProposals("detail.send_to_client.invalid_email")
                    : undefined
                }
              >
                <input
                  type="email"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  disabled={mutation.isPending}
                  className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-ink-50"
                />
              </Field>

              <Field label={tProposals("detail.send_to_client.subject_label")}>
                <input
                  type="text"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  disabled={mutation.isPending}
                  className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-ink-50"
                />
              </Field>

              <Field
                label={tProposals("detail.send_to_client.body_label")}
                hint={tProposals("detail.send_to_client.body_hint")}
              >
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  disabled={mutation.isPending}
                  rows={10}
                  className="w-full resize-y rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-ink-50"
                />
              </Field>

              {/* Sales-person BCC hint. The backend auto-adds the
               *  assigned sales person to the BCC line so they
               *  always get a record of the send. Surfaced here so
               *  the operator knows the behaviour exists and isn't
               *  surprised by a BCC line in the audit log. */}
              {proposal.effective_sales_person_name ? (
                <p className="rounded-xl bg-ink-50 px-3 py-2 text-[11px] text-ink-600 ring-1 ring-inset ring-ink-200">
                  {tProposals("detail.send_to_client.auto_bcc_hint", {
                    name: proposal.effective_sales_person_name,
                  })}
                </p>
              ) : null}

              {/* Send-test affordance. A separate input + button so the
                  operator can preview the exact email in their own (or
                  a colleague's) inbox before committing to the
                  customer-facing send. Status is never touched by the
                  test endpoint. */}
              <div className="flex flex-col gap-2 rounded-xl bg-ink-50 px-3 py-3 ring-1 ring-inset ring-ink-200">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-ink-700">
                    {tProposals("detail.send_to_client.test_label")}
                  </span>
                  <span className="text-[11px] text-ink-500">
                    {tProposals("detail.send_to_client.test_hint")}
                  </span>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="email"
                    value={testRecipient}
                    onChange={(e) => {
                      setTestRecipient(e.target.value);
                      if (testStatus.kind !== "idle") {
                        setTestStatus({ kind: "idle" });
                      }
                    }}
                    disabled={
                      testMutation.isPending || mutation.isPending
                    }
                    placeholder={
                      currentUserEmail ||
                      tProposals("detail.send_to_client.test_placeholder")
                    }
                    className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:bg-ink-100 sm:flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleSendTest}
                    isDisabled={
                      !testRecipientValid ||
                      testMutation.isPending ||
                      mutation.isPending
                    }
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-ink-0 px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <TestTube2 className="h-4 w-4" />
                    {testMutation.isPending
                      ? tProposals("detail.send_to_client.test_sending")
                      : tProposals("detail.send_to_client.test_send")}
                  </Button>
                </div>
                {testStatus.kind === "ok" ? (
                  <p
                    role="status"
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-success"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {tProposals("detail.send_to_client.test_sent", {
                      recipient: testStatus.recipient,
                    })}
                  </p>
                ) : null}
                {testStatus.kind === "error" ? (
                  <p
                    role="alert"
                    className="text-xs font-medium text-danger"
                  >
                    {testStatus.message}
                  </p>
                ) : null}
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
                onClick={() => onOpenChange(false)}
                isDisabled={mutation.isPending}
                className="rounded-lg px-4 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50 disabled:opacity-50"
              >
                {tProposals("detail.send_to_client.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleSend}
                isDisabled={!canSend || mutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-4 py-2 text-sm font-medium text-ink-0 hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {mutation.isPending
                  ? tProposals("detail.send_to_client.sending")
                  : tProposals("detail.send_to_client.send")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}


function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {children}
      {hint ? <span className="text-[11px] text-ink-500">{hint}</span> : null}
    </label>
  );
}
