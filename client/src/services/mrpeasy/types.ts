/**
 * Transport types for the MRPEasy integration.
 *
 * Mirrors the backend ``serialize_mrpeasy_config_for_api`` shape +
 * the lookup view's response. Plaintext secret is never on the
 * wire — the form uses ``has_secret`` to decide between "type a
 * new password" and "●●●●●●● (stored — leave blank to keep)".
 */

export interface MrpeasyConfigDto {
  readonly enabled: boolean;
  readonly api_key: string;
  /** True when the org has a stored MRPEasy API secret. The
   *  plaintext value is never returned by the API. Drives the
   *  "Connected — last tested …" badge + the Test button's
   *  enabled state on the settings card. */
  readonly has_secret: boolean;
  /** ISO timestamp of the last successful "Test connection"
   *  round-trip, or ``null`` when never tested (or when the
   *  credentials were rotated since). */
  readonly last_tested_at: string | null;
}

export interface SaveMrpeasyConfigRequestDto {
  readonly enabled: boolean;
  readonly api_key: string;
  /** Plaintext secret. ``null`` (or empty string) is the
   *  "keep the existing stored secret" sentinel — the backend
   *  preserves whatever's already on file. */
  readonly api_secret?: string | null;
}

/**
 * Discriminated union — ``matched: false`` is the silent
 * degrade shape (integration off, code not in MRPEasy, lookup
 * failed). The price-hint component branches on the flag to
 * render either the suggested price + autofill button OR the
 * "no MRPEasy match for <code>" explainer.
 */
export type MrpeasyLookupResultDto =
  | {
      readonly matched: true;
      readonly code: string;
      readonly title: string;
      /** Decimal-as-string (matches every other DRF
       *  DecimalField response so the math layer can treat
       *  all price fields identically). */
      readonly selling_price: string;
      /** MRPEasy's internal numeric ID for the row. Powers
       *  the "Open in MRPEasy" deep link
       *  (``/articles/view/<product_id>``). ``null`` only if
       *  the API response omitted it — every observed real
       *  response carries it. */
      readonly product_id: number | null;
    }
  | {
      readonly matched: false;
      readonly code: string;
    };

/** One row in the MRPEasy item-list response — powers the
 *  new-project picker's typeahead. ``selling_price`` is the
 *  decimal-as-string from the backend; the empty string means
 *  MRPEasy has no price on file for the item (kept as string
 *  for type consistency, not ``null``). */
export interface MrpeasyItemDto {
  readonly code: string;
  readonly title: string;
  readonly selling_price: string;
  /** MRPEasy's internal numeric ID. May be ``null`` for
   *  responses that pre-date the projector capturing it; new
   *  callers should be defensive. */
  readonly product_id: number | null;
}

export interface MrpeasyItemListResponseDto {
  readonly items: readonly MrpeasyItemDto[];
}
