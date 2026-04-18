"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { Controller, useForm } from "react-hook-form";

import { FormField } from "@/components/ui/form-field";
import { useRouter } from "@/i18n/navigation";
import { translateCode } from "@/lib/errors/translate";
import {
  registerSchema,
  useLogin,
  useRegister,
  type RegisterInput,
} from "@/services/accounts";

interface ApiFieldErrors {
  fieldErrors?: Record<string, readonly string[]>;
}

export function RegisterForm() {
  const tAuth = useTranslations("auth");
  const tErrors = useTranslations("errors");

  const router = useRouter();
  const register = useRegister();
  const login = useLogin();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      email: "",
      first_name: "",
      last_name: "",
      password: "",
      password_confirm: "",
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await register.mutateAsync(values);
      // Registration succeeds → log the user in so they land on /home with
      // a valid session instead of bouncing back to /login.
      await login.mutateAsync({
        email: values.email,
        password: values.password,
      });
      router.replace("/home");
    } catch (error) {
      const fieldErrors = (error as ApiFieldErrors).fieldErrors ?? {};
      let handled = false;
      const knownFields: readonly (keyof RegisterInput)[] = [
        "email",
        "first_name",
        "last_name",
        "password",
        "password_confirm",
      ];
      for (const key of knownFields) {
        const codes = fieldErrors[key];
        if (codes && codes.length > 0) {
          setError(key, {
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
  });

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  return (
    <form onSubmit={onSubmit} className="flex w-full flex-col gap-5" noValidate>
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Controller
          control={control}
          name="first_name"
          render={({ field }) => (
            <FormField
              {...field}
              label={tAuth("register.fields.first_name")}
              placeholder="Ada"
              autoComplete="given-name"
              errorMessage={fieldError(errors.first_name?.message)}
            />
          )}
        />
        <Controller
          control={control}
          name="last_name"
          render={({ field }) => (
            <FormField
              {...field}
              label={tAuth("register.fields.last_name")}
              placeholder="Lovelace"
              autoComplete="family-name"
              errorMessage={fieldError(errors.last_name?.message)}
            />
          )}
        />
      </div>
      <Controller
        control={control}
        name="email"
        render={({ field }) => (
          <FormField
            {...field}
            label={tAuth("register.fields.email")}
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            errorMessage={fieldError(errors.email?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <FormField
            {...field}
            label={tAuth("register.fields.password")}
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            errorMessage={fieldError(errors.password?.message)}
          />
        )}
      />
      <Controller
        control={control}
        name="password_confirm"
        render={({ field }) => (
          <FormField
            {...field}
            label={tAuth("register.fields.password_confirm")}
            type="password"
            placeholder="••••••••"
            autoComplete="new-password"
            errorMessage={fieldError(errors.password_confirm?.message)}
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
        fullWidth
        className="mt-2 h-11 w-full rounded-lg bg-orange-500 text-sm font-medium text-ink-0 hover:bg-orange-600"
        isDisabled={isSubmitting || register.isPending || login.isPending}
      >
        {tAuth("register.submit")}
      </Button>
    </form>
  );
}
