"use client";

import { Button } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { translateCode } from "@/lib/errors/translate";
import {
  useCreateValidation,
  useValidationForBatch,
} from "@/services/product_validation";


/**
 * "Start / Open validation" CTA on the trial-batch detail page.
 *
 * Queries the batch's validation existence client-side. When none
 * exists the button creates one in-place and routes to the new
 * page; when one does, it's a plain link so the user can peek at
 * the draft status from the URL (shareable to the R&D manager).
 */
export function ValidationLink({
  orgId,
  formulationId,
  batchId,
}: {
  orgId: string;
  formulationId: string;
  batchId: string;
}) {
  const tV = useTranslations("product_validation");
  const tErrors = useTranslations("errors");
  const router = useRouter();

  const existingQuery = useValidationForBatch(orgId, batchId);
  const createMutation = useCreateValidation(orgId);

  const isBusy = createMutation.isPending || existingQuery.isLoading;

  if (existingQuery.data) {
    const v = existingQuery.data;
    return (
      <Link
        href={`/formulations/${formulationId}/trial-batches/${batchId}/validation/${v.id}`}
        className="inline-flex items-center gap-1.5 rounded-lg bg-ink-0 px-3 py-2 text-sm font-medium text-ink-700 ring-1 ring-inset ring-ink-200 transition-colors hover:bg-ink-50"
      >
        <ShieldCheck className="h-4 w-4" />
        {tV("link.open")}
      </Link>
    );
  }

  const handleStart = async () => {
    try {
      const created = await createMutation.mutateAsync({
        trial_batch_id: batchId,
      });
      router.push(
        `/formulations/${formulationId}/trial-batches/${batchId}/validation/${created.id}`,
      );
    } catch (err) {
      const message =
        err instanceof ApiError
          ? translateCode(tErrors, firstErrorCode(err) ?? "generic")
          : tErrors("generic");
      // Surface via alert for now — the CTA is a single button,
      // a full inline error banner would be over-engineered.
      window.alert(message);
    }
  };

  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      className="rounded-lg bg-orange-500 px-3 py-2 font-medium text-ink-0 hover:bg-orange-600"
      isDisabled={isBusy}
      onClick={handleStart}
    >
      <span className="inline-flex items-center gap-1.5">
        <ShieldCheck className="h-4 w-4" />
        {tV("link.start")}
      </span>
    </Button>
  );
}


function firstErrorCode(error: ApiError): string | null {
  for (const codes of Object.values(error.fieldErrors)) {
    if (Array.isArray(codes) && codes.length > 0) {
      return String(codes[0]);
    }
  }
  return null;
}
