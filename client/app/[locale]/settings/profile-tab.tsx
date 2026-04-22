"use client";

import { Button } from "@heroui/react";
import { Check, Mail, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { AvatarUploader } from "@/components/ui/avatar-uploader";
import { UserAvatar } from "@/components/ui/user-avatar";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useUpdateCurrentUser } from "@/services/accounts";
import type { UserDto } from "@/services/accounts/types";


/**
 * Profile tab — summary card plus an inline name editor.
 *
 * Email stays read-only for now; changing an email needs a
 * re-verification flow that's out of scope here. The editor keeps
 * the rest of the card visible while open so the context (avatar +
 * email) never leaves the user's eyeline while they're typing.
 */
export function ProfileTab({ user }: { user: UserDto }) {
  const tSettings = useTranslations("settings");

  const [isEditing, setIsEditing] = useState(false);
  // Local mirror of the avatar so the upload widget repaints before
  // the router-level ``/me`` query next refetches. Starting from the
  // server-provided value keeps SSR hydration consistent.
  const [avatar, setAvatar] = useState<string>(user.avatar_image || "");

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-ink-1000">
          {tSettings("profile.section_title")}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">
          {tSettings("profile.section_subtitle")}
        </p>
      </div>

      <article className="flex flex-col gap-5 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
        <div className="flex items-center gap-4">
          <UserAvatar
            name={user.full_name}
            email={user.email}
            imageUrl={avatar || null}
            size={56}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-lg font-semibold text-ink-1000">
              {user.full_name}
            </p>
            <p className="mt-0.5 inline-flex items-center gap-1.5 truncate text-sm text-ink-500">
              <Mail className="h-3.5 w-3.5" />
              {user.email}
            </p>
          </div>
          {!isEditing ? (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            >
              <Pencil className="h-3.5 w-3.5" />
              {tSettings("profile.edit")}
            </button>
          ) : null}
        </div>

        <div className="border-t border-ink-100 pt-5">
          <AvatarUploader
            name={user.full_name}
            email={user.email}
            currentImage={avatar}
            onUploaded={setAvatar}
            onCleared={() => setAvatar("")}
          />
        </div>

        {isEditing ? (
          <EditNameForm user={user} onDone={() => setIsEditing(false)} />
        ) : null}
      </article>
    </section>
  );
}


function EditNameForm({
  user,
  onDone,
}: {
  user: UserDto;
  onDone: () => void;
}) {
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");

  const [firstName, setFirstName] = useState(user.first_name);
  const [lastName, setLastName] = useState(user.last_name);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    first_name?: string;
    last_name?: string;
  }>({});

  const mutation = useUpdateCurrentUser();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const payload: { first_name?: string; last_name?: string } = {};
    if (firstName.trim() !== user.first_name) {
      payload.first_name = firstName.trim();
    }
    if (lastName.trim() !== user.last_name) {
      payload.last_name = lastName.trim();
    }
    if (Object.keys(payload).length === 0) {
      onDone();
      return;
    }

    try {
      await mutation.mutateAsync(payload);
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        const fe: { first_name?: string; last_name?: string } = {};
        for (const [field, codes] of Object.entries(err.fieldErrors)) {
          if (Array.isArray(codes) && codes.length > 0) {
            if (field === "first_name" || field === "last_name") {
              fe[field] = translateCode(tErrors, String(codes[0]));
            } else {
              setError(translateCode(tErrors, String(codes[0])));
            }
          }
        }
        setFieldErrors(fe);
        if (!fe.first_name && !fe.last_name && !error) {
          setError(tErrors("generic"));
        }
      } else {
        setError(tErrors("generic"));
      }
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 border-t border-ink-100 pt-4"
      noValidate
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-700">
            {tSettings("profile.first_name")}
          </span>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            required
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
          {fieldErrors.first_name ? (
            <span className="text-xs font-medium text-danger">
              {fieldErrors.first_name}
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-ink-700">
            {tSettings("profile.last_name")}
          </span>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            required
            className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
          />
          {fieldErrors.last_name ? (
            <span className="text-xs font-medium text-danger">
              {fieldErrors.last_name}
            </span>
          ) : null}
        </label>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger ring-1 ring-inset ring-danger/20"
        >
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          onClick={onDone}
          isDisabled={mutation.isPending}
        >
          <X className="h-4 w-4" />
          {tSettings("profile.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          isDisabled={mutation.isPending || !firstName.trim() || !lastName.trim()}
        >
          <Check className="h-4 w-4" />
          {tSettings("profile.save")}
        </Button>
      </div>
    </form>
  );
}
