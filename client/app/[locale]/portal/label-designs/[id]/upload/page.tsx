"use client";

import { use, useState } from "react";
import { UploadCloud } from "lucide-react";

import {
  Card,
  Eyebrow,
  PageHeader,
  PortalShell,
} from "@/components/portal/brutalist";
import { SignatureField } from "@/components/ui/signature-field";
import { useRouter } from "@/i18n/navigation";
import { usePortalUploadArtwork } from "@/services/label-design";


export default function CustomerUploadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const upload = usePortalUploadArtwork(id);

  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError("Please choose a file.");
      return;
    }
    if (!signature) {
      setError("Please draw your signature to confirm this is your design.");
      return;
    }
    try {
      await upload.mutateAsync({
        artwork: file,
        signature_image: signature,
        notes,
      });
      router.replace(`/portal/label-designs/${id}`);
    } catch (e) {
      const detail =
        (e as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "Upload failed.";
      setError(detail);
    }
  };

  return (
    <PortalShell active="products">
      <PageHeader
        eyebrow="UPLOAD ARTWORK"
        title="Submit your label design"
        subtitle="Upload the finished artwork (PDF or PNG). Our scientist + director will review it for regulatory compliance."
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
            Artwork file
          </label>
          <input
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-2 block w-full text-sm"
          />
          {file ? (
            <p className="mt-2 text-xs text-neutral-500">
              {file.name} · {Math.round(file.size / 1024)} KB
            </p>
          ) : null}
        </Card>

        <Card>
          <label className="text-xs font-bold uppercase tracking-[0.15em] text-neutral-700">
            Notes for the reviewer (optional)
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="mt-2 w-full border-2 border-black px-2 py-1.5 text-sm"
          />
        </Card>

        <Card>
          <Eyebrow>DECLARATION</Eyebrow>
          <p className="mt-2 text-sm text-neutral-600">
            By submitting, you confirm that you authored this artwork and accept
            it as your approved design pending our regulatory review.
          </p>
          <div className="mt-3">
            <SignatureField
              label="Signature"
              value={signature}
              onChange={setSignature}
              ariaLabel="Customer signature"
              required
              tone="portal"
            />
          </div>
        </Card>

        {error ? (
          <p className="text-sm text-red-700">{error}</p>
        ) : null}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={upload.isPending}
            className="inline-flex items-center gap-2 border-2 border-black bg-black px-5 py-2 text-sm font-bold uppercase tracking-[0.18em] text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            <UploadCloud className="h-4 w-4" />
            {upload.isPending ? "Uploading…" : "Submit artwork"}
          </button>
        </div>
      </form>
    </PortalShell>
  );
}
