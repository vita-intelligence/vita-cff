"use client";

import { AlertDialog, Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { DynamicField } from "@/components/ui/dynamic-field";
import { FormField } from "@/components/ui/form-field";
import { useRouter } from "@/i18n/navigation";
import { translateCode } from "@/lib/errors/translate";
import type { AttributeDefinitionDto } from "@/services/attributes/types";
import {
  updateItemSchema,
  useArchiveItem,
  useHardDeleteItem,
  useUpdateItem,
  type ItemDto,
} from "@/services/catalogues";

interface ApiFieldErrors {
  fieldErrors?: Record<string, unknown>;
}

const extendedUpdateSchema = updateItemSchema.extend({
  attributes: z.record(z.string(), z.any()),
});

type ExtendedUpdateInput = z.infer<typeof extendedUpdateSchema>;

function initialAttributesFrom(
  item: ItemDto,
  definitions: readonly AttributeDefinitionDto[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const defn of definitions) {
    if (defn.is_archived) continue;
    const current = item.attributes?.[defn.key];
    if (current !== undefined && current !== null) {
      result[defn.key] = current;
    } else if (defn.data_type === "boolean") {
      result[defn.key] = false;
    } else if (defn.data_type === "multi_select") {
      result[defn.key] = [];
    } else {
      result[defn.key] = null;
    }
  }
  return result;
}

export function EditItemForm({
  orgId,
  slug,
  item,
  canAdmin,
  definitions,
}: {
  orgId: string;
  slug: string;
  item: ItemDto;
  canAdmin: boolean;
  definitions: readonly AttributeDefinitionDto[];
}) {
  const tItems = useTranslations("items");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const updateMutation = useUpdateItem(orgId, slug, item.id);
  const archiveMutation = useArchiveItem(orgId, slug);
  const hardDeleteMutation = useHardDeleteItem(orgId, slug);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const activeDefinitions = useMemo(
    () =>
      definitions
        .filter((d) => !d.is_archived)
        .sort(
          (a, b) =>
            a.display_order - b.display_order ||
            a.label.localeCompare(b.label),
        ),
    [definitions],
  );

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ExtendedUpdateInput>({
    resolver: zodResolver(extendedUpdateSchema),
    defaultValues: {
      name: item.name,
      internal_code: item.internal_code,
      unit: item.unit,
      base_price: item.base_price,
      is_archived: item.is_archived,
      attributes: initialAttributesFrom(item, activeDefinitions),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await updateMutation.mutateAsync({
        name: values.name,
        internal_code: values.internal_code,
        unit: values.unit,
        base_price: values.base_price,
        is_archived: values.is_archived,
        attributes: values.attributes as unknown as Record<string, unknown>,
      } as never);
      router.refresh();
    } catch (error) {
      const fieldErrors = (error as ApiFieldErrors).fieldErrors ?? {};
      const known: readonly (keyof ExtendedUpdateInput)[] = [
        "name",
        "internal_code",
        "unit",
        "base_price",
      ];
      let handled = false;
      for (const key of known) {
        const codes = fieldErrors[key as string];
        if (Array.isArray(codes) && codes.length > 0) {
          setError(key, { type: "server", message: String(codes[0]) });
          handled = true;
        }
      }
      const attributeErrors = fieldErrors.attributes;
      if (
        attributeErrors &&
        typeof attributeErrors === "object" &&
        !Array.isArray(attributeErrors)
      ) {
        for (const [key, codes] of Object.entries(
          attributeErrors as Record<string, unknown>,
        )) {
          if (Array.isArray(codes) && codes.length > 0) {
            setError(`attributes.${key}` as never, {
              type: "server",
              message: String(codes[0]),
            });
            handled = true;
          }
        }
      }
      if (!handled) {
        setError("root", {
          type: "server",
          message: translateCode(
            tErrors,
            Array.isArray(fieldErrors.detail)
              ? String(fieldErrors.detail[0])
              : undefined,
          ),
        });
      }
    }
  });

  const onArchive = async () => {
    try {
      await archiveMutation.mutateAsync(item.id);
      router.push(`/catalogues/${slug}`);
      router.refresh();
    } catch {
      /* mutation state drives surfaced error UX */
    }
  };

  const onRestore = async () => {
    try {
      await updateMutation.mutateAsync({ is_archived: false });
      router.refresh();
    } catch {
      /* mutation state drives surfaced error UX */
    }
  };

  const onConfirmDelete = async () => {
    try {
      await hardDeleteMutation.mutateAsync(item.id);
      setIsConfirmOpen(false);
      router.push(`/catalogues/${slug}`);
      router.refresh();
    } catch {
      /* mutation state drives surfaced error UX */
    }
  };

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  const isBusy =
    isSubmitting ||
    updateMutation.isPending ||
    archiveMutation.isPending ||
    hardDeleteMutation.isPending;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="flex flex-col gap-4">
          <Controller
            control={control}
            name="name"
            render={({ field }) => (
              <FormField
                {...field}
                label={tItems("fields.name")}
                placeholder={tItems("placeholders.name")}
                errorMessage={fieldError(errors.name?.message)}
              />
            )}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Controller
              control={control}
              name="internal_code"
              render={({ field }) => (
                <FormField
                  {...field}
                  value={field.value ?? ""}
                  label={tItems("fields.internal_code")}
                  placeholder={tItems("placeholders.internal_code")}
                  errorMessage={fieldError(errors.internal_code?.message)}
                />
              )}
            />
            <Controller
              control={control}
              name="unit"
              render={({ field }) => (
                <FormField
                  {...field}
                  value={field.value ?? ""}
                  label={tItems("fields.unit")}
                  placeholder={tItems("placeholders.unit")}
                  errorMessage={fieldError(errors.unit?.message)}
                />
              )}
            />
          </div>
          <Controller
            control={control}
            name="base_price"
            render={({ field }) => (
              <FormField
                name={field.name}
                value={field.value ?? ""}
                onChange={(value) =>
                  field.onChange(value === "" ? null : value)
                }
                onBlur={field.onBlur}
                label={tItems("fields.base_price")}
                placeholder={tItems("placeholders.base_price")}
                errorMessage={fieldError(errors.base_price?.message)}
              />
            )}
          />
        </div>
      </div>

      {activeDefinitions.length > 0 ? (
        <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
          <div className="flex flex-col gap-4">
            {activeDefinitions.map((defn) => (
              <Controller
                key={defn.id}
                control={control}
                name={`attributes.${defn.key}` as never}
                render={({ field, fieldState }) => (
                  <DynamicField
                    definition={defn}
                    value={field.value as never}
                    onChange={(v) => field.onChange(v)}
                    onBlur={field.onBlur}
                    errorMessage={fieldError(fieldState.error?.message)}
                  />
                )}
              />
            ))}
          </div>
        </div>
      ) : null}

      {errors.root?.message ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {errors.root.message}
        </p>
      ) : null}

      <div className="sticky bottom-4 flex flex-wrap items-center justify-end gap-2 rounded-2xl bg-ink-0 px-4 py-3 shadow-md ring-1 ring-ink-200">
        {canAdmin && !item.is_archived ? (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            isDisabled={isBusy}
            onClick={onArchive}
          >
            <Archive className="h-4 w-4" />
            {tItems("detail.archive")}
          </Button>
        ) : null}

        {canAdmin && item.is_archived ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
              isDisabled={isBusy}
              onClick={onRestore}
            >
              <RotateCcw className="h-4 w-4" />
              {tItems("detail.restore")}
            </Button>

            <AlertDialog
              isOpen={isConfirmOpen}
              onOpenChange={setIsConfirmOpen}
            >
              <AlertDialog.Trigger>
                <Button
                  type="button"
                  variant="danger"
                  size="lg"
                  className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-danger/10 px-3 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger/15"
                  isDisabled={isBusy}
                >
                  <Trash2 className="h-4 w-4" />
                  {tItems("detail.delete_permanently")}
                </Button>
              </AlertDialog.Trigger>
              <AlertDialog.Backdrop>
                <AlertDialog.Container size="md">
                  <AlertDialog.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
                    <AlertDialog.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
                      <AlertDialog.Heading className="text-base font-semibold text-ink-1000">
                        {tItems("delete_confirm.title")}
                      </AlertDialog.Heading>
                    </AlertDialog.Header>
                    <AlertDialog.Body className="px-6 py-6">
                      <p className="text-sm text-ink-500">
                        {tItems("delete_confirm.body", { name: item.name })}
                      </p>
                    </AlertDialog.Body>
                    <AlertDialog.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
                      <Button
                        type="button"
                        variant="outline"
                        size="md"
                        className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                        onClick={() => setIsConfirmOpen(false)}
                        isDisabled={hardDeleteMutation.isPending}
                      >
                        {tItems("delete_confirm.cancel")}
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="md"
                        className="h-10 rounded-lg bg-danger px-4 text-sm font-medium text-ink-0 hover:bg-danger/90"
                        onClick={onConfirmDelete}
                        isDisabled={hardDeleteMutation.isPending}
                      >
                        {tItems("delete_confirm.confirm")}
                      </Button>
                    </AlertDialog.Footer>
                  </AlertDialog.Dialog>
                </AlertDialog.Container>
              </AlertDialog.Backdrop>
            </AlertDialog>
          </>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          isDisabled={!isDirty || isBusy}
        >
          <Save className="h-4 w-4" />
          {tItems("detail.save")}
        </Button>
      </div>
    </form>
  );
}
