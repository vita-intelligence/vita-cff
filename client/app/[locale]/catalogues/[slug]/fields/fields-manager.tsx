"use client";

import { Button, Modal } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Controller,
  useFieldArray,
  useForm,
  type SubmitHandler,
} from "react-hook-form";

import { Chip } from "@/components/ui/chip";
import { FormField } from "@/components/ui/form-field";
import { translateCode } from "@/lib/errors/translate";
import {
  createAttributeDefinitionSchema,
  DATA_TYPES,
  useArchiveAttributeDefinition,
  useCreateAttributeDefinition,
  useUpdateAttributeDefinition,
  type AttributeDefinitionDto,
  type CreateAttributeDefinitionInput,
  type DataType,
} from "@/services/attributes";

interface ApiFieldErrors {
  fieldErrors?: Record<string, readonly string[]>;
}

type FormMode =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "edit"; definition: AttributeDefinitionDto };

const SELECT_TYPES: readonly DataType[] = ["single_select", "multi_select"];

function isSelectType(value: string): boolean {
  return SELECT_TYPES.includes(value as DataType);
}

export function FieldsManager({
  orgId,
  slug,
  initialDefinitions,
}: {
  orgId: string;
  slug: string;
  initialDefinitions: readonly AttributeDefinitionDto[];
}) {
  const tAttrs = useTranslations("attributes");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const [mode, setMode] = useState<FormMode>({ kind: "closed" });

  const createMutation = useCreateAttributeDefinition(orgId, slug);
  const editingId =
    mode.kind === "edit" ? mode.definition.id : "__placeholder__";
  const updateMutation = useUpdateAttributeDefinition(orgId, slug, editingId);
  const archiveMutation = useArchiveAttributeDefinition(orgId, slug);

  const dataTypeLabels = useMemo(
    () =>
      Object.fromEntries(
        DATA_TYPES.map((dt) => [dt, tAttrs(`data_types.${dt}`)]),
      ) as Record<DataType, string>,
    [tAttrs],
  );

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tAttrs("title")}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {tAttrs("title")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            {tAttrs("subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-3 text-sm font-medium text-ink-0 hover:bg-orange-600"
          onClick={() => setMode({ kind: "create" })}
        >
          <Plus className="h-4 w-4" />
          {tAttrs("new_field")}
        </Button>
      </div>

      <div className="mt-6 overflow-hidden rounded-2xl bg-ink-0 shadow-sm ring-1 ring-ink-200">
        {initialDefinitions.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
              {tAttrs("no_fields")}
            </p>
            <p className="mt-2 text-sm text-ink-500">
              {tAttrs("no_fields_hint")}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead className="bg-ink-50">
                <tr>
                  <Th>{tAttrs("columns.label")}</Th>
                  <Th>{tAttrs("columns.key")}</Th>
                  <Th>{tAttrs("columns.data_type")}</Th>
                  <Th>{tAttrs("columns.required")}</Th>
                  <Th>{tAttrs("columns.status")}</Th>
                  <Th align="right">{tAttrs("columns.actions")}</Th>
                </tr>
              </thead>
              <tbody>
                {initialDefinitions.map((defn, idx) => (
                  <tr
                    key={defn.id}
                    className={
                      idx < initialDefinitions.length - 1
                        ? "border-b border-ink-100"
                        : ""
                    }
                  >
                    <Td>
                      <span className="text-sm font-medium text-ink-1000">
                        {defn.label}
                      </span>
                    </Td>
                    <Td>
                      <code className="font-mono text-xs text-ink-500">
                        {defn.key}
                      </code>
                    </Td>
                    <Td>
                      <span className="text-xs text-ink-700">
                        {dataTypeLabels[defn.data_type]}
                      </span>
                    </Td>
                    <Td>
                      {defn.required ? (
                        <Chip tone="orange">
                          {tAttrs("required_badge.yes")}
                        </Chip>
                      ) : (
                        <Chip tone="neutral">
                          {tAttrs("required_badge.no")}
                        </Chip>
                      )}
                    </Td>
                    <Td>
                      {defn.is_archived ? (
                        <Chip tone="neutral">
                          {tAttrs("status.archived")}
                        </Chip>
                      ) : (
                        <Chip tone="success">
                          {tAttrs("status.active")}
                        </Chip>
                      )}
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                          onClick={() =>
                            setMode({ kind: "edit", definition: defn })
                          }
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {tAttrs("actions.edit")}
                        </Button>
                        {!defn.is_archived ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                            isDisabled={archiveMutation.isPending}
                            onClick={async () => {
                              try {
                                await archiveMutation.mutateAsync(defn.id);
                                router.refresh();
                              } catch {
                                /* ignored */
                              }
                            }}
                          >
                            <Archive className="h-3.5 w-3.5" />
                            {tAttrs("actions.archive")}
                          </Button>
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {mode.kind !== "closed" ? (
        <FieldFormModal
          key={mode.kind === "edit" ? mode.definition.id : "new"}
          mode={mode}
          onClose={() => setMode({ kind: "closed" })}
          onSaved={() => {
            setMode({ kind: "closed" });
            router.refresh();
          }}
          createMutation={createMutation}
          updateMutation={updateMutation}
          dataTypeLabels={dataTypeLabels}
          tAttrs={tAttrs}
          tErrors={tErrors}
        />
      ) : null}
    </div>
  );
}

function Th({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={`px-4 py-3 text-xs font-medium uppercase tracking-wide text-ink-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align = "left",
}: {
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <td
      className={`px-4 py-3 align-middle ${align === "right" ? "text-right" : ""}`}
    >
      {children}
    </td>
  );
}

interface FieldFormModalProps {
  mode: FormMode;
  onClose: () => void;
  onSaved: () => void;
  createMutation: ReturnType<typeof useCreateAttributeDefinition>;
  updateMutation: ReturnType<typeof useUpdateAttributeDefinition>;
  dataTypeLabels: Record<DataType, string>;
  tAttrs: ReturnType<typeof useTranslations<"attributes">>;
  tErrors: ReturnType<typeof useTranslations<"errors">>;
}

function FieldFormModal({
  mode,
  onClose,
  onSaved,
  createMutation,
  updateMutation,
  dataTypeLabels,
  tAttrs,
  tErrors,
}: FieldFormModalProps) {
  const isEdit = mode.kind === "edit";
  const editing = mode.kind === "edit" ? mode.definition : null;

  const defaults: CreateAttributeDefinitionInput = isEdit
    ? {
        key: editing!.key,
        label: editing!.label,
        data_type: editing!.data_type,
        required: editing!.required,
        options: editing!.options.map((o) => ({
          value: o.value,
          label: o.label,
        })),
      }
    : {
        key: "",
        label: "",
        data_type: "text",
        required: false,
        options: [],
      };

  const {
    control,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateAttributeDefinitionInput>({
    resolver: zodResolver(createAttributeDefinitionSchema),
    defaultValues: defaults,
  });

  const {
    fields: optionFields,
    append,
    remove,
  } = useFieldArray({ control, name: "options" });

  const dataType = watch("data_type") as DataType;
  const selectActive = isSelectType(dataType);

  const onSubmit: SubmitHandler<CreateAttributeDefinitionInput> = async (
    values,
  ) => {
    try {
      if (isEdit && editing) {
        await updateMutation.mutateAsync({
          label: values.label,
          required: values.required,
          options: selectActive ? values.options : [],
        });
      } else {
        await createMutation.mutateAsync({
          key: values.key,
          label: values.label,
          data_type: values.data_type as DataType,
          required: values.required,
          options: selectActive ? values.options : [],
        });
      }
      onSaved();
    } catch (error) {
      const fieldErrors = (error as ApiFieldErrors).fieldErrors ?? {};
      const known: readonly (keyof CreateAttributeDefinitionInput)[] = [
        "key",
        "label",
        "data_type",
        "options",
      ];
      let handled = false;
      for (const key of known) {
        const codes = fieldErrors[key as string];
        if (codes && codes.length > 0) {
          setError(key as keyof CreateAttributeDefinitionInput, {
            type: "server",
            message: codes[0],
          });
          handled = true;
        }
      }
      if (!handled) {
        setError("root", {
          type: "server",
          message: translateCode(tErrors, fieldErrors.detail?.[0]),
        });
      }
    }
  };

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  return (
    <Modal isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Backdrop>
        <Modal.Container size="md">
          <Modal.Dialog className="overflow-hidden rounded-2xl bg-ink-0 p-0 shadow-lg ring-1 ring-ink-200">
            <Modal.Header className="flex items-center justify-between border-b border-ink-200 px-6 py-4">
              <Modal.Heading className="text-base font-semibold text-ink-1000">
                {isEdit
                  ? tAttrs("form.title_edit")
                  : tAttrs("form.title_create")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              <form
                id="field-form"
                onSubmit={handleSubmit(onSubmit)}
                className="flex flex-col gap-4"
                noValidate
              >
                <Controller
                  control={control}
                  name="label"
                  render={({ field }) => (
                    <FormField
                      {...field}
                      label={tAttrs("form.label")}
                      description={tAttrs("form.label_hint")}
                      errorMessage={fieldError(errors.label?.message)}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name="key"
                  render={({ field }) => (
                    <FormField
                      {...field}
                      label={tAttrs("form.key")}
                      description={tAttrs("form.key_hint")}
                      isDisabled={isEdit}
                      errorMessage={fieldError(errors.key?.message)}
                    />
                  )}
                />

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="data_type"
                    className="text-xs font-medium text-ink-700"
                  >
                    {tAttrs("form.data_type")}
                  </label>
                  <Controller
                    control={control}
                    name="data_type"
                    render={({ field }) => (
                      <select
                        id="data_type"
                        value={field.value}
                        onChange={(e) => {
                          field.onChange(e.target.value);
                          const nextSelect = isSelectType(e.target.value);
                          if (!nextSelect) {
                            setValue("options", []);
                          }
                        }}
                        onBlur={field.onBlur}
                        disabled={isEdit}
                        className="w-full cursor-pointer rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400 disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-500"
                      >
                        {DATA_TYPES.map((dt) => (
                          <option key={dt} value={dt}>
                            {dataTypeLabels[dt]}
                          </option>
                        ))}
                      </select>
                    )}
                  />
                  <p className="text-xs text-ink-500">
                    {tAttrs("form.data_type_hint")}
                  </p>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Controller
                    control={control}
                    name="required"
                    render={({ field }) => (
                      <label className="inline-flex items-center gap-2 text-sm font-medium text-ink-700">
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                          onBlur={field.onBlur}
                          className="h-4 w-4 cursor-pointer rounded accent-orange-500"
                        />
                        {tAttrs("form.required")}
                      </label>
                    )}
                  />
                  <p className="text-xs text-ink-500">
                    {tAttrs("form.required_hint")}
                  </p>
                </div>

                {selectActive ? (
                  <div className="flex flex-col gap-3 border-t border-ink-200 pt-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
                        {tAttrs("form.options")}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
                        onClick={() => append({ value: "", label: "" })}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {tAttrs("form.add_option")}
                      </Button>
                    </div>
                    {optionFields.length === 0 ? (
                      <p className="text-xs text-ink-500">
                        {tAttrs("form.options_hint")}
                      </p>
                    ) : null}
                    {optionFields.map((optField, index) => (
                      <div
                        key={optField.id}
                        className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
                      >
                        <Controller
                          control={control}
                          name={`options.${index}.value`}
                          render={({ field }) => (
                            <FormField
                              {...field}
                              label={tAttrs("form.option_value")}
                              errorMessage={fieldError(
                                errors.options?.[index]?.value?.message,
                              )}
                            />
                          )}
                        />
                        <Controller
                          control={control}
                          name={`options.${index}.label`}
                          render={({ field }) => (
                            <FormField
                              {...field}
                              label={tAttrs("form.option_label")}
                              errorMessage={fieldError(
                                errors.options?.[index]?.label?.message,
                              )}
                            />
                          )}
                        />
                        <div className="flex justify-end sm:justify-start">
                          <Button
                            type="button"
                            variant="outline"
                            size="md"
                            aria-label={tAttrs("form.remove_option")}
                            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20 hover:bg-danger/10"
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                            <span className="sm:hidden">
                              {tAttrs("form.remove_option")}
                            </span>
                          </Button>
                        </div>
                      </div>
                    ))}
                    {errors.options?.message ? (
                      <p className="text-xs font-medium text-danger">
                        {fieldError(errors.options.message as string)}
                      </p>
                    ) : null}
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
                onClick={onClose}
              >
                {tAttrs("form.cancel")}
              </Button>
              <Button
                type="submit"
                form="field-form"
                variant="primary"
                size="md"
                className="h-10 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
                isDisabled={
                  isSubmitting ||
                  createMutation.isPending ||
                  updateMutation.isPending
                }
              >
                {isEdit
                  ? tAttrs("form.submit_save")
                  : tAttrs("form.submit_create")}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
