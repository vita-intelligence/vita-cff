/**
 * Transport types for the PSP integration.
 *
 * Mirrors the backend ``apps.psp.services.serialize_psp_config_for_api``
 * shape + the item picker's response envelopes. Plaintext integration
 * token is never on the wire — the form uses ``has_token`` to decide
 * between "paste a new token" and "●●●●●●● (stored — leave blank to
 * keep)".
 */


export interface PspConfigDto {
  readonly enabled: boolean;
  readonly base_url: string;
  /** True when the org has a stored PSP integration token. Drives
   *  the "Connected — last tested …" badge + the Test button's
   *  enabled state on the settings card. Plaintext value never
   *  returned. */
  readonly has_token: boolean;
  /** ISO timestamp of the last successful "Test connection"
   *  round-trip. ``null`` when never tested (or when the token
   *  was rotated since). */
  readonly last_tested_at: string | null;
}


export interface SavePspConfigRequestDto {
  readonly enabled: boolean;
  readonly base_url: string;
  /** Plaintext integration token. ``null`` (or empty string) is
   *  the "keep the existing stored token" sentinel — the backend
   *  preserves whatever's already on file so the operator can
   *  change the URL without re-pasting the token. */
  readonly integration_token?: string | null;
}


/** One PSP item on the picker read surface. Mirrors PSP's own
 *  ``GET /api/integration/items`` row shape verbatim so the NPD
 *  proxy is transparent — same wire format on both sides.
 *
 *  ``selling_price`` and ``currency_code`` are ``null`` when PSP
 *  has no active default pricelist OR the item has no row on it.
 *  The picker renders "no PSP price" for both cases identically. */
export interface PspItemDto {
  readonly uuid: string;
  readonly name: string;
  readonly description: string;
  readonly item_type: string;
  readonly external_sku: string;
  /** System-generated display code (``MA00295``) — PSP renders
   *  this from the item's integer PK against the company's
   *  numbering format. Every item has one by default; picker /
   *  BOM prefers this over ``external_sku`` since suppliers'
   *  codes are optional. */
  readonly code: string;
  readonly barcode: string;
  readonly is_active: boolean;
  /** From PSP's ``attributes.use_as``. Filters the ingredient
   *  pickers in NPD's builder (flavouring / colour / gummy_base /
   *  …). ``null`` when the row carries no such attribute. */
  readonly use_as: string | null;
  readonly product_family: {
    readonly uuid: string;
    readonly name: string;
  } | null;
  /** Decimal-as-string (matches every other Decimal on the wire so
   *  the FE's price-math layer can treat all sources identically). */
  readonly selling_price: string | null;
  readonly currency_code: string | null;
  /** Full PSP attributes map — carries the compute-critical keys
   *  the mirror needs (``purity``, ``overage``, ``extract_ratio``,
   *  allergen flags, country of origin, …). Empty ``{}`` when the
   *  row has no attributes recorded. ``use_as`` above is exposed as
   *  a flat field for backward compat with early picker code that
   *  reads only the projection. */
  readonly attributes: Readonly<Record<string, unknown>>;
}


export interface PspItemListResponseDto {
  readonly items: readonly PspItemDto[];
}


/** Discriminated union — ``matched: false`` is the silent degrade
 *  shape (integration off, PSP outage, item not found on the PSP
 *  side). Picker code branches on ``matched`` to decide between
 *  rendering the item's suggested price + "Use" button OR a
 *  quiet "no PSP match" explainer. */
export type PspItemLookupResultDto =
  | { readonly matched: true; readonly item: PspItemDto }
  | { readonly matched: false; readonly uuid: string };


/** Response shape from ``POST /integrations/psp/items/<uuid>/mirror/``.
 *  Mirrors the local ``catalogues.Item`` DTO so the builder can hand
 *  it to the existing ``addIngredient(item)`` flow verbatim — no
 *  branching on source needed downstream. ``psp_source_uuid``
 *  identifies the PSP item this mirror row was seeded from so a
 *  future refresh action can find its way back. */
export interface PspItemMirrorResponseDto {
  readonly id: string;
  readonly catalogue_id: string;
  readonly name: string;
  readonly internal_code: string;
  readonly unit: string;
  readonly base_price: string | null;
  readonly attributes: Record<string, unknown>;
  readonly is_archived: boolean;
  readonly psp_source_uuid: string | null;
}
