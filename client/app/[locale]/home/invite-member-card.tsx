"use client";

import { Button } from "@heroui/react";
import { zodResolver } from "@hookform/resolvers/zod";
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
    <article className="flex flex-col border-2 border-ink-1000 bg-ink-0 p-6">
      <header className="flex items-center justify-between border-b-2 border-ink-1000 pb-3">
        <span className="font-mono text-[10px] tracking-widest uppercase text-ink-700">
          {tInvite("invite_member.title")}
        </span>
      </header>

      {result ? (
        <div className="mt-5 flex flex-col gap-4">
          <p className="font-mono text-[10px] tracking-widest uppercase text-ink-500">
            {tInvite("invite_member.success_title")}
          </p>
          <p className="text-sm text-ink-700">
            {tInvite("invite_member.success_hint")}
          </p>
          <div className="flex items-start gap-3">
            <code className="flex-1 overflow-x-auto border-2 border-ink-1000 bg-ink-50 px-3 py-2 font-mono text-xs break-all text-ink-900">
              {inviteUrl}
            </code>
            <Button
              type="button"
              variant="primary"
              size="md"
              className="rounded-none font-bold tracking-wider uppercase"
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
            className="self-start rounded-none border-2 font-bold tracking-wider uppercase"
            onClick={startOver}
          >
            {tInvite("invite_member.invite_another")}
          </Button>
        </div>
      ) : (
        <>
          <p className="mt-5 text-sm text-ink-600">
            {tInvite("invite_member.subtitle")}
          </p>
          <form
            onSubmit={onSubmit}
            className="mt-5 flex flex-col gap-4 md:flex-row md:items-end md:gap-4"
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
              className="rounded-none font-bold tracking-wider uppercase"
              isDisabled={isSubmitting || createMutation.isPending}
            >
              {tInvite("invite_member.submit")}
            </Button>
          </form>
          {errors.root?.message ? (
            <p
              role="alert"
              className="mt-3 border-2 border-danger bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
            >
              {errors.root.message}
            </p>
          ) : null}
        </>
      )}
    </article>
  );
}
