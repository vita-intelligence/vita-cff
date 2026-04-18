"use client";

import { Button, Modal } from "@heroui/react";
import { Share2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useRevokeSpecificationPublicLink,
  useRotateSpecificationPublicLink,
  type SpecificationSheetDto,
} from "@/services/specifications";

/**
 * Trigger + modal for the spec sheet's public preview link.
 *
 * On first click opens a modal that either (a) generates a token,
 * copies the preview URL, and lets the scientist revoke/rotate it
 * in place, or (b) surfaces an existing link when one is already
 * set. The token itself is a row-level attribute on the sheet so
 * rotating it invalidates every previously-shared URL in one
 * write — same model the backend exposes.
 */
export function SharePublicLinkButton({
  orgId,
  sheet,
}: {
  orgId: string;
  sheet: SpecificationSheetDto;
}) {
  const tSpecs = useTranslations("specifications");
  const tErrors = useTranslations("errors");
  const locale = useLocale();
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The parent page SSR-fetches the sheet, so the ``sheet`` prop is
  // frozen at navigation time. Mutations below flow the latest token
  // into local state so the modal reflects the server's answer
  // without waiting for a full SSR refresh round-trip.
  const [token, setToken] = useState<string | null>(sheet.public_token);
  useEffect(() => {
    setToken(sheet.public_token);
  }, [sheet.public_token]);

  const rotateMutation = useRotateSpecificationPublicLink(orgId, sheet.id);
  const revokeMutation = useRevokeSpecificationPublicLink(orgId, sheet.id);

  const publicUrl = token
    ? `${typeof window === "undefined" ? "" : window.location.origin}/${locale}/p/${token}`
    : "";

  const isBusy = rotateMutation.isPending || revokeMutation.isPending;

  const handleGenerate = async () => {
    setError(null);
    setJustCopied(false);
    try {
      const updated = await rotateMutation.mutateAsync();
      setToken(updated.public_token);
      // Refresh the SSR tree in the background so the next navigation
      // (and anyone else reading ``sheet.public_token`` from props)
      // sees the fresh value without a hard reload.
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const handleRevoke = async () => {
    setError(null);
    setJustCopied(false);
    try {
      await revokeMutation.mutateAsync();
      setToken(null);
      router.refresh();
    } catch (err) {
      setError(extractErrorMessage(err, tErrors));
    }
  };

  const handleCopy = async () => {
    if (!publicUrl || typeof navigator === "undefined") return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      setJustCopied(true);
      window.setTimeout(() => setJustCopied(false), 2500);
    } catch {
      // Clipboard may be unavailable in insecure contexts; surface
      // the URL so the scientist can still select + copy manually.
      setError(tErrors("generic"));
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          setError(null);
          setJustCopied(false);
        }
      }}
    >
      <Modal.Trigger>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <span className="inline-flex items-center gap-1.5">
            <Share2 className="h-4 w-4" />
            {tSpecs("detail.share_link")}
          </span>
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tSpecs("share.title")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-4 px-6 py-6">
              <p className="text-sm text-ink-500">{tSpecs("share.subtitle")}</p>

              {token ? (
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-medium text-ink-700">
                    {tSpecs("share.url_label")}
                  </label>
                  <div className="flex items-stretch gap-2">
                    <input
                      readOnly
                      value={publicUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="flex-1 rounded-lg bg-ink-0 px-3 py-2 text-xs text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                      onClick={handleCopy}
                    >
                      {justCopied
                        ? tSpecs("share.copied")
                        : tSpecs("share.copy")}
                    </Button>
                  </div>
                  <p className="text-xs text-ink-500">
                    {tSpecs("share.token_hint")}
                  </p>
                </div>
              ) : (
                <p className="rounded-xl bg-ink-50 px-3 py-2 text-sm text-ink-700 ring-1 ring-inset ring-ink-200">
                  {tSpecs("share.not_shared")}
                </p>
              )}

              {error ? (
                <p
                  role="alert"
                  className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                >
                  {error}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-200 px-6 py-4">
              {token ? (
                <>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className="rounded-lg bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger/15"
                    isDisabled={isBusy}
                    onClick={handleRevoke}
                  >
                    {tSpecs("share.revoke")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                    isDisabled={isBusy}
                    onClick={handleGenerate}
                  >
                    {tSpecs("share.rotate")}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="rounded-lg bg-orange-500 px-3 py-2 text-sm font-medium text-ink-0 hover:bg-orange-600"
                  isDisabled={isBusy}
                  onClick={handleGenerate}
                >
                  {tSpecs("share.generate")}
                </Button>
              )}
            </Modal.Footer>
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
