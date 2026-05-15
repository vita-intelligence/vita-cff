"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { FormField } from "@/components/ui/form-field";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api/errors";
import {
  extractApiErrorMessage,
  translateCode,
} from "@/lib/errors/translate";
import {
  resetPasswordSchema,
  useConfirmPasswordReset,
  useValidatePasswordResetToken,
  type PasswordResetTokenErrorDto,
  type ResetPasswordInput,
} from "@/services/accounts";

type TokenErrorCode = PasswordResetTokenErrorDto["code"];

const TOKEN_ERROR_CODES = new Set<TokenErrorCode>([
  "password_reset_token_invalid",
  "password_reset_token_expired",
  "password_reset_token_used",
  "password_reset_token_invalidated",
]);

/** Pull the token-state code out of an ApiError when the endpoint
 *  reported it. ``normalizeApiError`` hoists ``payload.code`` into
 *  ``error.code`` so the top-level field is the canonical place
 *  to look; we still fall back to the payload for resilience. */
function tokenErrorCode(error: unknown): TokenErrorCode | null {
  if (!(error instanceof ApiError)) return null;
  const candidates = [error.code, error.payload?.code];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      TOKEN_ERROR_CODES.has(candidate as TokenErrorCode)
    ) {
      return candidate as TokenErrorCode;
    }
  }
  return null;
}

interface Props {
  readonly token: string;
}

/**
 * Reset-password form.
 *
 * Three phases:
 *
 * 1. **Validating** — fire the validate endpoint on mount so the
 *    user sees "this link expired" before they bother typing.
 * 2. **Form** — token is currently consumable, render the new
 *    password fields and submit to confirm.
 * 3. **Success** — password saved; surface a one-shot success
 *    state with a CTA back to /login (the user must re-authenticate
 *    with the new password — successful reset deliberately does
 *    not mint a session).
 *
 * A fourth implicit state, **error**, replaces phase 2/3 whenever a
 * token-state code is returned by either the validate or the
 * confirm endpoint.
 */
export function ResetPasswordForm({ token }: Props) {
  const tAuth = useTranslations("auth");
  const tErrors = useTranslations("errors");
  const [success, setSuccess] = useState(false);

  const validation = useValidatePasswordResetToken(token);
  const confirm = useConfirmPasswordReset();

  const {
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", password_confirm: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await confirm.mutateAsync({
        token,
        password: values.password,
        password_confirm: values.password_confirm,
      });
      setSuccess(true);
    } catch (error) {
      // Token-state errors hoist into the page-level error block
      // so the user is not stuck trying to retype a password
      // against an unusable link.
      const tokenCode = tokenErrorCode(error);
      if (tokenCode) {
        setError("root", {
          type: "server",
          message: tAuth(`reset_password.errors.${tokenCode}`),
        });
        return;
      }

      // Field-scoped password validator codes from the backend
      // (password_too_short, password_too_common, ...) land
      // here. They are already in errors.json so a single
      // translateCode call resolves them.
      if (error instanceof ApiError) {
        const passwordCodes = error.fieldErrors.password;
        if (Array.isArray(passwordCodes) && passwordCodes.length > 0) {
          setError("password", {
            type: "server",
            message: translateCode(tErrors, String(passwordCodes[0])),
          });
          return;
        }
      }

      setError("root", {
        type: "server",
        message: extractApiErrorMessage(error, tErrors),
      });
    }
  });

  const fieldError = (message: string | undefined) =>
    message ? translateCode(tErrors, message) : undefined;

  // -----------------------------------------------------------------
  // Edge: no token at all — defensive even though the route is
  // ``/reset-password/[token]`` so the segment is required.
  // -----------------------------------------------------------------
  if (!token) {
    return (
      <TokenErrorBlock
        message={tAuth("reset_password.errors.missing_token")}
        backLabel={tAuth("reset_password.back_to_login")}
        requestNewLabel={tAuth("reset_password.request_new_link")}
      />
    );
  }

  // -----------------------------------------------------------------
  // Phase 1 — initial validation in flight.
  // -----------------------------------------------------------------
  if (validation.isPending) {
    return (
      <p className="text-sm text-ink-700" role="status">
        {tAuth("reset_password.validating")}
      </p>
    );
  }

  // -----------------------------------------------------------------
  // Phase 1b — validation failed. Render a dedicated error block
  // with a "request a new link" CTA; the password form stays
  // hidden because typing a password against an expired token is
  // pointless.
  // -----------------------------------------------------------------
  if (validation.isError) {
    const code = tokenErrorCode(validation.error);
    const message = code
      ? tAuth(`reset_password.errors.${code}`)
      : extractApiErrorMessage(validation.error, tErrors);
    return (
      <TokenErrorBlock
        message={message}
        backLabel={tAuth("reset_password.back_to_login")}
        requestNewLabel={tAuth("reset_password.request_new_link")}
      />
    );
  }

  // -----------------------------------------------------------------
  // Phase 3 — password successfully rotated.
  // -----------------------------------------------------------------
  if (success) {
    return (
      <div className="flex w-full flex-col gap-5">
        <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          <p className="font-semibold">
            {tAuth("reset_password.success_title")}
          </p>
          <p className="mt-1">{tAuth("reset_password.success_body")}</p>
        </div>
        <Link
          href="/login"
          className="text-center text-sm font-medium text-orange-700 underline-offset-4 hover:text-orange-800 hover:underline"
        >
          {tAuth("reset_password.back_to_login")}
        </Link>
      </div>
    );
  }

  // -----------------------------------------------------------------
  // Phase 2 — token is currently consumable: render the form.
  // -----------------------------------------------------------------
  return (
    <form
      method="post"
      onSubmit={onSubmit}
      className="flex w-full flex-col gap-5"
      noValidate
    >
      <p className="text-sm text-ink-700">{tAuth("reset_password.body")}</p>

      <Controller
        control={control}
        name="password"
        render={({ field }) => (
          <FormField
            {...field}
            label={tAuth("reset_password.fields.password")}
            type="password"
            placeholder="••••••••••"
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
            label={tAuth("reset_password.fields.password_confirm")}
            type="password"
            placeholder="••••••••••"
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
        isDisabled={isSubmitting || confirm.isPending}
      >
        {confirm.isPending
          ? tAuth("reset_password.saving")
          : tAuth("reset_password.submit")}
      </Button>

      <Link
        href="/login"
        className="text-center text-sm text-ink-500 underline-offset-4 hover:text-ink-700 hover:underline"
      >
        {tAuth("reset_password.back_to_login")}
      </Link>
    </form>
  );
}

function TokenErrorBlock({
  message,
  backLabel,
  requestNewLabel,
}: {
  readonly message: string;
  readonly backLabel: string;
  readonly requestNewLabel: string;
}) {
  return (
    <div className="flex w-full flex-col gap-5">
      <p
        role="alert"
        className="rounded-xl bg-danger/10 px-3 py-3 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
      >
        {message}
      </p>
      <Link
        href="/forgot-password"
        className="text-center text-sm font-medium text-orange-700 underline-offset-4 hover:text-orange-800 hover:underline"
      >
        {requestNewLabel}
      </Link>
      <Link
        href="/login"
        className="text-center text-sm text-ink-500 underline-offset-4 hover:text-ink-700 hover:underline"
      >
        {backLabel}
      </Link>
    </div>
  );
}
