"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { FormField } from "@/components/ui/form-field";
import { Link } from "@/i18n/navigation";
import {
  extractApiErrorMessage,
  translateCode,
} from "@/lib/errors/translate";
import {
  forgotPasswordSchema,
  useRequestPasswordReset,
  type ForgotPasswordInput,
} from "@/services/accounts";

/**
 * Forgot-password form.
 *
 * The submit handler always transitions to the same "check your
 * inbox" success state regardless of whether the email is
 * registered — the backend already returns 200 for unknown
 * addresses to defeat enumeration, and the UI must mirror that
 * contract or it would leak existence information by branching on
 * error states.
 *
 * Throttle errors (429) are the one exception we *do* surface, so
 * a legit user who clicks the button five times in two minutes
 * gets useful feedback instead of a phantom "we sent it" message.
 */
export function ForgotPasswordForm() {
  const tAuth = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  const request = useRequestPasswordReset();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await request.mutateAsync(values);
      setSubmittedEmail(values.email);
    } catch (error) {
      setError("root", {
        type: "server",
        message: extractApiErrorMessage(error, tErrors),
      });
    }
  });

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  if (submittedEmail) {
    return (
      <div className="flex w-full flex-col gap-5">
        <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          <p className="font-semibold">{tAuth("forgot_password.sent_title")}</p>
          <p className="mt-1">{tAuth("forgot_password.sent_body")}</p>
        </div>
        <p className="text-xs text-ink-500">
          {tAuth("forgot_password.sent_hint")}
        </p>
        <Link
          href="/login"
          className="text-center text-sm font-medium text-orange-700 underline-offset-4 hover:text-orange-800 hover:underline"
        >
          {tAuth("forgot_password.back_to_login")}
        </Link>
      </div>
    );
  }

  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="flex w-full flex-col gap-5"
      noValidate
    >
      <p className="text-sm text-ink-700">{tAuth("forgot_password.body")}</p>

      <Controller
        control={control}
        name="email"
        render={({ field }) => (
          <FormField
            {...field}
            label={tAuth("forgot_password.fields.email")}
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            errorMessage={fieldError(errors.email?.message)}
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
        isDisabled={isSubmitting || request.isPending}
      >
        {request.isPending
          ? tAuth("forgot_password.sending")
          : tAuth("forgot_password.submit")}
      </Button>

      <Link
        href="/login"
        className="text-center text-sm text-ink-500 underline-offset-4 hover:text-ink-700 hover:underline"
      >
        {tAuth("forgot_password.back_to_login")}
      </Link>
    </form>
  );
}
