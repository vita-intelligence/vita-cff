"use client";

import { AlertDialog, Button, toast } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, RotateCcw, Save, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
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

/** Keys the backend serializer treats as system-reserved on
 *  ``attributes`` — they survive ``validate_values`` regardless of
 *  any AttributeDefinition rows and are edited via the dedicated
 *  ``BandDefaultsSection`` below. Must stay in sync with
 *  ``SYSTEM_ATTRIBUTE_KEYS`` in the backend serializer. */
const SYSTEM_ATTRIBUTE_KEYS = ["default_for_bands"] as const;

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
  // System-reserved keys — populate from the persisted item so a
  // reload of the edit form shows the flags the admin previously
  // ticked. Missing / non-array → empty list so the checkbox section
  // reads a stable value.
  for (const key of SYSTEM_ATTRIBUTE_KEYS) {
    const current = item.attributes?.[key];
    result[key] = Array.isArray(current) ? current : [];
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
    formState: { errors, isSubmitting },
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
      toast.success(tItems("detail.saved"));
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
      toast.danger(tErrors("generic"));
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
        <DynamicFieldsSection
          control={control}
          definitions={activeDefinitions}
          fieldError={fieldError}
        />
      ) : null}

      {/* System-reserved band defaults. Editable via checkboxes on
          the same item edit surface (no separate settings page) —
          flipping a flag here is what makes an item the org's
          auto-injected default for a specific formulation band (see
          apps/formulations/services.resolve_default_item_for_band).
          Wire lives on the JSON ``attributes.default_for_bands``
          array; the serializer treats these keys as system-reserved
          so they survive attribute validation regardless of any
          AttributeDefinition rows. */}
      <BandDefaultsSection control={control} />

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
          type="button"
          variant="primary"
          size="lg"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          isDisabled={isBusy}
          onPress={() => onSubmit()}
        >
          <Save className="h-4 w-4" />
          {tItems("detail.save")}
        </Button>
      </div>
    </form>
  );
}


/**
 * System-reserved "default for band" flags. These live on the same
 * ``attributes`` JSON blob but are OUT of the user-defined attribute
 * definition system — the backend serializer treats them as system-
 * reserved keys that survive validate_values regardless of any
 * AttributeDefinition rows.
 *
 * Ticking a checkbox flags this item as the org's default for the
 * corresponding formulation band. The resolver
 * (:func:`apps.formulations.services.resolve_default_item_for_band`)
 * picks the newest-updated flagged item per band, so if two items
 * are ticked for the same band the most recently saved one wins.
 *
 * Currently exposed: ``gummy_water`` only. The auto-inject +
 * validation flow lives in
 * :func:`apps.formulations.services._ensure_gummy_water_pick` — future
 * bands (``mcc_carrier``, ``dcp_carrier``, ``powder_carrier``, etc.)
 * plug into the same helper and add a row to ``BAND_OPTIONS`` here.
 */
const BAND_OPTIONS: readonly {
  readonly key: string;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    key: "gummy_water",
    label: "Gummy water",
    description:
      "Auto-injected into every gummy formulation's gummy-base picks when the scientist has not chosen a water-named item themselves. Prevents a phantom \"Deionised Water\" row appearing on the routing without a MA code or stage assignment.",
  },
];

function BandDefaultsSection({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: any;
}) {
  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink-1000">
          Default for band
        </h3>
        <p className="mt-0.5 text-xs text-ink-500">
          Flag this item as the org&apos;s auto-injected default for one
          or more formulation bands. If two items in the same catalogue
          are flagged for the same band, the most recently saved one wins.
        </p>
      </div>
      <Controller
        control={control}
        name={"attributes.default_for_bands" as never}
        render={({ field }) => {
          const value = Array.isArray(field.value)
            ? (field.value as string[])
            : [];
          const toggle = (key: string, checked: boolean) => {
            const next = checked
              ? Array.from(new Set([...value, key]))
              : value.filter((v) => v !== key);
            field.onChange(next);
          };
          return (
            <ul className="flex flex-col gap-3">
              {BAND_OPTIONS.map((option) => {
                const checked = value.includes(option.key);
                return (
                  <li key={option.key} className="flex items-start gap-3">
                    <input
                      id={`default-for-band-${option.key}`}
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-ink-300 text-orange-500 focus:ring-orange-500"
                      checked={checked}
                      onChange={(e) => toggle(option.key, e.target.checked)}
                      onBlur={field.onBlur}
                    />
                    <label
                      htmlFor={`default-for-band-${option.key}`}
                      className="cursor-pointer select-none"
                    >
                      <p className="text-sm font-medium text-ink-1000">
                        {option.label}
                      </p>
                      <p className="text-xs text-ink-500">
                        {option.description}
                      </p>
                    </label>
                  </li>
                );
              })}
            </ul>
          );
        }}
      />
    </div>
  );
}


/**
 * Section wrapper that subscribes to the form's ``attributes.use_as``
 * value once and feeds it into every :class:`DynamicField` below.
 *
 * Pulled out so the parent ``EditItemForm`` doesn't have to call
 * ``useWatch`` itself and re-render on every keystroke just because
 * one of the dynamic fields cares about the sibling value. Only
 * attributes whose key opts into label/description derivation (see
 * the map in ``DynamicField``) actually read the prop -- everything
 * else ignores it.
 */
function DynamicFieldsSection({
  control,
  definitions,
  fieldError,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: any;
  definitions: readonly AttributeDefinitionDto[];
  fieldError: (message: string | undefined) => string | undefined;
}) {
  const useAsValue = useWatch({
    control,
    name: "attributes.use_as" as never,
  }) as unknown;
  const siblingUseAs =
    typeof useAsValue === "string" && useAsValue.trim() !== ""
      ? useAsValue
      : null;

  return (
    <div className="rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex flex-col gap-4">
        {definitions.map((defn) => (
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
                siblingUseAs={siblingUseAs}
              />
            )}
          />
        ))}
      </div>
    </div>
  );
}
