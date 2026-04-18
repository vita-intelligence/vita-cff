"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { FormField } from "@/components/ui/form-field";
import { translateCode } from "@/lib/errors/translate";
import {
  createInvitationSchema,
  useCreateInvitation,
  type CreateInvitationInput,
  type InvitationDto,
} from "@/services/invitations";

interface ApiFieldErrors {
  fieldErrors?: Record<string, readonly string[]>;
}

export function InviteMemberCard({ orgId }: { orgId: string }) {
  const tInvite = useTranslations("invitations");
  const tErrors = useTranslations("errors");
  const locale = useLocale();

  const createMutation = useCreateInvitation(orgId);
  const [result, setResult] = useState<InvitationDto | null>(null);
  const [copied, setCopied] = useState(false);

  const {
    control,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateInvitationInput>({
    resolver: zodResolver(createInvitationSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const invitation = await createMutation.mutateAsync(values);
      setResult(invitation);
      setCopied(false);
      reset({ email: "" });
    } catch (error) {
      const fieldErrors = (error as ApiFieldErrors).fieldErrors ?? {};
      const emailCodes = fieldErrors.email;
      if (emailCodes && emailCodes.length > 0) {
        setError("email", { type: "server", message: emailCodes[0] });
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

  const inviteUrl =
    result && typeof window !== "undefined"
      ? `${window.location.origin}/${locale}/invite/${result.token}/`
      : "";

  const onCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permissions can fail silently; the visible URL is still
      // selectable manually, so we swallow the failure.
    }
  };

  const startOver = () => {
    setResult(null);
    setCopied(false);
  };

  return (
    <article className="flex flex-col gap-4 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <header className="flex items-center gap-2">
        <MailPlus className="h-4 w-4 text-ink-500" />
        <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
          {tInvite("invite_member.title")}
        </span>
      </header>

      {result ? (
        <div className="flex flex-col gap-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tInvite("invite_member.success_title")}
          </p>
          <p className="text-sm text-ink-700">
            {tInvite("invite_member.success_hint")}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <code className="flex-1 overflow-x-auto rounded-lg bg-ink-50 px-3 py-2 text-xs break-all text-ink-900 ring-1 ring-inset ring-ink-200">
              {inviteUrl}
            </code>
            <Button
              type="button"
              variant="primary"
              size="md"
              className="h-11 shrink-0 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
              onClick={onCopy}
            >
              {copied
                ? tInvite("invite_member.success_copied")
                : tInvite("invite_member.success_copy")}
            </Button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="md"
            className="h-10 self-start rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            onClick={startOver}
          >
            {tInvite("invite_member.invite_another")}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-ink-500">
            {tInvite("invite_member.subtitle")}
          </p>
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-3 md:flex-row md:items-end md:gap-3"
            noValidate
          >
            <div className="flex-1">
              <Controller
                control={control}
                name="email"
                render={({ field }) => (
                  <FormField
                    {...field}
                    type="email"
                    label={tInvite("invite_member.email_label")}
                    placeholder={tInvite("invite_member.email_placeholder")}
                    autoComplete="off"
                    errorMessage={fieldError(errors.email?.message)}
                  />
                )}
              />
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="h-11 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
              isDisabled={isSubmitting || createMutation.isPending}
            >
              {tInvite("invite_member.submit")}
            </Button>
          </form>
          {errors.root?.message ? (
            <p
              role="alert"
              className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
            >
              {errors.root.message}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}
