"use client";

/**
 * Rendered proposal contract — the single HTML document both staff
 * and client (on the kiosk) read and sign. Replaces the DOCX→PDF
 * iframe so the preview is instant, mobile-friendly, print-friendly,
 * and updates the moment a field changes.
 *
 * The wording mirrors the canonical "Ready to Go" Word template
 * byte-for-byte so a client comparing the old DOCX version to the
 * new HTML version sees no copy drift. Data-driven placeholders
 * (customer block, line items, totals, reference, dear name,
 * sales-person sign-off) are filled from :type:`ProposalDto`; the
 * static legal clauses (Timelines, Conditions, Offer Validity, Raw
 * Materials, Stability, Legality, Terms, Closing, Acceptance) live
 * in the ``proposals.contract`` i18n bundle so they can be
 * translated without touching component code.
 *
 * Print styles: callers stack on a ``.print-document`` container so
 * ``window.print()`` emits one clean document per page without the
 * surrounding app chrome.
 */

import { useTranslations } from "next-intl";

import type {
  ProposalCustomerSignature,
  ProposalDto,
  ProposalLineDto,
  ProposalSignatureSlot,
} from "@/services/proposals";

import { InlineSignatureBlock } from "./inline-signature-block";


interface Props {
  readonly proposal: ProposalDto;
  /** When provided, renders an interactive signature pad in the
   *  customer signature slot and invokes with the captured data URL.
   *  Omit on the staff preview to render a read-only placeholder. */
  readonly onCustomerSign?: (dataUrl: string) => Promise<void> | void;
  readonly customerBusy?: boolean;
  readonly customerError?: string | null;
  /** Disable the customer signature pad — used when the bundle has
   *  already been finalized (``status === "accepted"``) so an
   *  extra redraw can't be captured after acceptance. */
  readonly customerLocked?: boolean;
}


export function ProposalContract({
  proposal,
  onCustomerSign,
  customerBusy = false,
  customerError = null,
  customerLocked = false,
}: Props) {
  const tProposals = useTranslations("proposals.contract");
  const tCommon = useTranslations("common");

  const currency = proposal.currency || "GBP";
  const formatMoney = (value: string | null | undefined) =>
    value ? formatDecimal(value) : "—";

  const greetingName = proposal.dear_name?.trim() || "";
  const signerName =
    proposal.effective_sales_person_name ||
    proposal.sales_person_name ||
    tProposals("closing.default_signer");

  return (
    <article className="flex flex-col gap-6 rounded-2xl bg-ink-0 p-6 shadow-sm ring-1 ring-ink-200 print:shadow-none print:ring-0 md:p-10">
      {/* ------------------------------------------------------------------ */}
      {/* Title block                                                         */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-200 pb-6">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">
            {tProposals("document_label")}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink-1000 md:text-3xl">
            {proposal.code}
          </h1>
          <p className="text-sm text-ink-600">
            {proposal.formulation_name} · v{proposal.formulation_version_number}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-right text-xs text-ink-600">
          {proposal.reference ? (
            <span>
              <span className="text-ink-500">
                {tProposals("field.reference")}:{" "}
              </span>
              <span className="font-medium text-ink-1000">
                {proposal.reference}
              </span>
            </span>
          ) : null}
          {proposal.valid_until ? (
            <span>
              <span className="text-ink-500">
                {tProposals("field.valid_until")}:{" "}
              </span>
              <span className="font-medium text-ink-1000">
                {formatDate(proposal.valid_until)}
              </span>
            </span>
          ) : null}
          <span className="text-ink-500">
            {tProposals("field.issued", {
              date: formatDate(proposal.created_at),
            })}
          </span>
        </div>
      </header>

      <p className="text-sm leading-relaxed text-ink-700">
        {tProposals("intro")}
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* Customer Information                                                */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
          {tProposals("customer_info.title")}
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-xl bg-ink-50 p-4 text-sm ring-1 ring-inset ring-ink-200 sm:grid-cols-2 print:bg-transparent print:ring-0">
          <InfoRow
            label={tProposals("customer_info.name")}
            value={proposal.customer_name}
          />
          <InfoRow
            label={tProposals("customer_info.email")}
            value={proposal.customer_email}
          />
          <InfoRow
            label={tProposals("customer_info.phone")}
            value={proposal.customer_phone}
          />
          <InfoRow
            label={tProposals("customer_info.company")}
            value={proposal.customer_company}
          />
          <InfoRow
            label={tProposals("customer_info.invoice_address")}
            value={proposal.invoice_address}
            wide
          />
          <InfoRow
            label={tProposals("customer_info.delivery_address")}
            value={proposal.delivery_address}
            wide
          />
        </dl>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Cover letter                                                        */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3 text-sm leading-relaxed text-ink-800">
        <p className="font-medium">
          {tProposals("field.reference")}: {proposal.code}
          {proposal.reference ? ` – ${proposal.reference}` : ""}
        </p>
        <p>
          {greetingName
            ? tProposals("greeting", { name: greetingName })
            : tProposals("greeting_fallback")}
        </p>
        <p>{tProposals("preamble_1")}</p>
        <p>{tProposals("preamble_2")}</p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Timelines                                                           */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
          {tProposals("timelines.title")}
        </h2>
        <p className="text-sm text-ink-700">
          {tProposals("timelines.lead_time")}
        </p>
        <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-ink-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-50 text-[11px] uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2">
                  {tProposals("timelines.col_phase")}
                </th>
                <th className="px-3 py-2">
                  {tProposals("timelines.col_duration")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              <TimelineRow
                phase={tProposals("timelines.rows.reception")}
                duration={tProposals("timelines.rows.reception_duration")}
              />
              <TimelineRow
                phase={tProposals("timelines.rows.manufacturing")}
                duration={tProposals("timelines.rows.manufacturing_duration")}
              />
              <TimelineRow
                phase={tProposals("timelines.rows.qa")}
                duration={tProposals("timelines.rows.qa_duration")}
              />
              <TimelineRow
                phase={tProposals("timelines.rows.delivery")}
                duration={tProposals("timelines.rows.delivery_duration")}
              />
            </tbody>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Commercial price                                                    */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <p className="text-sm text-ink-700">{tProposals("pricing_intro")}</p>
        <div className="overflow-hidden rounded-xl ring-1 ring-inset ring-ink-200">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-50 text-[11px] uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-3 py-2">{tProposals("lines.col_code")}</th>
                <th className="px-3 py-2">
                  {tProposals("lines.col_description")}
                </th>
                <th className="px-3 py-2 text-right">
                  {tProposals("lines.col_qty")}
                </th>
                <th className="px-3 py-2 text-right">
                  {tProposals("lines.col_unit_price", { currency })}
                </th>
                <th className="px-3 py-2 text-right">
                  {tProposals("lines.col_subtotal")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {proposal.lines.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-4 text-center text-ink-500"
                  >
                    {tProposals("lines.empty")}
                  </td>
                </tr>
              ) : (
                proposal.lines.map((line) => (
                  <LineRow
                    key={line.id}
                    line={line}
                    formatMoney={formatMoney}
                  />
                ))
              )}
            </tbody>
            <tfoot className="bg-ink-50 text-sm text-ink-700">
              <tr>
                <td colSpan={4} className="px-3 py-2 text-right font-medium">
                  {tProposals("totals.subtotal")}
                </td>
                <td className="px-3 py-2 text-right font-semibold text-ink-1000">
                  {formatMoney(proposal.subtotal)} {currency}
                </td>
              </tr>
              {proposal.freight_amount ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-2 text-right font-medium"
                  >
                    {tProposals("totals.freight")}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-ink-1000">
                    {formatMoney(proposal.freight_amount)} {currency}
                  </td>
                </tr>
              ) : null}
              <tr>
                <td colSpan={4} className="px-3 py-2 text-right font-medium">
                  {tProposals("totals.total_excl_vat")}
                </td>
                <td className="px-3 py-2 text-right text-base font-semibold text-ink-1000">
                  {formatMoney(proposal.total_excl_vat)} {currency}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Conditions                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-1000">
          {tProposals("conditions.title")}
        </h2>
        <ul className="list-disc space-y-1 pl-6 text-sm text-ink-700">
          <li>{tProposals("conditions.delivery")}</li>
          <li>{tProposals("conditions.payment")}</li>
          <li>{tProposals("conditions.no_other_services")}</li>
        </ul>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Offer Validity and Pricing                                          */}
      {/* ------------------------------------------------------------------ */}
      <LegalSection
        title={tProposals("offer_validity.title")}
        paragraphs={[tProposals("offer_validity.body")]}
      />

      <LegalSection
        title={tProposals("raw_materials.title")}
        paragraphs={[
          tProposals("raw_materials.body_1"),
          tProposals("raw_materials.body_2"),
        ]}
      />

      <LegalSection
        title={tProposals("stability.title")}
        paragraphs={[tProposals("stability.body")]}
      />

      <LegalSection
        title={tProposals("legality.title")}
        paragraphs={[tProposals("legality.body")]}
      />

      <LegalSection
        title={tProposals("terms.title")}
        paragraphs={[
          tProposals("terms.body_1"),
          tProposals("terms.body_2"),
          tProposals("terms.body_3"),
        ]}
      />

      <p className="text-sm leading-relaxed text-ink-700">
        {tProposals("terms.vat")}
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* Cover notes (proposal-specific addenda)                             */}
      {/* ------------------------------------------------------------------ */}
      {proposal.cover_notes ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
            {tProposals("cover_notes")}
          </h2>
          <p className="whitespace-pre-wrap rounded-xl bg-ink-50 p-4 text-sm leading-relaxed text-ink-700 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
            {proposal.cover_notes}
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Closing                                                             */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-1 text-sm leading-relaxed text-ink-800">
        <p>{tProposals("closing.help")}</p>
        <p className="mt-2">{tProposals("closing.sign_off")}</p>
        <p className="font-medium text-ink-1000">{signerName}</p>
        <p className="text-ink-700">{tProposals("closing.team_line")}</p>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Acceptance acknowledgments                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="flex flex-col gap-2 rounded-xl border border-ink-200 p-4 print:border-ink-400">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-700">
          {tProposals("acceptance.title")}
        </h2>
        <p className="text-xs text-ink-600">
          {tProposals("acceptance.intro")}
        </p>
        <ul className="flex flex-col gap-2 text-sm leading-relaxed text-ink-800">
          <AcknowledgeItem text={tProposals("acceptance.item_1")} />
          <AcknowledgeItem text={tProposals("acceptance.item_2")} />
          <AcknowledgeItem text={tProposals("acceptance.item_3")} />
        </ul>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Signatures                                                          */}
      {/* ------------------------------------------------------------------ */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <ReadOnlySignature
          title={tProposals("signature.prepared_by")}
          slot={proposal.prepared_by}
          emptyLabel={tProposals("signature.awaiting")}
        />
        <ReadOnlySignature
          title={tProposals("signature.director")}
          slot={proposal.director}
          emptyLabel={tProposals("signature.awaiting")}
        />
        <CustomerSignatureSlot
          title={tProposals("signature.customer")}
          signature={proposal.customer_signature}
          onSign={onCustomerSign}
          busy={customerBusy}
          error={customerError}
          locked={customerLocked}
          tProposals={tProposals}
          tCommon={tCommon}
        />
      </section>
    </article>
  );
}


function InfoRow({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | null | undefined;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "sm:col-span-2" : ""}>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        {label}
      </dt>
      <dd className="whitespace-pre-wrap text-sm text-ink-1000">
        {value?.trim() ? value : "—"}
      </dd>
    </div>
  );
}


function TimelineRow({
  phase,
  duration,
}: {
  phase: string;
  duration: string;
}) {
  return (
    <tr className="text-ink-800">
      <td className="px-3 py-2">{phase}</td>
      <td className="px-3 py-2 text-ink-700">{duration}</td>
    </tr>
  );
}


function LineRow({
  line,
  formatMoney,
}: {
  line: ProposalLineDto;
  formatMoney: (value: string | null | undefined) => string;
}) {
  return (
    <tr className="text-ink-800">
      <td className="px-3 py-2 font-mono text-xs text-ink-1000">
        {line.product_code || "—"}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col">
          <span className="text-sm text-ink-1000">
            {line.description || line.formulation_name || ""}
          </span>
          {line.formulation_name && line.description ? (
            <span className="text-[11px] text-ink-500">
              {line.formulation_name}
              {line.formulation_version_number
                ? ` · v${line.formulation_version_number}`
                : ""}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{line.quantity}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {formatMoney(line.unit_price)}
      </td>
      <td className="px-3 py-2 text-right font-medium tabular-nums text-ink-1000">
        {formatMoney(line.subtotal)}
      </td>
    </tr>
  );
}


function LegalSection({
  title,
  paragraphs,
}: {
  title: string;
  paragraphs: readonly string[];
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink-1000">{title}</h2>
      <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink-700">
        {paragraphs.map((body, idx) => (
          <p key={idx}>{body}</p>
        ))}
      </div>
    </section>
  );
}


function AcknowledgeItem({ text }: { text: string }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border border-ink-400 text-[10px] font-semibold text-ink-600 print:border-ink-700"
      >
        ✓
      </span>
      <span>{text}</span>
    </li>
  );
}


function ReadOnlySignature({
  title,
  slot,
  emptyLabel,
}: {
  title: string;
  slot: ProposalSignatureSlot | null;
  emptyLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-ink-0 p-4 ring-1 ring-inset ring-ink-200 print:bg-transparent">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500">
        {title}
      </p>
      {slot ? (
        <>
          <div className="flex h-24 items-center justify-center rounded-lg bg-ink-50 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
            {slot.image ? (
              <img
                src={slot.image}
                alt={title}
                className="max-h-20 max-w-full object-contain"
              />
            ) : (
              <span className="text-xs text-ink-500">—</span>
            )}
          </div>
          <p className="text-xs font-medium text-ink-1000">{slot.name}</p>
          <p className="text-[11px] text-ink-500">
            {formatDate(slot.signed_at)}
          </p>
        </>
      ) : (
        <div className="flex h-24 items-center justify-center rounded-lg bg-ink-50 text-xs text-ink-500 ring-1 ring-inset ring-ink-200 print:bg-transparent print:ring-0">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}


function CustomerSignatureSlot({
  title,
  signature,
  onSign,
  busy,
  error,
  locked,
  tProposals,
  tCommon,
}: {
  title: string;
  signature: ProposalCustomerSignature | null;
  onSign: ((dataUrl: string) => Promise<void> | void) | undefined;
  busy: boolean;
  error: string | null;
  locked: boolean;
  tProposals: ReturnType<typeof useTranslations<"proposals.contract">>;
  tCommon: ReturnType<typeof useTranslations<"common">>;
}) {
  // Staff preview — render signature if captured, otherwise a placeholder.
  if (!onSign) {
    return (
      <ReadOnlySignature
        title={title}
        slot={
          signature
            ? {
                name:
                  signature.name ||
                  signature.company ||
                  signature.email ||
                  "—",
                signed_at: signature.signed_at,
                image: signature.image,
              }
            : null
        }
        emptyLabel={tProposals("signature.awaiting")}
      />
    );
  }

  return (
    <InlineSignatureBlock
      title={title}
      hint={tProposals("signature.customer_hint")}
      signedLabel={tProposals("signature.signed_badge")}
      signedOnLabel={(iso) =>
        tProposals("signature.signed_on", { date: formatDate(iso) })
      }
      signBtnLabel={tProposals("signature.sign_cta")}
      resignBtnLabel={tProposals("signature.resign_cta")}
      clearBtnLabel={tCommon("actions.cancel")}
      busy={busy}
      errorMessage={error}
      capturedImage={signature?.image ?? null}
      capturedAt={signature?.signed_at ?? null}
      capturedName={signature?.name ?? null}
      locked={locked}
      onSign={onSign}
    />
  );
}


function formatDecimal(value: string): string {
  // Strip trailing zeros on whole-number prices so "1500.0000"
  // renders as "1,500" without dragging in a full i18n library.
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  return num.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(num) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}


function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
