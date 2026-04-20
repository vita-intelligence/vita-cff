"use client";

import { Button, Modal } from "@heroui/react";
import { AlertTriangle, CloudUpload, Download, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";

import { Chip } from "@/components/ui/chip";

import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  downloadImportTemplate,
  useImportItems,
  type ImportItemsResultDto,
} from "@/services/catalogues";

interface ImportItemsButtonProps {
  orgId: string;
  slug: string;
}

export function ImportItemsButton({ orgId, slug }: ImportItemsButtonProps) {
  const tItems = useTranslations("items");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportItemsResultDto | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isTemplateBusy, setIsTemplateBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const importMutation = useImportItems(orgId, slug);

  const handleTemplateDownload = async () => {
    setFileError(null);
    setIsTemplateBusy(true);
    try {
      const blob = await downloadImportTemplate(orgId, slug);
      // Build an object URL, nudge it through a synthetic anchor,
      // and release the URL afterwards so we don't leak blob refs
      // on repeated downloads.
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${slug}_import_template.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      window.URL.revokeObjectURL(url);
    } catch {
      setFileError(tErrors("generic"));
    } finally {
      setIsTemplateBusy(false);
    }
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setFileError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const close = () => {
    setIsOpen(false);
    reset();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setFileError(null);
    setResult(null);
    const next = event.target.files?.[0] ?? null;
    setFile(next);
  };

  const handleSubmit = async () => {
    if (!file) return;
    setFileError(null);
    setResult(null);
    try {
      const response = await importMutation.mutateAsync(file);
      setResult(response);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError) {
        const code = error.fieldErrors.file?.[0];
        if (code) {
          const localeKey = `import_modal.errors.${code}`;
          const translated = tItems(localeKey);
          setFileError(
            translated === localeKey
              ? translateCode(tErrors, code)
              : translated,
          );
          return;
        }
      }
      setFileError(tErrors("generic"));
    }
  };

  const isBusy = importMutation.isPending;

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => (open ? setIsOpen(true) : close())}>
      <Modal.Trigger>
        <Button
          type="button"
          variant="outline"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
        >
          <Upload className="h-4 w-4" />
          {tItems("import")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tItems("import_modal.title")}
              </Modal.Heading>
              <Modal.CloseTrigger className="inline-flex h-9 items-center rounded-lg px-2 text-xs font-medium text-ink-500 hover:bg-ink-50 hover:text-ink-1000" />
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              {result === null ? (
                <div className="flex flex-col gap-4">
                  <p className="text-sm text-ink-500">
                    {tItems("import_modal.intro")}
                  </p>

                  <div className="flex items-start justify-between gap-3 rounded-xl bg-orange-50/70 p-3 ring-1 ring-inset ring-orange-200">
                    <div className="flex flex-col">
                      <p className="text-xs font-medium text-orange-900">
                        {tItems("import_modal.template_title")}
                      </p>
                      <p className="mt-0.5 text-xs text-orange-800/80">
                        {tItems("import_modal.template_hint")}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-1.5 text-xs font-medium text-orange-900 ring-1 ring-inset ring-orange-300 hover:bg-orange-100"
                      onClick={handleTemplateDownload}
                      isDisabled={isTemplateBusy}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {isTemplateBusy
                        ? tItems("import_modal.template_downloading")
                        : tItems("import_modal.template_download")}
                    </Button>
                  </div>

                  <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl bg-ink-50 px-4 py-10 text-center ring-1 ring-dashed ring-ink-300 transition-colors hover:bg-orange-50/60 hover:ring-orange-300">
                    <input
                      ref={inputRef}
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={handleFileChange}
                      className="sr-only"
                    />
                    <CloudUpload className="h-8 w-8 text-ink-400" />
                    <span className="text-sm font-medium text-ink-700">
                      {tItems("import_modal.dropzone_label")}
                    </span>
                    {file ? (
                      <span className="text-xs text-ink-500">
                        {tItems("import_modal.selected_file", {
                          name: file.name,
                        })}
                      </span>
                    ) : null}
                  </label>

                  {fileError ? (
                    <p
                      role="alert"
                      className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                    >
                      {fileError}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                      {tItems("import_modal.result_title")}
                    </p>
                    <p className="mt-1 text-xl font-semibold tracking-tight text-ink-1000">
                      {tItems("import_modal.result_created", {
                        count: result.created,
                      })}
                    </p>
                  </div>

                  {result.errors.length > 0 ? (
                    <section className="rounded-2xl bg-danger/10 p-4 ring-1 ring-inset ring-danger/20">
                      <p className="inline-flex items-center gap-1.5 text-xs font-medium text-danger">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {tItems("import_modal.result_errors_title")}
                      </p>
                      <ul className="mt-3 flex flex-col gap-2">
                        {result.errors.map((err) => (
                          <li key={err.row} className="text-xs text-ink-900">
                            <span className="font-semibold">
                              {tItems("import_modal.result_error_row", {
                                row: err.row,
                              })}
                              :
                            </span>{" "}
                            {Object.entries(err.errors).map(
                              ([field, codes], index, arr) => (
                                <span key={field}>
                                  {field}={" "}
                                  <em>
                                    {codes
                                      .map((c) =>
                                        translateCode(tErrors, c),
                                      )
                                      .join(", ")}
                                  </em>
                                  {index < arr.length - 1 ? "; " : ""}
                                </span>
                              ),
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {result.unmapped_columns.length > 0 ? (
                    <section className="rounded-2xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
                      <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
                        {tItems("import_modal.result_unmapped_title")}
                      </p>
                      <ul className="mt-3 flex flex-wrap gap-1.5">
                        {result.unmapped_columns.map((col) => (
                          <li key={col}>
                            <Chip tone="neutral">{col}</Chip>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs text-ink-500">
                        {tItems("import_modal.result_unmapped_hint")}{" "}
                        <Link
                          href={`/catalogues/${slug}/fields`}
                          className="font-medium text-orange-700 hover:text-orange-800 hover:underline"
                          onClick={close}
                        >
                          /catalogues/{slug}/fields
                        </Link>
                      </p>
                    </section>
                  ) : null}
                </div>
              )}
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
                {result === null
                  ? tItems("import_modal.cancel")
                  : tItems("import_modal.close")}
              </Button>
              {result === null ? (
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                  onClick={handleSubmit}
                  isDisabled={!file || isBusy}
                >
                  {tItems("import_modal.submit")}
                </Button>
              ) : null}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
