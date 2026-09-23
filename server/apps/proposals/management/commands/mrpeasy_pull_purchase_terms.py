"""Sync real vendor + item purchase pricing from an MRPEasy tenant
into the PSP sandbox database.

Rationale
=========

PSP was populated with pharmaceutical-style test data (random
vendor costs, made-up MOQs, etc.) that mislead any operator
looking at the sandbox catalogue for spec-sheet costing. This
command replaces that noise with the real numbers from the
tenant's active MRPEasy account:

    * `vendors`                  — one row per MRPEasy vendor that
      shows up as the primary supplier on at least one item.

    * `vendor_item_prices`       — one row per (item, vendor) with
      the current MRPEasy cost + currency.

    * `vendor_item_purchase_terms` — one row per (item, vendor)
      capturing the vendor's stated lead time. MOQ / discount
      tiers are not exposed by MRPEasy REST v1, so those columns
      stay null / default and the operator can top them up in
      the PSP UI as they get real quotes.

Only items whose PSP `external_sku` matches an MRPEasy `code`
are touched. Items with no SKU or no MRPEasy match are left
alone (never nuked) so a partial MRPEasy catalogue never
silently orphans PSP rows.

Idempotent — repeated runs upsert. Rate-limited to stay under
MRPEasy's per-tenant ceiling.

Usage
=====

    ./manage.py mrpeasy_pull_purchase_terms \\
        --psp-db-url "postgres://.../psp?sslmode=require" \\
        --org-id 94d5249c-ce8e-427d-912a-17b79f263ee7 \\
        [--dry-run] [--limit 100]

The `--psp-db-url` argument is deliberate — vita-cff has no
in-process client to PSP; we open a psycopg connection to the
sibling database directly. Sandbox targets pass the sandbox
Postgres URL; a hypothetical prod target would pass prod PSP.

`--dry-run` skips every write and prints the exact upsert plan
against the resolved matches. Use it once before every real run.

`--limit N` caps the number of PSP items processed — cheap way
to smoke-test on the first hundred rows without waiting for the
whole crawl.
"""

from __future__ import annotations

import logging
import time
from decimal import Decimal
from typing import Any

import psycopg
from django.core.management.base import BaseCommand, CommandError

from apps.organizations.models import Organization
from apps.proposals.mrpeasy import (
    MrpeasyDecryptionFailed,
    MrpeasyError,
    _decode_config,
    get_client,
)

logger = logging.getLogger(__name__)

# MRPEasy stores currency as a symbol on ``purchase_terms[].currency``
# (``£`` / ``$`` / ``€`` / …) and PSP expects the ISO-4217 code.
# Extend when a new tenant introduces a fourth currency.
_CURRENCY_SYMBOL_TO_ISO = {
    "£": "GBP",
    "€": "EUR",
    "$": "USD",
    "¥": "JPY",
    "₺": "TRY",
    "₹": "INR",
}


def _symbol_to_iso(symbol: str | None, default: str = "GBP") -> str:
    if not symbol:
        return default
    return _CURRENCY_SYMBOL_TO_ISO.get(symbol.strip(), default)


class Command(BaseCommand):
    help = (
        "Sync vendors + item costs + lead times from MRPEasy into a "
        "PSP database. Matches on PSP items.external_sku ↔ MRPEasy "
        "item.code. Idempotent."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--psp-db-url",
            required=True,
            help=(
                "Full Postgres URL for the target PSP database "
                "(e.g. `postgres://user:pw@host/psp?sslmode=require`)."
            ),
        )
        parser.add_argument(
            "--org-id",
            required=True,
            help=(
                "UUID of the vita-cff organization whose stored "
                "MRPEasy credentials to use for the crawl."
            ),
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            default=False,
            help=(
                "Skip every write. Prints per-item match/insert plans "
                "so the operator can eyeball the resolution before "
                "committing anything."
            ),
        )
        parser.add_argument(
            "--limit",
            type=int,
            default=None,
            help=(
                "Cap the number of PSP items processed. Useful for a "
                "quick smoke test before a full-catalogue run."
            ),
        )
        parser.add_argument(
            "--rate-delay-ms",
            type=int,
            default=100,
            help=(
                "Sleep between MRPEasy pagination calls to stay under "
                "the tenant rate ceiling. Default 100ms."
            ),
        )

    def handle(self, *args: Any, **opts: Any) -> None:
        org_id: str = opts["org_id"]
        psp_url: str = opts["psp_db_url"]
        dry_run: bool = opts["dry_run"]
        limit: int | None = opts["limit"]
        rate_delay_s: float = max(0.0, opts["rate_delay_ms"] / 1000.0)

        # `.only(...)` — the vita-cff Organization model has fields
        # (e.g. `psp_config`) that a fresh sandbox has but an older
        # prod schema may not, and Django's ORM tries to hydrate the
        # full row by default. Selecting just the columns we actually
        # need keeps this command portable against any migration
        # state the caller points at.
        try:
            org = Organization.objects.only(
                "id", "name", "mrpeasy_config"
            ).get(pk=org_id)
        except Organization.DoesNotExist as exc:
            raise CommandError(f"Organization {org_id!r} not found.") from exc

        raw = dict(org.mrpeasy_config or {})
        if not raw.get("enabled"):
            raise CommandError(
                f"MRPEasy is not enabled on organization {org.name!r}."
            )

        try:
            config = _decode_config(raw)
        except MrpeasyDecryptionFailed as exc:
            raise CommandError(
                "Could not decrypt the stored MRPEasy secret — check "
                "DJANGO_SECRET_KEY matches what encrypted it."
            ) from exc

        client = get_client(config)

        self.stdout.write(
            self.style.NOTICE(
                f"[mrpeasy-pull] tenant OK. crawling items… (org={org.name})"
            )
        )

        # Materialise both catalogues once. Vendors is small (<1k
        # typically); items can be up to ~10k which is still fine as
        # a dict lookup.
        vendors_by_code: dict[str, Any] = {}
        for v in client.list_all_vendors():
            if v.code:
                vendors_by_code[v.code] = v
        self.stdout.write(
            self.style.NOTICE(
                f"[mrpeasy-pull] vendors from MRPEasy: {len(vendors_by_code)}"
            )
        )

        items_by_code: dict[str, Any] = {}
        for i, item in enumerate(client.iter_all_items()):
            if item.code:
                items_by_code[item.code] = item
            if rate_delay_s and i % 100 == 99:
                time.sleep(rate_delay_s)
        self.stdout.write(
            self.style.NOTICE(
                f"[mrpeasy-pull] items from MRPEasy: {len(items_by_code)}"
            )
        )

        # Open PSP DB and match.
        matched = 0
        no_sku = 0
        no_match = 0
        vendor_inserts: dict[str, int] = {}  # ven_code -> psp vendor id
        price_upserts = 0
        term_upserts = 0

        with psycopg.connect(psp_url, autocommit=False) as psp:
            # PSP items keyed by external_sku (the MRPEasy code).
            with psp.cursor() as cur:
                cur.execute(
                    "SELECT id, external_sku, company_id "
                    "FROM items "
                    "WHERE external_sku IS NOT NULL "
                    "  AND external_sku <> '' "
                    + ("LIMIT %s" if limit else ""),
                    (limit,) if limit else (),
                )
                psp_items = cur.fetchall()

            self.stdout.write(
                self.style.NOTICE(
                    f"[mrpeasy-pull] PSP items with external_sku: "
                    f"{len(psp_items)}"
                )
            )

            for psp_item_id, sku, company_id in psp_items:
                if not sku:
                    no_sku += 1
                    continue

                mrp_item = items_by_code.get(sku)
                if mrp_item is None:
                    no_match += 1
                    continue

                matched += 1
                if not mrp_item.purchase_terms:
                    # Item matched but has no purchase terms in
                    # MRPEasy — leave PSP as-is, no writes.
                    continue

                # One item can have many purchase terms (one per
                # vendor + tier). Walk each and upsert into PSP.
                for term in mrp_item.purchase_terms:
                    ven_code = term.vendor_code
                    if not ven_code:
                        continue

                    # Resolve vendor into PSP — insert on first sight
                    # of this vendor code within this run. PSP
                    # vendors are keyed by ``(company_id, name)``;
                    # MRPEasy's vendor code has no direct column in
                    # PSP so we key on the human name and cache the
                    # lookup by MRPEasy code for the rest of this run.
                    psp_vendor_id = vendor_inserts.get(ven_code)
                    if psp_vendor_id is None:
                        vendor_name = (term.vendor_title or ven_code).strip()
                        if dry_run:
                            psp_vendor_id = -1  # sentinel — no writes
                            self.stdout.write(
                                f"  [dry-run] UPSERT vendor "
                                f"code={ven_code!r} name={vendor_name!r}"
                            )
                        else:
                            with psp.cursor() as cur:
                                cur.execute(
                                    "INSERT INTO vendors "
                                    "  (company_id, name, "
                                    "   inserted_at, updated_at) "
                                    "VALUES (%s, %s, NOW(), NOW()) "
                                    "ON CONFLICT (company_id, name) "
                                    "DO UPDATE SET updated_at = NOW() "
                                    "RETURNING id",
                                    (company_id, vendor_name),
                                )
                                psp_vendor_id = cur.fetchone()[0]
                        vendor_inserts[ven_code] = psp_vendor_id

                    price = term.price
                    currency = _symbol_to_iso(
                        term.currency_symbol, default="GBP"
                    )
                    lead = term.lead_time_days
                    moq = term.min_quantity

                    if price is None:
                        # Both PSP tables require ``price`` NOT NULL;
                        # a term with no numeric price can't be
                        # persisted. Log it so the operator can spot
                        # the pattern and fix upstream.
                        self.stdout.write(
                            f"  skip: item={sku!r} vendor={ven_code!r} "
                            "no price on term"
                        )
                        continue

                    if dry_run:
                        self.stdout.write(
                            f"  [dry-run] UPSERT price "
                            f"item={sku!r} vendor={ven_code!r} "
                            f"price={price} {currency}"
                        )
                        self.stdout.write(
                            f"  [dry-run] UPSERT purchase_terms "
                            f"item={sku!r} vendor={ven_code!r} "
                            f"price={price} {currency} "
                            f"lead={lead if lead is not None else '-'}d "
                            f"moq={moq if moq is not None else '-'}"
                        )
                    else:
                        with psp.cursor() as cur:
                            cur.execute(
                                "INSERT INTO vendor_item_prices "
                                "  (company_id, vendor_id, item_id, "
                                "   currency_code, unit_price, "
                                "   qty_purchased, last_paid_at, "
                                "   inserted_at, updated_at) "
                                "VALUES (%s, %s, %s, %s, %s, "
                                "        0, NOW(), NOW(), NOW()) "
                                "ON CONFLICT "
                                "  (company_id, vendor_id, item_id, currency_code) "
                                "DO UPDATE SET "
                                "  unit_price = EXCLUDED.unit_price, "
                                "  updated_at = NOW()",
                                (
                                    company_id,
                                    psp_vendor_id,
                                    psp_item_id,
                                    currency,
                                    price,
                                ),
                            )
                            cur.execute(
                                "INSERT INTO vendor_item_purchase_terms "
                                "  (company_id, vendor_id, item_id, "
                                "   price, currency_code, "
                                "   lead_time_days, min_quantity, "
                                "   vendor_part_no, "
                                "   priority, "
                                "   inserted_at, updated_at) "
                                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, "
                                "        COALESCE(%s, 1), "
                                "        NOW(), NOW()) "
                                "ON CONFLICT "
                                "  (company_id, vendor_id, item_id) "
                                "DO UPDATE SET "
                                "  price = EXCLUDED.price, "
                                "  currency_code = EXCLUDED.currency_code, "
                                "  lead_time_days = EXCLUDED.lead_time_days, "
                                "  min_quantity = EXCLUDED.min_quantity, "
                                "  vendor_part_no = EXCLUDED.vendor_part_no, "
                                "  priority = EXCLUDED.priority, "
                                "  updated_at = NOW()",
                                (
                                    company_id,
                                    psp_vendor_id,
                                    psp_item_id,
                                    price,
                                    currency,
                                    lead,
                                    moq,
                                    term.vendor_product_code,
                                    term.priority,
                                ),
                            )
                        price_upserts += 1
                        term_upserts += 1

            if dry_run:
                psp.rollback()
                self.stdout.write(
                    self.style.WARNING(
                        "[mrpeasy-pull] dry-run: rolled back, no writes."
                    )
                )
            else:
                psp.commit()

        self.stdout.write(
            self.style.SUCCESS(
                f"[mrpeasy-pull] done — "
                f"matched={matched} no_sku={no_sku} no_match={no_match} "
                f"vendors={len(vendor_inserts)} "
                f"prices={price_upserts} terms={term_upserts}"
            )
        )
