"use client";

import { Button, Modal } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { DynamicField } from "@/components/ui/dynamic-field";
import { FormField } from "@/components/ui/form-field";
import { translateCode } from "@/lib/errors/translate";
import type { AttributeDefinitionDto } from "@/services/attributes/types";
import { createItemSchema, useCreateItem } from "@/services/catalogues";

interface ApiFieldErrors {
  fieldErrors?: Record<string, unknown>;
}

const extendedSchema = createItemSchema.extend({
  attributes: z.record(z.string(), z.any()),
});

type ExtendedInput = z.infer<typeof extendedSchema>;

function initialAttributesFor(
  definitions: readonly AttributeDefinitionDto[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const defn of definitions) {
    if (defn.is_archived) continue;
    if (defn.data_type === "boolean") {
      result[defn.key] = false;
    } else if (defn.data_type === "multi_select") {
      result[defn.key] = [];
    } else {
      result[defn.key] = null;
    }
  }
  return result;
}

export function NewItemButton({
  orgId,
  slug,
  definitions,
}: {
  orgId: string;
  slug: string;
  definitions: readonly AttributeDefinitionDto[];
}) {
  const tItems = useTranslations("items");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const createMutation = useCreateItem(orgId, slug);

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
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ExtendedInput>({
    resolver: zodResolver(extendedSchema),
    defaultValues: {
      name: "",
      internal_code: "",
      unit: "",
      base_price: null,
      attributes: initialAttributesFor(activeDefinitions),
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createMutation.mutateAsync({
        name: values.name,
        internal_code: values.internal_code || "",
        unit: values.unit || "",
        base_price: values.base_price,
        attributes: values.attributes as unknown as Record<string, unknown>,
      } as never);
      reset({
        name: "",
        internal_code: "",
        unit: "",
        base_price: null,
        attributes: initialAttributesFor(activeDefinitions),
      });
      setIsOpen(false);
      router.refresh();
    } catch (error) {
      const fieldErrors = (error as ApiFieldErrors).fieldErrors ?? {};
      let handled = false;
      const known: readonly (keyof ExtendedInput)[] = [
        "name",
        "internal_code",
        "unit",
        "base_price",
      ];
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

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  return (
    <Modal isOpen={isOpen} onOpenChange={setIsOpen}>
      <Modal.Trigger>
        <Button
          type="button"
          variant="primary"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
        >
          <Plus className="h-4 w-4" />
          {tItems("new_item")}
        </Button>
      </Modal.Trigger>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {tItems("create.title")}
              </Modal.Heading>
              <Modal.CloseTrigger className="inline-flex h-9 items-center rounded-lg px-2 text-xs font-medium text-ink-500 hover:bg-ink-50 hover:text-ink-1000" />
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              <form
                onSubmit={onSubmit}
                className="flex flex-col gap-4"
                noValidate
              >
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

                {activeDefinitions.length > 0 ? (
                  <div className="flex flex-col gap-4 border-t border-ink-200 pt-4">
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
                ) : null}

                {errors.root?.message ? (
                  <p
                    role="alert"
                    className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
                  >
                    {errors.root.message}
                  </p>
                ) : null}
              </form>
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t border-ink-200 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="h-10 rounded-lg px-4 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                onClick={() => setIsOpen(false)}
              >
                {tItems("create.cancel")}
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                onClick={() => {
                  void onSubmit();
                }}
                isDisabled={isSubmitting || createMutation.isPending}
              >
                {tItems("create.submit")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
