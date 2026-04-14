"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
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
    <article className="flex h-full flex-col border-2 border-ink-1000 bg-ink-0 p-6">
      <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {tOrgs("empty.title")}
        </span>
      </header>

      <p className="mt-5 text-sm text-ink-600">{tOrgs("empty.subtitle")}</p>

      <form
        onSubmit={onSubmit}
        className="mt-6 flex flex-1 flex-col gap-5"
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
            className="border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
          >
            {errors.root.message}
          </p>
        ) : null}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="mt-auto self-start rounded-none font-bold tracking-wider uppercase"
          isDisabled={isSubmitting || createOrg.isPending}
        >
          {tOrgs("empty.submit")}
        </Button>
      </form>
    </article>
  );
}
