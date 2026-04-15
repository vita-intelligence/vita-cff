"use client";

import { Button, Modal } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent } from "react";

import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
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
  const inputRef = useRef<HTMLInputElement>(null);

  const importMutation = useImportItems(orgId, slug);

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
          className="rounded-none border-2 font-bold tracking-wider uppercase"
        >
          {tItems("import")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="border-2 border-ink-1000 bg-ink-0 p-0">
            <Modal.Header className="flex items-center justify-between border-b-2 border-ink-1000 px-6 py-4">
              <Modal.Heading className="font-mono text-xs tracking-widest uppercase text-ink-700">
                {tItems("import_modal.title")}
              </Modal.Heading>
              <Modal.CloseTrigger className="font-mono text-[10px] tracking-widest uppercase text-ink-600 hover:text-ink-1000" />
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              {result === null ? (
                <div className="flex flex-col gap-5">
                  <p className="text-sm text-ink-700">
                    {tItems("import_modal.intro")}
                  </p>

                  <label className="flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed border-ink-1000 bg-ink-0 px-4 py-10 text-center hover:bg-ink-50">
                    <input
                      ref={inputRef}
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      onChange={handleFileChange}
                      className="sr-only"
                    />
                    <span className="font-mono text-[11px] tracking-widest uppercase text-ink-700">
                      {tItems("import_modal.dropzone_label")}
                    </span>
                    {file ? (
                      <span className="font-mono text-xs text-ink-1000">
                        {tItems("import_modal.selected_file", {
                          name: file.name,
                        })}
                      </span>
                    ) : null}
                  </label>

                  {fileError ? (
                    <p
                      role="alert"
                      className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
                    >
                      {fileError}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="flex flex-col gap-5">
                  <div>
                    <p className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
                      {tItems("import_modal.result_title")}
                    </p>
                    <p className="mt-2 text-lg font-black tracking-tight uppercase">
                      {tItems("import_modal.result_created", {
                        count: result.created,
                      })}
                    </p>
                  </div>

                  {result.errors.length > 0 ? (
                    <section className="border-2 border-danger bg-danger/10 p-4">
                      <p className="font-mono text-[10px] tracking-widest uppercase text-danger">
                        {tItems("import_modal.result_errors_title")}
                      </p>
                      <ul className="mt-3 flex flex-col gap-2">
                        {result.errors.map((err) => (
                          <li
                            key={err.row}
                            className="font-mono text-xs text-ink-900"
                          >
                            <span className="font-bold">
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
                    <section className="border-2 border-ink-1000 bg-ink-50 p-4">
                      <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
                        {tItems("import_modal.result_unmapped_title")}
                      </p>
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {result.unmapped_columns.map((col) => (
                          <li
                            key={col}
                            className="border-2 border-ink-1000 bg-ink-0 px-2 py-1 font-mono text-[11px] tracking-widest uppercase text-ink-900"
                          >
                            {col}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs text-ink-700">
                        {tItems("import_modal.result_unmapped_hint")}{" "}
                        <Link
                          href={`/catalogues/${slug}/fields`}
                          className="font-bold text-ink-1000 underline underline-offset-4"
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
            <Modal.Footer className="flex items-center justify-end gap-3 border-t-2 border-ink-1000 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="rounded-none border-2 font-bold tracking-wider uppercase"
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
                  className="rounded-none font-bold tracking-wider uppercase"
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
