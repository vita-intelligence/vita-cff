"use client";

import { Button } from "@heroui/react";
import { Building2, Check, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type FormEvent } from "react";

import { Chip } from "@/components/ui/chip";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import { useUpdateOrganization } from "@/services/organizations";
import type { OrganizationDto } from "@/services/organizations/types";

import { CreateOrganizationCard } from "../../home/create-organization-card";


/**
 * Organization settings tab. Shows the org name + role chip, with an
 * inline rename form gated on ``is_owner``. Non-owner members see the
 * same card minus the Edit button — the backend enforces the rule too
 * so there's no path to bypass it from the UI.
 */
export function OrganizationTab({
  organization,
}: {
  organization: OrganizationDto | null;
}) {
  const tSettings = useTranslations("settings");

  if (organization === null) {
    return (
      <section className="flex flex-col gap-4">
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold text-ink-1000">
            {tSettings("organization.no_org_title")}
          </h2>
          <p className="mt-0.5 text-sm text-ink-500">
            {tSettings("organization.no_org_hint")}
          </p>
        </div>
        <CreateOrganizationCard />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-ink-1000">
          {tSettings("organization.section_title")}
        </h2>
        <p className="mt-0.5 text-sm text-ink-500">
          {tSettings("organization.section_subtitle")}
        </p>
      </div>

      <OrganizationCard organization={organization} />
    </section>
  );
}


function OrganizationCard({ organization }: { organization: OrganizationDto }) {
  const tSettings = useTranslations("settings");

  const [isEditing, setIsEditing] = useState(false);

  return (
    <article className="flex flex-col gap-5 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200">
      <div className="flex items-center gap-4">
        <div
          aria-hidden
          className="flex h-14 w-14 items-center justify-center rounded-2xl bg-ink-1000 text-ink-0"
        >
          <Building2 className="h-6 w-6" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold text-ink-1000">
            {organization.name}
          </p>
          <p className="mt-0.5 text-sm text-ink-500">
            {tSettings("organization.name")}
          </p>
        </div>
        {organization.is_owner && !isEditing ? (
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-ink-0 px-3 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
          >
            <Pencil className="h-3.5 w-3.5" />
            {tSettings("organization.edit")}
          </button>
        ) : null}
      </div>

      {isEditing ? (
        <EditNameForm
          organization={organization}
          onDone={() => setIsEditing(false)}
        />
      ) : null}

      <dl className="grid grid-cols-1 gap-4 border-t border-ink-100 pt-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tSettings("organization.role")}
          </dt>
          <dd>
            <Chip tone={organization.is_owner ? "orange" : "neutral"}>
              {organization.is_owner
                ? tSettings("organization.role_owner")
                : tSettings("organization.role_member")}
            </Chip>
          </dd>
        </div>
      </dl>
    </article>
  );
}


function EditNameForm({
  organization,
  onDone,
}: {
  organization: OrganizationDto;
  onDone: () => void;
}) {
  const tSettings = useTranslations("settings");
  const tErrors = useTranslations("errors");

  const [name, setName] = useState(organization.name);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const mutation = useUpdateOrganization(organization.id);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    const trimmed = name.trim();
    if (trimmed === organization.name) {
      onDone();
      return;
    }

    try {
      await mutation.mutateAsync({ name: trimmed });
      onDone();
    } catch (err) {
      if (err instanceof ApiError) {
        const nameErrors = err.fieldErrors.name;
        if (Array.isArray(nameErrors) && nameErrors.length > 0) {
          setFieldError(translateCode(tErrors, String(nameErrors[0])));
        } else {
          for (const codes of Object.values(err.fieldErrors)) {
            if (Array.isArray(codes) && codes.length > 0) {
              setError(translateCode(tErrors, String(codes[0])));
              break;
            }
          }
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
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-700">
          {tSettings("organization.name")}
        </span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={150}
          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none focus:ring-2 focus:ring-orange-400"
        />
        {fieldError ? (
          <span className="text-xs font-medium text-danger">{fieldError}</span>
        ) : null}
      </label>

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
          {tSettings("organization.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          size="md"
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-orange-500 px-4 text-sm font-medium text-ink-0 hover:bg-orange-600"
          isDisabled={mutation.isPending || !name.trim()}
        >
          <Check className="h-4 w-4" />
          {tSettings("organization.save")}
        </Button>
      </div>
    </form>
  );
}
