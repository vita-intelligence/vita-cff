"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Controller, useForm } from "react-hook-form";

import { FormField } from "@/components/ui/form-field";
import { Link, useRouter } from "@/i18n/navigation";
import {
  extractApiErrorMessage,
  translateCode,
} from "@/lib/errors/translate";
import {
  loginSchema,
  useLogin,
  type LoginInput,
} from "@/services/accounts";

/**
 * Resolve a safe post-login redirect target from the ``?next=`` query
 * string. Limited to same-origin relative paths so a poisoned link
 * cannot bounce a freshly signed-in user to an external phishing
 * lookalike. Falls back to ``/home``.
 */
function resolveNextPath(raw: string | null | undefined): string {
  if (!raw) return "/home";
  let candidate: string;
  try {
    candidate = decodeURIComponent(raw);
  } catch {
    return "/home";
  }
  if (!candidate.startsWith("/")) return "/home";
  // Defend against ``//evil.example.com`` and protocol-relative URLs.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return "/home";
  if (candidate.startsWith("/login")) return "/home";
  return candidate;
}

export function LoginForm() {
  const tAuth = useTranslations("auth");
  const tErrors = useTranslations("errors");

  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = resolveNextPath(searchParams.get("next"));
  const login = useLogin();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
      router.replace(nextPath);
    } catch (error) {
      setError("root", {
        type: "server",
        message: extractApiErrorMessage(error, tErrors),
      });
    }
  });

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="flex w-full flex-col gap-5"
      noValidate
    >
      <Controller
        control={control}
        name="email"
        render={({ field }) => (
          <FormField
            {...field}
            label={tAuth("login.fields.email")}
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
            label={tAuth("login.fields.password")}
            type="password"
            placeholder="••••••••"
            autoComplete="current-password"
            errorMessage={fieldError(errors.password?.message)}
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
        isDisabled={isSubmitting || login.isPending}
      >
        {tAuth("login.submit")}
      </Button>

      <p className="text-center text-sm text-ink-500">
        {tAuth("register.already_have_account")}{" "}
        <Link
          href="/register"
          className="font-medium text-orange-700 underline-offset-4 hover:text-orange-800 hover:underline"
        >
          {tAuth("register.submit")}
        </Link>
      </p>
    </form>
  );
}
