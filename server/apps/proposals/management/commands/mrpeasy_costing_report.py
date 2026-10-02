"""Volume costing report — how per-unit cost changes as order qty scales.

Walks a finished product's BOM chain in MRPEasy, pulls the best
purchase term for each leaf at every order tier, and back-fills the
fixed overhead (routing labour + QC + everything MRPEasy's avg_cost
captures that raw purchase terms don't) from an anchor tier where the
per-unit price is known.

Output: a markdown breakdown intended for the commercial + purchasing
teams to eyeball before quoting a volume-discounted price.

Usage
=====

    ./manage.py mrpeasy_costing_report \\
        --product-code MA213961 \\
        --anchor-price 6.06 \\
        [--anchor-tier 1000] \\
        [--tiers 1000,2000,3000,5000,10000,25000,50000,100000] \\
        [--org-id <UUID>] \\
        [--output ./costing_<code>_<ts>.md]

The command is READ-ONLY against MRPEasy — no writes, no DB mutations.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

from django.core.management.base import BaseCommand, CommandError

from apps.organizations.models import Organization
from apps.proposals.mrpeasy import (
    MrpeasyDecryptionFailed,
    _decode_config,
    get_client,
)

# Depth cap on BOM recursion. Anything deeper than this is treated as
# testing / shipping overhead that's already rolled into the parent
# ingredient's avg_cost, and is skipped from the tier maths.
MAX_BOM_DEPTH = 3

# Keyword-based classifier for BOM leaves. Order matters — labour
# rules are checked before packaging so "Sachet Filling" lands in
# LABOUR, not PACKAGING.
CATEGORY_RULES = [
    ("LABOUR", re.compile(
        r"\b("
        r"filling|labour|labor|packing|assembly|contract\s+(?:sachet|filling|labor)"
        r"|handling|sealing|printing|gluing|inspection\s+labor"
        r")\b", re.IGNORECASE)),
    ("QC_SHIPPING", re.compile(
        r"\b("
        r"test|testing|pesticide|micro(?:bio)?|heavy\s*metal|identification|"
        r"shipping|cif|sample|delivery|freight|import\s+duty|per\s+kg\s+from"
        r")\b", re.IGNORECASE)),
    ("PACKAGING", re.compile(
        r"\b("
        r"sachet|stickpack|box|bottle|cap|label|carton|pouch|tub|jar|lid|"
        r"shrink|sleeve|film|foil|wrap|bag|pack(?:aging)?|scoop|desiccant|"
        r"insert|leaflet"
        r")\b", re.IGNORECASE)),
]

# Static FX rates for normalising purchase terms to GBP. Deliberately
# conservative — the commercial team applies live FX on the final
# quote; this is just to keep the tier maths from comparing $0.90 to
# £1.75 as if they were the same number. Update as needed and re-run.
FX_TO_GBP = {
    "£": Decimal("1.0"),
    "GBP": Decimal("1.0"),
    "$": Decimal("0.78"),
    "USD": Decimal("0.78"),
    "€": Decimal("0.85"),
    "EUR": Decimal("0.85"),
}


def _classify(title: str) -> str:
    for category, pattern in CATEGORY_RULES:
        if pattern.search(title or ""):
            return category
    return "INGREDIENT"


@dataclass
class Term:
    """One purchase term (vendor + tier price) for a raw material."""
    vendor_title: str
    vendor_code: str
    price: Decimal              # raw price in vendor's currency
    price_gbp: Decimal          # normalised to GBP via FX_TO_GBP
    min_qty: Decimal
    lead_time: int | None
    unit: str | None
    currency_symbol: str | None
    priority: int | None
    approved: bool = True       # False if vendor title had "(Unapproved)"


@dataclass
class Leaf:
    """One resolved raw-material leaf in the finished product BOM chain."""
    code: str
    title: str
    category: str  # INGREDIENT | PACKAGING | LABOUR | QC_SHIPPING
    qty_per_finished_unit: Decimal
    qty_unit: str | None
    avg_cost: Decimal | None
    terms: list[Term] = field(default_factory=list)
    chain_path: list[str] = field(default_factory=list)  # BOM breadcrumb


@dataclass
class TierLineResult:
    leaf: Leaf
    qty_for_batch: Decimal
    chosen_term: Term | None
    unit_price: Decimal | None
    line_cost: Decimal | None
    moq_met: bool


@dataclass
class TierResult:
    tier: int
    lines: list[TierLineResult]
    ingredient_cost: Decimal = Decimal("0")
    packaging_cost: Decimal = Decimal("0")
    labour_cost: Decimal = Decimal("0")
    qc_shipping_cost: Decimal = Decimal("0")
    other_overhead_per_unit: Decimal = Decimal("0")
    total_cost_per_unit: Decimal = Decimal("0")


class Command(BaseCommand):
    help = (
        "Emit a volume-costing markdown report for a MRPEasy product — "
        "how per-unit cost scales from anchor tier up to 100k units, "
        "with per-ingredient purchase-term breakdown for cross-check."
    )

    def add_arguments(self, parser: Any) -> None:
        parser.add_argument(
            "--product-code", required=True,
            help="Finished product MRPEasy code (e.g. MA213961).",
        )
        parser.add_argument(
            "--anchor-price", required=True, type=Decimal,
            help="Per-unit COGS at anchor tier (e.g. 6.06). Backs out "
                 "fixed overhead from routing/QC/anything not in purchase terms.",
        )
        parser.add_argument(
            "--anchor-tier", type=int, default=1000,
            help="Tier at which --anchor-price applies (default: 1000).",
        )
        parser.add_argument(
            "--tiers", default="1000,2000,3000,5000,10000,25000,50000,100000",
            help="Comma-separated order quantity tiers to model.",
        )
        parser.add_argument(
            "--org-id", default=None,
            help="UUID of the vita-cff organization holding MRPEasy "
                 "credentials. Defaults to the first org with MRPEasy enabled.",
        )
        parser.add_argument(
            "--output", default=None,
            help="Markdown output path. Default: ./costing_<code>_<ts>.md",
        )
        parser.add_argument(
            "--min-overhead", type=Decimal, default=Decimal("0.75"),
            help="Floor for Vita internal overhead per pack (£). If the "
                 "anchor price would imply a lower (or negative) overhead, "
                 "the report uses this floor instead — so the tier prices "
                 "shown are what we SHOULD charge, not what an already-thin "
                 "quote silently gives away. Default: 0.75 (calibrated from "
                 "healthy STRYQ products).",
        )

    def handle(self, *args: Any, **opts: Any) -> None:
        product_code: str = opts["product_code"].strip()
        anchor_price: Decimal = opts["anchor_price"]
        anchor_tier: int = opts["anchor_tier"]
        min_overhead: Decimal = opts["min_overhead"]
        tiers = [int(t.strip()) for t in opts["tiers"].split(",") if t.strip()]
        if anchor_tier not in tiers:
            tiers = sorted(set(tiers + [anchor_tier]))

        org = self._resolve_org(opts.get("org_id"))
        try:
            config = _decode_config(dict(org.mrpeasy_config))
        except MrpeasyDecryptionFailed as exc:
            raise CommandError(
                "Could not decrypt MRPEasy secret — check DJANGO_SECRET_KEY "
                "matches what encrypted it."
            ) from exc
        client = get_client(config)

        self._log(f"tenant OK. walking BOM for {product_code} (org={org.name})")

        # 1) Walk BOM chain and collect leaves with effective qty per unit
        root_item = self._fetch_item_by_code(client, product_code)
        if not root_item:
            raise CommandError(f"MRPEasy product {product_code!r} not found.")

        leaves = self._collect_leaves(client, root_item, Decimal("1"), depth=0, path=[])
        self._log(f"resolved {len(leaves)} raw-material leaves")

        # 2) Compute tier maths
        tier_results = [self._compute_tier(t, leaves) for t in tiers]

        # 3) Anchor: back out fixed overhead, then floor it at
        #    --min-overhead so the tier table never shows a price that
        #    silently gives away Vita's internal costs.
        anchor_result = next(r for r in tier_results if r.tier == anchor_tier)
        anchor_variable = (
            anchor_result.ingredient_cost
            + anchor_result.packaging_cost
            + anchor_result.labour_cost
        ) / Decimal(anchor_tier)
        anchor_derived_overhead = anchor_price - anchor_variable
        fixed_overhead = max(anchor_derived_overhead, min_overhead)
        # Only treat the anchor as "floored" if the gap is meaningful —
        # a £0.001 rounding difference shouldn't produce a warning
        # banner that shows "£0.00 under floor".
        overhead_floored = (min_overhead - anchor_derived_overhead) > Decimal("0.05")
        for r in tier_results:
            variable_per_unit = (
                r.ingredient_cost + r.packaging_cost + r.labour_cost
            ) / Decimal(r.tier)
            r.other_overhead_per_unit = fixed_overhead
            r.total_cost_per_unit = variable_per_unit + fixed_overhead

        # 4) Render report
        report = self._render_report(
            product_code=product_code,
            root_item=root_item,
            leaves=leaves,
            tiers=tier_results,
            anchor_tier=anchor_tier,
            anchor_price=anchor_price,
            fixed_overhead=fixed_overhead,
            anchor_derived_overhead=anchor_derived_overhead,
            overhead_floored=overhead_floored,
            min_overhead=min_overhead,
        )

        # Emit only self-contained HTML — the intended distribution
        # channel is Teams / email, where .md renders as raw text but
        # .html previews inline with formatting.
        out_path = Path(opts.get("output") or (
            f"./{self._default_filename_stem(product_code, root_item)}.html"
        ))
        if out_path.suffix.lower() != ".html":
            out_path = out_path.with_suffix(".html")
        out_path.write_text(
            self._render_html(report, title=root_item.get("title") or product_code),
            encoding="utf-8",
        )
        self.stdout.write(self.style.SUCCESS(f"Wrote {out_path}"))

    def _health_banners(self, *, anchor_price, anchor_tier, anchor_result,
                        fixed_overhead, anchor_derived_overhead,
                        overhead_floored, min_overhead,
                        mrpeasy_avg, leaves) -> list[str]:
        """Return zero or more HTML-styled banner blocks to prepend to
        the report. Fires only when a real signal is present so a
        healthy product renders clean."""
        variable_at_anchor = (
            anchor_result.ingredient_cost
            + anchor_result.packaging_cost
            + anchor_result.labour_cost
        ) / Decimal(anchor_tier)
        banners: list[str] = []

        # 1) CRITICAL — the anchor price is below raw cost. The
        #    overhead floor has kicked in; call out the exact shortfall
        #    against variable cost so the reader sees where the money
        #    goes.
        if variable_at_anchor >= anchor_price:
            shortfall = variable_at_anchor - anchor_price
            proper_cost = variable_at_anchor + min_overhead
            uplift = proper_cost - anchor_price
            banners.append(self._banner(
                level="critical",
                title="⛔  Client-quoted price does not cover our cost",
                body=(
                    f"At {anchor_tier:,} units, ingredients + packaging + "
                    f"contract-filling alone come to <strong>£{variable_at_anchor:.2f}/pack</strong>, "
                    f"which is <strong>£{shortfall:.2f}/pack over the £{anchor_price:.2f} "
                    f"the client was quoted</strong>. Add a healthy £{min_overhead:.2f}/pack "
                    f"for internal labour + QC and the real cost is "
                    f"<strong>£{proper_cost:.2f}/pack</strong> — the client-facing price "
                    f"needs to go up by at least <strong>£{uplift:.2f}/pack</strong> "
                    f"before commercial adds any margin. Alternatively, purchasing should "
                    f"find a cheaper source for the expensive ingredients called out below."
                ),
            ))
        elif overhead_floored:
            # 2) WARNING — anchor covers variable but overhead is
            #    thinner than our floor. Floor kicked in; still worth
            #    flagging that quoted price is on the tight side.
            gap = min_overhead - anchor_derived_overhead
            banners.append(self._banner(
                level="warning",
                title="⚠️  Quoted price leaves thin internal overhead",
                body=(
                    f"The £{anchor_price:.2f} quote implies only "
                    f"£{anchor_derived_overhead:.2f}/pack for Vita internal labour + "
                    f"QC — <strong>£{gap:.2f}/pack under our healthy floor of "
                    f"£{min_overhead:.2f}</strong>. Tier prices below use the floor "
                    f"instead so commercial doesn't quote further discounts against "
                    f"an already-thin cost basis."
                ),
            ))

        # 3) INFO — MRPEasy's own historical avg_cost is above the anchor.
        #    Distinct from #1: even MRPEasy (which reflects real POs) says
        #    the anchor doesn't cover average cost.
        if mrpeasy_avg is not None and mrpeasy_avg > anchor_price:
            banners.append(self._banner(
                level="warning",
                title=f"⚠️  Recent POs averaged higher than the quote",
                body=(
                    f"MRPEasy's own <code>avg_cost</code> across recent purchase "
                    f"orders for this product is <strong>£{mrpeasy_avg:.2f}/pack</strong> — "
                    f"already <strong>£{(mrpeasy_avg - anchor_price):.2f}/pack above the "
                    f"£{anchor_price:.2f} anchor</strong>. Historical reality confirms this "
                    f"quote is below cost."
                ),
            ))

        # 4) INFO — a specific ingredient is >30% of variable cost.
        #    Surfaces the single biggest cost lever to negotiate.
        ing_lines = [
            (l, (l.line_cost or Decimal("0")) / Decimal(anchor_tier))
            for l in anchor_result.lines
            if l.leaf.category == "INGREDIENT"
        ]
        variable_gbp = variable_at_anchor
        if variable_gbp > 0:
            top = max(ing_lines, key=lambda x: x[1]) if ing_lines else None
            if top and top[1] / variable_gbp > Decimal("0.30"):
                leaf, per_pack = top
                pct = (per_pack / variable_gbp * 100)
                # Only warn if the chosen vendor is the ONLY one, or if
                # it's substantially more expensive than the second-cheapest.
                approved_terms = [t for t in leaf.terms if t.approved]
                if len(approved_terms) <= 1:
                    banners.append(self._banner(
                        level="info",
                        title=f"💡  {leaf.title.split('(')[0].strip()} dominates cost, single vendor",
                        body=(
                            f"This one ingredient accounts for "
                            f"<strong>{pct:.0f}%</strong> of variable cost "
                            f"(£{per_pack:.2f}/pack) and MRPEasy only has one "
                            f"approved vendor for it. A second quote would give "
                            f"purchasing real leverage."
                        ),
                    ))

        return banners

    def _banner(self, *, level: str, title: str, body: str) -> str:
        """Emit one styled banner block. Rendered as an HTML div so
        the Teams / email preview shows a real coloured card instead
        of an easy-to-miss line of text."""
        palette = {
            "critical": ("#8a1a1a", "#fde7e7", "#f5b5b5"),
            "warning":  ("#7a4a00", "#fff2d6", "#f0d59a"),
            "info":     ("#0b3d91", "#e7f0ff", "#b7cff5"),
        }
        fg, bg, border = palette.get(level, palette["info"])
        style = (
            f"background:{bg};border:1px solid {border};color:{fg};"
            f"padding:.75rem 1rem;border-radius:6px;margin:1rem 0;"
        )
        return (
            f"<div style=\"{style}\">"
            f"<strong>{title}</strong><br>{body}"
            f"</div>"
        )

    def _default_filename_stem(self, product_code: str, root_item: dict) -> str:
        """Filename shape: '<code> <cleaned title>'.

        Cleaned title = MRPEasy product title with parenthetical
        clutter and filesystem-unfriendly characters stripped. Keeps
        the code up front so files sort by SKU when dropped in a
        Teams / SharePoint folder.
        """
        title = (root_item.get("title") or "").strip()
        # Drop everything from the first '(' onwards ("(30 Sachets in Box)" etc.)
        cleaned = title.split("(")[0].strip()
        # Collapse whitespace, strip filesystem-hostile chars
        cleaned = re.sub(r"[\\/:*?\"<>|]", "", cleaned)
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if not cleaned:
            cleaned = "Costing"
        return f"{product_code} {cleaned}"

    def _render_html(self, markdown_text: str, title: str) -> str:
        """Wrap the rendered markdown in a self-contained HTML doc
        with inline styling. Uses the ``markdown`` library with the
        ``tables`` extension so pipe tables render as real tables.
        """
        import markdown as md_lib

        body_html = md_lib.markdown(
            markdown_text,
            extensions=["tables", "sane_lists"],
        )
        css = (
            "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"
            "max-width:820px;margin:2rem auto;padding:0 1.5rem;color:#1a1a1a;line-height:1.55;}"
            "h1{font-size:1.8rem;border-bottom:2px solid #e0e0e0;padding-bottom:.4rem;}"
            "h2{font-size:1.25rem;margin-top:2rem;color:#0b3d91;}"
            "table{border-collapse:collapse;width:100%;margin:1rem 0;font-size:.95rem;}"
            "th,td{border:1px solid #dcdcdc;padding:.5rem .75rem;text-align:left;}"
            "th{background:#f4f6f8;font-weight:600;}"
            "tr:nth-child(even) td{background:#fafbfc;}"
            "code{background:#f1f3f5;padding:.1rem .35rem;border-radius:3px;font-size:.9em;}"
            "em{color:#555;}"
            "strong{color:#0b3d91;}"
            "ul{padding-left:1.4rem;} li{margin:.35rem 0;}"
        )
        safe_title = (title or "Costing report").replace("<", "&lt;").replace(">", "&gt;")
        return (
            f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            f"<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            f"<title>{safe_title}</title><style>{css}</style></head>"
            f"<body>{body_html}</body></html>"
        )

    # ------------------------------------------------------------------
    # Data collection
    # ------------------------------------------------------------------

    def _resolve_org(self, org_id: str | None) -> Organization:
        if org_id:
            try:
                return Organization.objects.only(
                    "id", "name", "mrpeasy_config"
                ).get(pk=org_id)
            except Organization.DoesNotExist as exc:
                raise CommandError(f"Org {org_id!r} not found.") from exc
        for org in Organization.objects.only("id", "name", "mrpeasy_config").all():
            cfg = org.mrpeasy_config or {}
            if cfg.get("enabled") and cfg.get("api_key"):
                return org
        raise CommandError("No organization has MRPEasy enabled.")

    def _fetch_item_by_code(self, client, code: str) -> dict | None:
        res = client._request("items", query={"code": code})
        if isinstance(res, list) and res:
            return res[0]
        return None

    def _fetch_item_by_pid(self, client, product_id: int) -> dict | None:
        res = client._request("items", query={"product_id": str(product_id)})
        if isinstance(res, list) and res:
            return res[0]
        return None

    def _fetch_bom(self, client, product_id: int) -> dict | None:
        res = client._request("boms", query={"product_id": str(product_id)})
        if isinstance(res, list) and res:
            return res[0]
        return None

    def _parse_terms(self, raw_terms: Any) -> list[Term]:
        """MRPEasy stores purchase_terms as either a JSON-string
        (on the /items list response) or a nested array (on
        lookup_by_code's parsed shape). Handle both."""
        if raw_terms is None:
            return []
        if isinstance(raw_terms, str):
            try:
                raw_terms = json.loads(raw_terms) if raw_terms else []
            except json.JSONDecodeError:
                return []
        out: list[Term] = []
        for pt in raw_terms or []:
            if not isinstance(pt, dict):
                continue
            price = pt.get("price") or pt.get("currency_price")
            if price is None or price == "":
                continue
            raw_vendor = pt.get("vendor_title") or ""
            approved = "(unapproved)" not in raw_vendor.lower()
            price_dec = Decimal(str(price))
            currency = pt.get("currency")
            fx = FX_TO_GBP.get(currency) if currency else Decimal("1.0")
            if fx is None:
                fx = Decimal("1.0")  # unknown currency — treat as GBP + flag
            out.append(Term(
                vendor_title=self._clean_vendor(raw_vendor),
                vendor_code=pt.get("vendor_code") or "",
                price=price_dec,
                price_gbp=price_dec * fx,
                min_qty=Decimal(str(pt.get("min_quantity") or 0)),
                lead_time=int(pt["lead_time"]) if pt.get("lead_time") not in (None, "") else None,
                unit=pt.get("unit"),
                currency_symbol=currency,
                priority=int(float(pt["priority"])) if pt.get("priority") not in (None, "") else None,
                approved=approved,
            ))
        return out

    def _clean_vendor(self, title: str) -> str:
        return re.sub(
            r"\s*\((?:un)?approved\)\s*$", "", title, flags=re.IGNORECASE
        ).strip()

    def _collect_leaves(
        self,
        client,
        parent_item: dict,
        qty_multiplier: Decimal,
        depth: int,
        path: list[str],
    ) -> list[Leaf]:
        """Walk the BOM tree, aggregating per-unit qty for each leaf."""
        product_id = parent_item.get("product_id") or parent_item.get("id")
        title = parent_item.get("title") or ""
        code = parent_item.get("code") or ""
        this_path = path + [f"{code} ({title[:30]})"]

        # Depth cap — don't recurse into testing/shipping overhead
        if depth >= MAX_BOM_DEPTH:
            return [self._as_leaf(parent_item, qty_multiplier, this_path)]

        bom = self._fetch_bom(client, product_id) if product_id else None
        components = (bom or {}).get("components") or []
        if not components:
            return [self._as_leaf(parent_item, qty_multiplier, this_path)]

        leaves: list[Leaf] = []
        for comp in components:
            child_pid = comp.get("product_id")
            comp_qty = comp.get("quantity")
            if child_pid is None or comp_qty is None:
                continue
            child_item = self._fetch_item_by_pid(client, child_pid)
            if not child_item:
                continue
            child_multiplier = qty_multiplier * Decimal(str(comp_qty))
            leaves.extend(self._collect_leaves(
                client, child_item, child_multiplier, depth + 1, this_path
            ))
        return leaves

    def _as_leaf(self, item: dict, qty: Decimal, path: list[str]) -> Leaf:
        title = item.get("title") or ""
        category = _classify(title)
        avg = item.get("avg_cost")
        return Leaf(
            code=item.get("code") or "",
            title=title,
            category=category,
            qty_per_finished_unit=qty,
            qty_unit=None,
            avg_cost=Decimal(str(avg)) if avg not in (None, "") else None,
            terms=self._parse_terms(item.get("purchase_terms")),
            chain_path=path,
        )

    # ------------------------------------------------------------------
    # Tier maths
    # ------------------------------------------------------------------

    def _best_term(self, terms: list[Term], required_qty: Decimal) -> tuple[Term | None, bool]:
        """Cheapest approved term whose MOQ ≤ required qty, in GBP.

        Filters out unapproved vendors (per MRPEasy title suffix).
        Compares prices in GBP-normalised form so a $0.90 term
        doesn't get picked over £1.75 because "0.9 < 1.75".
        Returns (term, moq_met). If no term meets the MOQ we still
        return the smallest-MOQ term so we can price it — the
        purchasing team decides whether to pool with another order.
        """
        approved = [t for t in terms if t.approved]
        if not approved:
            return None, False
        eligible = [t for t in approved if t.min_qty <= required_qty]
        moq_met = bool(eligible)
        if not eligible:
            eligible = sorted(approved, key=lambda t: t.min_qty)[:1]
        return min(eligible, key=lambda t: t.price_gbp), moq_met

    def _compute_tier(self, tier: int, leaves: list[Leaf]) -> TierResult:
        tier_result = TierResult(tier=tier, lines=[])
        for leaf in leaves:
            qty_for_batch = leaf.qty_per_finished_unit * Decimal(tier)
            if leaf.category == "QC_SHIPPING":
                # Treat as amortized-in-avg overhead — no MOQ scaling
                tier_result.lines.append(TierLineResult(
                    leaf=leaf, qty_for_batch=qty_for_batch,
                    chosen_term=None, unit_price=leaf.avg_cost,
                    line_cost=(leaf.avg_cost or Decimal("0")) * qty_for_batch,
                    moq_met=True,
                ))
                continue
            term, moq_met = self._best_term(leaf.terms, qty_for_batch)
            # Use GBP-normalised price for line maths so mixed-currency
            # BOMs don't silently under/over-count.
            unit_price = term.price_gbp if term else leaf.avg_cost
            line_cost = (unit_price or Decimal("0")) * qty_for_batch
            tier_result.lines.append(TierLineResult(
                leaf=leaf, qty_for_batch=qty_for_batch, chosen_term=term,
                unit_price=unit_price, line_cost=line_cost, moq_met=moq_met,
            ))
            if leaf.category == "INGREDIENT":
                tier_result.ingredient_cost += line_cost
            elif leaf.category == "PACKAGING":
                tier_result.packaging_cost += line_cost
            elif leaf.category == "LABOUR":
                tier_result.labour_cost += line_cost
        return tier_result

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def _render_report(self, product_code, root_item, leaves, tiers,
                       anchor_tier, anchor_price, fixed_overhead,
                       anchor_derived_overhead, overhead_floored,
                       min_overhead) -> str:
        """Short, scannable report. Four things only:
            1. What you save at each order size (the headline).
            2. What makes up the price (one small breakdown).
            3. Ingredient prices used (one table for cross-check).
            4. Anything worth flagging (one line each, deduped).
        Health banners are injected at the top when the anchor price
        looks too thin (or negative) against actual costs.
        """
        today = datetime.now(timezone.utc).strftime("%d %b %Y")
        title = root_item.get("title") or product_code
        anchor_result = next(r for r in tiers if r.tier == anchor_tier)
        mrpeasy_avg = root_item.get("avg_cost")
        try:
            mrpeasy_avg_dec = Decimal(str(mrpeasy_avg)) if mrpeasy_avg is not None else None
        except Exception:  # noqa: BLE001
            mrpeasy_avg_dec = None

        lines: list[str] = []
        w = lines.append

        # ---------- Header ----------
        w(f"# {title}")
        w(f"`{product_code}` · {today}")
        w("")
        if overhead_floored:
            w(f"Client was quoted **£{anchor_price:.2f}/pack at {anchor_tier:,} units** — "
              f"but that anchor doesn't cover our internal costs. The tier table below "
              f"shows the **proper cost** using a healthy £{min_overhead:.2f}/pack "
              f"internal-overhead floor, so commercial adds margin on top of a real cost, "
              f"not one that's already eating margin.")
        else:
            w(f"Anchor price at **{anchor_tier:,} units = £{anchor_price:.2f}/pack**. "
              f"Everything else is recomputed from live MRPEasy vendor prices.")
        w("")

        # ---------- Health banners (injected only when triggered) ----------
        banners = self._health_banners(
            anchor_price=anchor_price,
            anchor_tier=anchor_tier,
            anchor_result=anchor_result,
            fixed_overhead=fixed_overhead,
            anchor_derived_overhead=anchor_derived_overhead,
            overhead_floored=overhead_floored,
            min_overhead=min_overhead,
            mrpeasy_avg=mrpeasy_avg_dec,
            leaves=leaves,
        )
        for banner in banners:
            w(banner)
            w("")

        # ---------- Section 1: THE SAVINGS TABLE ----------
        # Baseline for the saving column is the SMALLEST tier's total,
        # not the anchor price — so when the overhead floor is applied
        # and the anchor no longer equals the tier total, the "saving"
        # column still makes sense (savings vs the smallest MOQ).
        baseline_tier = min(tiers, key=lambda x: x.tier)
        baseline_total = baseline_tier.total_cost_per_unit
        w("## What it should cost as the client orders more")
        w("")
        w(f"| Order size | Cost per pack | Saved per pack vs {baseline_tier.tier:,} MOQ | Saved on whole order |")
        w("|---:|---:|---:|---:|")
        for r in tiers:
            total = r.total_cost_per_unit
            saving = baseline_total - total
            saving_pct = (saving / baseline_total * 100) if baseline_total else Decimal("0")
            saving_batch = saving * Decimal(r.tier)
            markers = []
            if r.tier == anchor_tier:
                markers.append("client-quoted MOQ")
            if r.tier == baseline_tier.tier and r.tier != anchor_tier:
                markers.append("smallest MOQ")
            marker = f" ({', '.join(markers)})" if markers else ""
            saving_cell = "—" if r.tier == baseline_tier.tier else f"£{saving:.2f}  ({saving_pct:.1f}%)"
            batch_cell = "—" if r.tier == baseline_tier.tier else f"£{saving_batch:,.0f}"
            w(f"| **{r.tier:,}**{marker} | £{total:.2f} | {saving_cell} | {batch_cell} |")
        w("")
        w(f"_Prices above are our **cost** (COGS){' with a healthy £' + f'{min_overhead:.2f}' + '/pack overhead floor' if overhead_floored else ''}. "
          f"Commercial team adds the margin on top before quoting._")
        if overhead_floored:
            anchor_total = next(r.total_cost_per_unit for r in tiers if r.tier == anchor_tier)
            gap = anchor_total - anchor_price
            w("")
            w(f"⚠️  **At {anchor_tier:,} units the proper cost is £{anchor_total:.2f}/pack — "
              f"£{gap:.2f}/pack ABOVE the £{anchor_price:.2f} the client was quoted.** "
              f"Any margin the commercial team adds is starting from £{anchor_total:.2f}, "
              f"not from £{anchor_price:.2f}.")
        w("")

        # ---------- Section 2: What makes up the pack ----------
        anchor_ing = anchor_result.ingredient_cost / Decimal(anchor_tier)
        anchor_pkg = anchor_result.packaging_cost / Decimal(anchor_tier)
        anchor_lab = anchor_result.labour_cost / Decimal(anchor_tier)
        anchor_ovh = anchor_result.other_overhead_per_unit
        anchor_total = anchor_result.total_cost_per_unit

        w(f"## What makes up £{anchor_total:.2f}/pack at {anchor_tier:,} units")
        w("")
        w("| What | £ per pack | What it covers |")
        w("|---|---:|---|")
        w(f"| Ingredients | £{anchor_ing:.2f} | The raw powders in the blend |")
        w(f"| Packaging | £{anchor_pkg:.2f} | Sachet material + outer box |")
        w(f"| Contract filling (labour) | £{anchor_lab:.2f} | The sachet-filling contractor |")
        ovh_note = " — <em>floored to protect margin</em>" if overhead_floored else ""
        w(f"| Vita overhead | £{anchor_ovh:.2f}{ovh_note} | Our internal labour, QC tests, shipping, everything else |")
        w(f"| **Total** | **£{anchor_total:.2f}** |  |")
        w("")
        w("As the order gets bigger, only **Ingredients** falls — vendors give us cheaper prices when we buy more kg. "
          "Packaging, filling, and Vita overhead stay flat per pack.")
        w("")

        # ---------- Section 3: Ingredient breakdown per tier ----------
        # Group consecutive tiers that pick the SAME vendors at the SAME
        # MOQ + price — the cost per pack still varies (batch qty grows),
        # but the sourcing decision is identical so we render one table
        # for the group instead of eight near-duplicate tables.
        w("## How the ingredient cost breaks down at each tier")
        w("")
        w("For every order size, this is the vendor + MOQ + price the maths above pulled "
          "for every ingredient. When several tiers use the same vendors (because no cheaper "
          "MOQ has unlocked yet), we show them together to keep the report short. "
          "**Commercial team**: this is where the tier savings come from — the cheaper the "
          "vendor unlocked at higher volume, the bigger the tier discount.")
        w("")
        def _fingerprint(tier_result: TierResult) -> tuple:
            return tuple(
                (l.leaf.code,
                 l.chosen_term.vendor_code if l.chosen_term else None,
                 l.chosen_term.min_qty if l.chosen_term else None,
                 l.unit_price)
                for l in tier_result.lines
                if l.leaf.category == "INGREDIENT"
            )

        groups: list[tuple[list[int], TierResult]] = []
        for r in tiers:
            fp = _fingerprint(r)
            if groups and _fingerprint(groups[-1][1]) == fp:
                groups[-1][0].append(r.tier)
            else:
                groups.append(([r.tier], r))

        for tier_list, sample in groups:
            if len(tier_list) == 1:
                header = f"### {tier_list[0]:,} units"
            else:
                header = f"### {tier_list[0]:,} to {tier_list[-1]:,} units (same vendor mix)"
            w(header)
            w("")
            w("| Code | Ingredient | Vendor | Vendor MOQ | £/kg | Kg needed | Cost per pack | MOQ met? |")
            w("|---|---|---|---:|---:|---:|---:|:-:|")
            ing_lines = [l for l in sample.lines if l.leaf.category == "INGREDIENT"]
            for line in sorted(ing_lines, key=lambda x: -float(x.line_cost or 0)):
                per_pack = (line.line_cost or Decimal("0")) / Decimal(sample.tier)
                if line.chosen_term:
                    vendor = line.chosen_term.vendor_title
                    if line.chosen_term.min_qty and line.chosen_term.min_qty > 0:
                        v_moq = f"{line.chosen_term.min_qty:.0f} kg"
                    else:
                        v_moq = "⚠️ not set"
                else:
                    vendor = "avg_cost fallback"
                    v_moq = "—"
                price_kg = line.unit_price if line.unit_price is not None else Decimal("0")
                name = line.leaf.title.split("(")[0].strip() or line.leaf.title
                moq_flag = "✅" if line.moq_met else "⚠️"
                w(f"| `{line.leaf.code}` | {name} | {vendor} | {v_moq} | £{price_kg:.2f} "
                  f"| {line.qty_for_batch:.2f} kg | £{per_pack:.4f} | {moq_flag} |")
            w("")
            ing_total = sample.ingredient_cost / Decimal(sample.tier)
            w(f"**Ingredient total: £{ing_total:.4f}/pack** "
              f"(+ £{sample.packaging_cost / Decimal(sample.tier):.2f} packaging "
              f"+ £{sample.labour_cost / Decimal(sample.tier):.2f} filling "
              f"+ £{sample.other_overhead_per_unit:.2f} overhead "
              f"= **£{sample.total_cost_per_unit:.2f}/pack**)")
            w("")
        w("_⚠️ in the last column means we don't hit the vendor's MOQ at this tier — "
          "purchasing would need to pool this ingredient with another product's order. "
          "⚠️ in the MOQ column means the vendor's minimum order quantity isn't set in "
          "MRPEasy — the price may or may not hold for small runs; purchasing to verify._")
        w("")

        # ---------- Section 4: Flags (deduped) ----------
        flag_lines: list[str] = []

        # (a) Ingredients we buy in tiny amounts — can't hit the cheap-vendor MOQ
        # even at the biggest tier. That's the real opportunity: pool with
        # another product.
        largest_tier = max(t.tier for t in tiers)
        largest_result = next(r for r in tiers if r.tier == largest_tier)
        for line in largest_result.lines:
            if line.leaf.category != "INGREDIENT":
                continue
            if line.moq_met:
                continue
            if not line.chosen_term:
                continue
            # Find a CHEAPER vendor whose MOQ we can't hit even at largest tier.
            cheaper_locked = [
                t for t in line.leaf.terms
                if t.approved and t.price_gbp < line.chosen_term.price_gbp
                and t.min_qty > line.qty_for_batch
            ]
            if cheaper_locked:
                cheapest_locked = min(cheaper_locked, key=lambda t: t.price_gbp)
                savings_kg = line.chosen_term.price_gbp - cheapest_locked.price_gbp
                flag_lines.append(
                    f"- **`{line.leaf.code}` {line.leaf.title.split('(')[0].strip()}** — we only need "
                    f"{line.qty_for_batch:.1f} kg even at {largest_tier:,} units, "
                    f"but a cheaper vendor ({cheapest_locked.vendor_title}) requires "
                    f"{cheapest_locked.min_qty:.0f} kg MOQ. Pool with another product "
                    f"using this ingredient and save ~£{savings_kg:.2f}/kg."
                )

        # (b) Materials with no vendor price at all in MRPEasy
        for leaf in leaves:
            if leaf.category == "QC_SHIPPING":
                continue
            if not leaf.terms:
                flag_lines.append(
                    f"- **`{leaf.code}` {leaf.title}** — no vendor purchase term in MRPEasy. "
                    f"Ask purchasing to add current quotes before we ship a real quote."
                )

        # (c) Packaging MOQ can't be met at the SMALL tiers — one-line summary.
        pkg_underruns = [
            (r.tier, line.leaf.code, line.leaf.title, line.chosen_term.min_qty if line.chosen_term else None)
            for r in tiers
            for line in r.lines
            if line.leaf.category == "PACKAGING" and not line.moq_met and line.chosen_term
        ]
        # Dedupe by item — report the LARGEST tier that still underruns.
        pkg_by_item: dict[str, tuple[int, str, Decimal]] = {}
        for tier, code, name, moq in pkg_underruns:
            existing = pkg_by_item.get(name)
            if existing is None or tier > existing[0]:
                pkg_by_item[name] = (tier, code, moq)
        for name, (max_underrun_tier, code, moq) in pkg_by_item.items():
            flag_lines.append(
                f"- **`{code}` {name}** packaging has MOQ {moq:.0f} — orders up to and including "
                f"{max_underrun_tier:,} units fall short. Pool with another SKU or negotiate a short-run price."
            )

        # (d) Ingredients whose chosen vendor has NO MOQ set — the "0 kg"
        #     or blank case. Purchasing should verify whether the vendor
        #     really is happy to sell any qty or the field just wasn't
        #     filled in.
        moq_unset: dict[str, tuple[str, str]] = {}  # code -> (name, vendor)
        for r in tiers:
            for line in r.lines:
                if line.leaf.category != "INGREDIENT":
                    continue
                if not line.chosen_term:
                    continue
                if line.chosen_term.min_qty and line.chosen_term.min_qty > 0:
                    continue
                moq_unset.setdefault(
                    line.leaf.code,
                    (line.leaf.title.split("(")[0].strip(), line.chosen_term.vendor_title),
                )
        for code, (name, vendor) in moq_unset.items():
            flag_lines.append(
                f"- **`{code}` {name}** — chosen vendor ({vendor}) has no MOQ set in MRPEasy. "
                f"The £/kg used above assumes the price holds for any batch size — worth "
                f"confirming with purchasing before quoting the smaller tiers."
            )

        if flag_lines:
            w("## Worth flagging")
            w("")
            for line in flag_lines:
                w(line)
            w("")

        return "\n".join(lines) + "\n"

    def _fmt(self, val, dp: int) -> str:
        if val is None:
            return "—"
        if isinstance(val, Decimal):
            return f"{val:.{dp}f}"
        try:
            return f"{Decimal(str(val)):.{dp}f}"
        except Exception:  # noqa: BLE001
            return str(val)

    def _log(self, msg: str) -> None:
        self.stderr.write(self.style.NOTICE(f"[mrpeasy-costing] {msg}"))
