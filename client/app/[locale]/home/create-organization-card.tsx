"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Controller, useForm } from "react-hook-form";

import { FormField } from "@/components/ui/form-field";
import { translateCode } from "@/lib/errors/translate";
import {
  createOrganizationSchema,
  useCreateOrganization,
  type CreateOrganizationInput,
} from "@/services/organizations";

interface ApiFieldErrors {
  fieldErrors?: Record<string, readonly string[]>;
}

export function CreateOrganizationCard() {
  const tOrgs = useTranslations("organizations");
  const tErrors = useTranslations("errors");

  const router = useRouter();
  const createOrg = useCreateOrganization();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateOrganizationInput>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createOrg.mutateAsync(values);
      router.refresh();
    } catch (error) {
      const fieldErrors = (error as ApiFieldErrors).fieldErrors ?? {};
      const nameCodes = fieldErrors.name;
      if (nameCodes && nameCodes.length > 0) {
        setError("name", { type: "server", message: nameCodes[0] });
        return;
      }
      setError("root", {
        type: "server",
        message: translateCode(tErrors, fieldErrors.detail?.[0]),
      });
    }
  });

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  return (
    <article className="flex h-full flex-col gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-ink-500" />
        <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tOrgs("empty.title")}
        </span>
      </header>

      <p className="text-sm text-ink-500">{tOrgs("empty.subtitle")}</p>

      <form
        onSubmit={onSubmit}
        className="mt-2 flex flex-1 flex-col gap-4"
        noValidate
      >
        <Controller
          control={control}
          name="name"
          render={({ field }) => (
            <FormField
              {...field}
              label={tOrgs("empty.name_label")}
              placeholder={tOrgs("empty.name_placeholder")}
              autoComplete="organization"
              errorMessage={fieldError(errors.name?.message)}
            />
          )}
        />

        {errors.root?.message ? (
          <p
            role="alert"
            className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
          >
            {errors.root.message}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="mt-auto h-11 self-start rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          isDisabled={isSubmitting || createOrg.isPending}
        >
          {tOrgs("empty.submit")}
        </Button>
      </form>
    </article>
  );
}
