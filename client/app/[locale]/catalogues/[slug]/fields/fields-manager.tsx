"use client";

import { Button, Modal } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  Controller,
  useFieldArray,
  useForm,
  type SubmitHandler,
} from "react-hook-form";

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
      <div className="mt-10 flex items-start justify-between gap-6 md:mt-12">
        <div>
          <p className="font-mono text-[11px] tracking-widest uppercase text-ink-500">
            {tAttrs("title").toUpperCase()}
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-tight uppercase md:text-5xl">
            {tAttrs("title")}
          </h1>
          <p className="mt-3 max-w-2xl text-sm text-ink-600">
            {tAttrs("subtitle")}
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="md"
          className="rounded-none font-bold tracking-wider uppercase"
          onClick={() => setMode({ kind: "create" })}
        >
          {tAttrs("new_field")}
        </Button>
      </div>

      <div className="mt-10 border-2 border-ink-1000 bg-ink-0">
        {initialDefinitions.length === 0 ? (
          <div className="flex flex-col items-start gap-2 p-8">
            <p className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
              {tAttrs("no_fields")}
            </p>
            <p className="text-sm text-ink-600">
              {tAttrs("no_fields_hint")}
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b-2 border-ink-1000">
                <Th>{tAttrs("columns.label")}</Th>
                <Th>{tAttrs("columns.key")}</Th>
                <Th>{tAttrs("columns.data_type")}</Th>
                <Th>{tAttrs("columns.required")}</Th>
                <Th>{tAttrs("columns.status")}</Th>
                <Th align="right">{tAttrs("columns.actions")}</Th>
              </tr>
            </thead>
            <tbody>
              {initialDefinitions.map((defn) => (
                <tr
                  key={defn.id}
                  className="border-b border-ink-200 last:border-b-0"
                >
                  <Td>
                    <span className="font-bold">{defn.label}</span>
                  </Td>
                  <Td>
                    <code className="font-mono text-xs text-ink-600">
                      {defn.key}
                    </code>
                  </Td>
                  <Td>
                    <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
                      {dataTypeLabels[defn.data_type]}
                    </span>
                  </Td>
                  <Td>
                    {defn.required ? (
                      <Badge variant="filled">
                        {tAttrs("required_badge.yes")}
                      </Badge>
                    ) : (
                      <Badge variant="outline">
                        {tAttrs("required_badge.no")}
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    {defn.is_archived ? (
                      <Badge variant="outline">
                        {tAttrs("status.archived")}
                      </Badge>
                    ) : (
                      <Badge variant="filled">
                        {tAttrs("status.active")}
                      </Badge>
                    )}
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-none border-2 font-bold tracking-wider uppercase"
                        onClick={() =>
                          setMode({ kind: "edit", definition: defn })
                        }
                      >
                        {tAttrs("actions.edit")}
                      </Button>
                      {!defn.is_archived ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-none border-2 font-bold tracking-wider uppercase"
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
                          {tAttrs("actions.archive")}
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
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
      className={`px-4 py-3 font-mono text-[10px] tracking-widest uppercase text-ink-700 ${
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
    <td className={`px-4 py-3 ${align === "right" ? "text-right" : ""}`}>
      {children}
    </td>
  );
}

function Badge({
  children,
  variant,
}: {
  children: React.ReactNode;
  variant: "filled" | "outline";
}) {
  const base =
    "inline-flex items-center border-2 border-ink-1000 px-2 py-0.5 font-mono text-[10px] tracking-widest uppercase";
  return (
    <span
      className={
        variant === "filled"
          ? `${base} bg-ink-1000 text-ink-0`
          : `${base} bg-ink-0 text-ink-700`
      }
    >
      {children}
    </span>
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
          <Modal.Dialog className="border-2 border-ink-1000 bg-ink-0 p-0">
            <Modal.Header className="flex items-center justify-between border-b-2 border-ink-1000 px-6 py-4">
              <Modal.Heading className="font-mono text-xs tracking-widest uppercase text-ink-700">
                {isEdit
                  ? tAttrs("form.title_edit")
                  : tAttrs("form.title_create")}
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body className="max-h-[70vh] overflow-y-auto px-6 py-6">
              <form
                id="field-form"
                onSubmit={handleSubmit(onSubmit)}
                className="flex flex-col gap-5"
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
                    className="text-xs font-bold tracking-widest uppercase text-ink-700"
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
                        className="w-full cursor-pointer border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard disabled:cursor-not-allowed disabled:bg-ink-100"
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
                      <label className="flex items-center gap-3 text-xs font-bold tracking-widest uppercase text-ink-700">
                        <input
                          type="checkbox"
                          checked={field.value}
                          onChange={(e) => field.onChange(e.target.checked)}
                          onBlur={field.onBlur}
                          className="h-5 w-5 cursor-pointer appearance-none border-2 border-ink-1000 bg-ink-0 checked:bg-ink-1000"
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
                  <div className="flex flex-col gap-3 border-t-2 border-ink-200 pt-5">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
                        {tAttrs("form.options")}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-none border-2 font-bold tracking-wider uppercase"
                        onClick={() => append({ value: "", label: "" })}
                      >
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
                        className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]"
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
                        <div className="flex items-end">
                          <Button
                            type="button"
                            variant="outline"
                            size="md"
                            className="rounded-none border-2 font-bold tracking-wider uppercase"
                            onClick={() => remove(index)}
                          >
                            {tAttrs("form.remove_option")}
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
                    className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
                  >
                    {errors.root.message}
                  </p>
                ) : null}
              </form>
            </Modal.Body>
            <Modal.Footer className="flex items-center justify-end gap-3 border-t-2 border-ink-1000 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                size="md"
                className="rounded-none border-2 font-bold tracking-wider uppercase"
                onClick={onClose}
              >
                {tAttrs("form.cancel")}
              </Button>
              <Button
                type="submit"
                form="field-form"
                variant="primary"
                size="md"
                className="rounded-none font-bold tracking-wider uppercase"
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
