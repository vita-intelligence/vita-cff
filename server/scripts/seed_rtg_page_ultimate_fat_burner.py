"""Seed a rich Puck page for the Ultimate Fat Burner Drink RTG.

Runs against the local NPD DB and writes a full-length, multi-band
marketing page into ``Formulation.rtg_page_content`` for the SKU
``ultimate-fat-burner-drink``. Idempotent — re-running overwrites
whatever's there.

Usage:
    ./.venv/bin/python manage.py shell < scripts/seed_rtg_page_ultimate_fat_burner.py

Structure of the page (top → bottom):
    1. Bold brand-blue hero band — big H1 + subhead + sample CTA
    2. Value pillars — three columns explaining what makes this SKU
       distinctive (formulation, sourcing, compliance)
    3. Ingredients spotlight — full-width heading + rich paragraph
       listing the actives with brief rationale
    4. Science section (rich HTML body) — the "why it works"
    5. Manufacturing standards (dark band) — cert stack + traceability
    6. Time-to-market (light grey band) — 3-column launch timeline
    7. Customisation options — 2-column pack shot options
    8. Sample kit CTA (accent orange band) — closes the page

Every block gets its own id (Puck usually generates these on the
editor side; we generate stable uuids here). Slot fields (Section
``content``, Columns ``left`` / ``middle`` / ``right``) hold nested
block arrays.
"""

from __future__ import annotations

import uuid

from apps.formulations.models import Formulation

SLUG = "ultimate-fat-burner-drink"


# --------------------------------------------------------------------
# Block builders — thin wrappers so the page shape stays readable
# --------------------------------------------------------------------


def _id(type_: str) -> str:
    return f"{type_}-{uuid.uuid4()}"


def _pad(top=48, right=24, bottom=48, left=24):
    return {"top": top, "right": right, "bottom": bottom, "left": left}


def section(*, bg="", text_color="", padding=None, max_width=1200, align="left", content=None):
    return {
        "type": "Section",
        "props": {
            "id": _id("Section"),
            "padding": padding or _pad(),
            "backgroundColor": bg,
            "textColor": text_color,
            "maxWidth": max_width,
            "align": align,
            "content": content or [],
        },
    }


def heading(text, *, level="h2", align="left", color="", padding=None):
    return {
        "type": "Heading",
        "props": {
            "id": _id("Heading"),
            "text": text,
            "level": level,
            "align": align,
            "color": color,
            "padding": padding or {"top": 0, "right": 0, "bottom": 16, "left": 0},
        },
    }


def paragraph(html, *, align="left", color="", padding=None):
    return {
        "type": "Paragraph",
        "props": {
            "id": _id("Paragraph"),
            "html": html,
            "align": align,
            "color": color,
            "padding": padding or {"top": 0, "right": 0, "bottom": 16, "left": 0},
        },
    }


def button(label, href="#", *, variant="primary", size="md", align="left", padding=None):
    return {
        "type": "ButtonBlock",
        "props": {
            "id": _id("ButtonBlock"),
            "label": label,
            "href": href,
            "variant": variant,
            "size": size,
            "align": align,
            "padding": padding or {"top": 8, "right": 0, "bottom": 8, "left": 0},
        },
    }


def spacer(height=32):
    return {
        "type": "Spacer",
        "props": {"id": _id("Spacer"), "height": height},
    }


def divider(color="#e2e8f0", thickness=1, padding=None):
    return {
        "type": "Divider",
        "props": {
            "id": _id("Divider"),
            "color": color,
            "thickness": thickness,
            "padding": padding or {"top": 24, "right": 0, "bottom": 24, "left": 0},
        },
    }


def columns(cols=2, gap=32, padding=None, *, left=None, middle=None, right=None):
    return {
        "type": "Columns",
        "props": {
            "id": _id("Columns"),
            "columns": cols,
            "gap": gap,
            "padding": padding or {"top": 0, "right": 0, "bottom": 0, "left": 0},
            "left": left or [],
            "middle": middle or [],
            "right": right or [],
        },
    }


# --------------------------------------------------------------------
# Page composition
# --------------------------------------------------------------------


BRAND_BLUE = "#0f5cff"
INK = "#0b1220"
SLATE_50 = "#f6f8fb"
SLATE_100 = "#eef2f8"
ACCENT = "#e35a2b"
WHITE = "#ffffff"


# --- 1. HERO BAND --------------------------------------------------
HERO = section(
    bg=BRAND_BLUE,
    text_color=WHITE,
    padding=_pad(top=96, bottom=96, right=24, left=24),
    max_width=1080,
    align="center",
    content=[
        paragraph(
            '<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:12px;font-weight:700;color:rgba(255,255,255,0.75);margin:0">Ready to brand · Thermogenic drink</p>',
            align="center",
            padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
        ),
        heading(
            "Thermogenic energy, from the first sip.",
            level="h1",
            align="center",
            color=WHITE,
            padding={"top": 0, "right": 0, "bottom": 20, "left": 0},
        ),
        paragraph(
            '<p style="font-size:19px;line-height:1.6;color:rgba(255,255,255,0.9);margin:0;max-width:640px;margin-left:auto;margin-right:auto">A ready-to-brand fat-burner drink built on evidence-backed actives — L-carnitine, green tea, green coffee bean, guarana, B-complex. Manufactured in-house, shipped with your artwork, MOQ from 5,000 units.</p>',
            align="center",
            padding={"top": 0, "right": 0, "bottom": 28, "left": 0},
        ),
        button(
            "Request a sample kit",
            href="#sample",
            variant="secondary",
            size="lg",
            align="center",
            padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
        ),
    ],
)


# --- 2. VALUE PILLARS ---------------------------------------------
PILLAR_CARDS = [
    (
        "Formulated by our R&D team",
        "Doses drawn from published research, not marketing folklore. Every active justified in the spec sheet before it hits the batch card.",
    ),
    (
        "Sourced from vetted suppliers",
        "Actives traced back to origin. Certificates of analysis, allergen matrix and country-of-origin data on file for every lot.",
    ),
    (
        "Manufactured under BRCGS AA+",
        "Made in our own UK facility. ISO 22000:2018, HACCP-controlled, allergen-segregated. No repackers, no white-label brokers.",
    ),
]

VALUE_PILLARS = section(
    bg=WHITE,
    padding=_pad(top=88, bottom=88),
    max_width=1200,
    align="left",
    content=[
        paragraph(
            f'<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:11px;font-weight:700;color:{BRAND_BLUE};margin:0">Why this SKU</p>',
            padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
        ),
        heading(
            "Built for brands that ship products, not press releases.",
            level="h2",
            color=INK,
            padding={"top": 0, "right": 0, "bottom": 20, "left": 0},
        ),
        paragraph(
            f'<p style="font-size:17px;line-height:1.7;color:#4b5568;margin:0;max-width:720px">You get a fully-approved formula with a final spec sheet, an allergen breakdown, a stability record and every downstream compliance document that a serious retailer or regulator would ask for.</p>',
            padding={"top": 0, "right": 0, "bottom": 40, "left": 0},
        ),
        columns(
            cols=3,
            gap=24,
            left=[
                paragraph(
                    f'<div style="border-radius:16px;border:1px solid #e5e9f0;padding:28px;height:100%;background:#fbfcfe"><div style="width:36px;height:36px;border-radius:10px;background:{BRAND_BLUE}14;color:{BRAND_BLUE};display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;margin-bottom:14px">01</div><h3 style="font-size:18px;font-weight:800;color:{INK};margin:0 0 10px;letter-spacing:-0.01em">{PILLAR_CARDS[0][0]}</h3><p style="font-size:14px;line-height:1.6;color:#556170;margin:0">{PILLAR_CARDS[0][1]}</p></div>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
            middle=[
                paragraph(
                    f'<div style="border-radius:16px;border:1px solid #e5e9f0;padding:28px;height:100%;background:#fbfcfe"><div style="width:36px;height:36px;border-radius:10px;background:{BRAND_BLUE}14;color:{BRAND_BLUE};display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;margin-bottom:14px">02</div><h3 style="font-size:18px;font-weight:800;color:{INK};margin:0 0 10px;letter-spacing:-0.01em">{PILLAR_CARDS[1][0]}</h3><p style="font-size:14px;line-height:1.6;color:#556170;margin:0">{PILLAR_CARDS[1][1]}</p></div>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
            right=[
                paragraph(
                    f'<div style="border-radius:16px;border:1px solid #e5e9f0;padding:28px;height:100%;background:#fbfcfe"><div style="width:36px;height:36px;border-radius:10px;background:{BRAND_BLUE}14;color:{BRAND_BLUE};display:inline-flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;margin-bottom:14px">03</div><h3 style="font-size:18px;font-weight:800;color:{INK};margin:0 0 10px;letter-spacing:-0.01em">{PILLAR_CARDS[2][0]}</h3><p style="font-size:14px;line-height:1.6;color:#556170;margin:0">{PILLAR_CARDS[2][1]}</p></div>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
        ),
    ],
)


# --- 3. INGREDIENT SPOTLIGHT --------------------------------------
INGREDIENT_ROWS_HTML = """
<div style="display:grid;gap:14px;margin-top:10px">
  <div style="border-left:3px solid #0f5cff;padding:14px 18px;background:#ffffff;border-radius:0 12px 12px 0;box-shadow:0 1px 2px rgba(15,20,35,0.04)">
    <p style="margin:0;font-weight:800;color:#0b1220;font-size:15px">L-Carnitine · 1,500 mg</p>
    <p style="margin:4px 0 0;font-size:14px;line-height:1.55;color:#4b5568">Shuttles long-chain fatty acids across the mitochondrial membrane where they can actually be oxidised. Doses at the upper end of the studied range for adult support.</p>
  </div>
  <div style="border-left:3px solid #0f5cff;padding:14px 18px;background:#ffffff;border-radius:0 12px 12px 0;box-shadow:0 1px 2px rgba(15,20,35,0.04)">
    <p style="margin:0;font-weight:800;color:#0b1220;font-size:15px">Green Tea Extract (50% EGCG) · 400 mg</p>
    <p style="margin:4px 0 0;font-size:14px;line-height:1.55;color:#4b5568">Standardised polyphenol blend with a well-documented resting-metabolic-rate uplift when paired with modest caffeine. Sourced from a UK-audited botanical supplier.</p>
  </div>
  <div style="border-left:3px solid #0f5cff;padding:14px 18px;background:#ffffff;border-radius:0 12px 12px 0;box-shadow:0 1px 2px rgba(15,20,35,0.04)">
    <p style="margin:0;font-weight:800;color:#0b1220;font-size:15px">Green Coffee Bean (45% Chlorogenic acid) · 300 mg</p>
    <p style="margin:4px 0 0;font-size:14px;line-height:1.55;color:#4b5568">Unroasted extract preserving the chlorogenic acid content. Supports postprandial glucose handling in the studied ranges.</p>
  </div>
  <div style="border-left:3px solid #0f5cff;padding:14px 18px;background:#ffffff;border-radius:0 12px 12px 0;box-shadow:0 1px 2px rgba(15,20,35,0.04)">
    <p style="margin:0;font-weight:800;color:#0b1220;font-size:15px">Guarana Extract (22% caffeine) · 200 mg</p>
    <p style="margin:4px 0 0;font-size:14px;line-height:1.55;color:#4b5568">Slow-release plant caffeine paired with natural theobromines — cleaner onset than an equivalent dose of synthetic caffeine.</p>
  </div>
  <div style="border-left:3px solid #0f5cff;padding:14px 18px;background:#ffffff;border-radius:0 12px 12px 0;box-shadow:0 1px 2px rgba(15,20,35,0.04)">
    <p style="margin:0;font-weight:800;color:#0b1220;font-size:15px">B-Complex (B3, B6, B12) · 100% NRV</p>
    <p style="margin:4px 0 0;font-size:14px;line-height:1.55;color:#4b5568">The energy-metabolism backbone. Every daily dose supplies full NRV, allowing the on-pack &lsquo;supports normal energy metabolism&rsquo; claim (EFSA-compliant wording).</p>
  </div>
  <div style="border-left:3px solid #0f5cff;padding:14px 18px;background:#ffffff;border-radius:0 12px 12px 0;box-shadow:0 1px 2px rgba(15,20,35,0.04)">
    <p style="margin:0;font-weight:800;color:#0b1220;font-size:15px">Natural citrus flavour system · Sugar-free</p>
    <p style="margin:4px 0 0;font-size:14px;line-height:1.55;color:#4b5568">Sucralose + stevia blend tuned to mask bitterness from the botanical actives. Zero added sugar. Vegan &amp; GMO-free.</p>
  </div>
</div>
"""

INGREDIENTS = section(
    bg=SLATE_50,
    padding=_pad(top=88, bottom=88),
    max_width=1080,
    align="left",
    content=[
        paragraph(
            f'<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:11px;font-weight:700;color:{BRAND_BLUE};margin:0">Formulation</p>',
            padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
        ),
        heading(
            "What's inside — per daily dose.",
            level="h2",
            color=INK,
            padding={"top": 0, "right": 0, "bottom": 16, "left": 0},
        ),
        paragraph(
            f'<p style="font-size:16px;line-height:1.7;color:#4b5568;margin:0;max-width:680px">Six actives, six reasons each one is there. No proprietary blends, no undisclosed doses.</p>',
            padding={"top": 0, "right": 0, "bottom": 8, "left": 0},
        ),
        paragraph(
            INGREDIENT_ROWS_HTML,
            padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
        ),
    ],
)


# --- 4. SCIENCE / RATIONALE ---------------------------------------
SCIENCE = section(
    bg=WHITE,
    padding=_pad(top=88, bottom=88),
    max_width=880,
    align="left",
    content=[
        paragraph(
            f'<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:11px;font-weight:700;color:{BRAND_BLUE};margin:0">The science, in plain English</p>',
            padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
        ),
        heading(
            "The three levers this drink pulls.",
            level="h2",
            color=INK,
            padding={"top": 0, "right": 0, "bottom": 20, "left": 0},
        ),
        paragraph(
            f'<h3 style="font-size:19px;font-weight:800;color:{INK};margin:24px 0 8px">1. Mobilise stored fat</h3><p style="font-size:16px;line-height:1.75;color:#4b5568;margin:0">L-carnitine escorts long-chain fatty acids into the mitochondria. Without adequate carnitine, the fat that leaves adipose tissue has nowhere useful to go — the body simply re-stores it. A meaningful dose (1,500 mg here) keeps the shuttle saturated for adult training loads.</p>'
            f'<h3 style="font-size:19px;font-weight:800;color:{INK};margin:28px 0 8px">2. Nudge the metabolic set-point</h3><p style="font-size:16px;line-height:1.75;color:#4b5568;margin:0">Green tea polyphenols (EGCG) modestly increase resting metabolic rate when combined with the small caffeine load supplied by guarana. The pairing is dose-dependent and well-studied in adults on a hypocaloric diet.</p>'
            f'<h3 style="font-size:19px;font-weight:800;color:{INK};margin:28px 0 8px">3. Support the metabolism itself</h3><p style="font-size:16px;line-height:1.75;color:#4b5568;margin:0">Every step in fat catabolism runs through a B-vitamin cofactor. Under-dosing vitamins B3, B6 and B12 quietly caps the ceiling on everything else in the stack. Delivering 100% NRV per serve makes the whole formulation efficient — nothing wasted upstream.</p>',
            padding={"top": 0, "right": 0, "bottom": 24, "left": 0},
        ),
        paragraph(
            f'<div style="border-radius:14px;border:1px dashed #cbd5e1;padding:20px 24px;background:{SLATE_50}"><p style="margin:0;font-size:13px;line-height:1.7;color:#4b5568"><strong style="color:{INK}">Regulatory note.</strong> All claims and dose ranges validated against the EU Health Claims Register + UK Nutrition &amp; Health Claims regulations. On-pack claim library is included in the spec sheet delivered with sample orders.</p></div>',
            padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
        ),
    ],
)


# --- 5. MANUFACTURING BAND ----------------------------------------
MANUFACTURING = section(
    bg=INK,
    text_color=WHITE,
    padding=_pad(top=96, bottom=96),
    max_width=1200,
    align="left",
    content=[
        columns(
            cols=2,
            gap=48,
            left=[
                paragraph(
                    '<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:11px;font-weight:700;color:rgba(255,255,255,0.6);margin:0">Manufacturing</p>',
                    padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
                ),
                heading(
                    "Made under BRCGS AA+ conditions.",
                    level="h2",
                    color=WHITE,
                    padding={"top": 0, "right": 0, "bottom": 20, "left": 0},
                ),
                paragraph(
                    '<p style="font-size:16px;line-height:1.7;color:rgba(255,255,255,0.8);margin:0">Every batch is manufactured in our own UK facility — no third-party contract packers, no white-label brokers between you and the line. Full traceability, one contact point, one shipping origin.</p>',
                    padding={"top": 0, "right": 0, "bottom": 16, "left": 0},
                ),
                paragraph(
                    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px;margin-top:8px">'
                    '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)"><span style="color:#7dd3fc;margin-right:8px">✓</span>ISO 22000:2018</p>'
                    '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)"><span style="color:#7dd3fc;margin-right:8px">✓</span>HACCP controlled</p>'
                    '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)"><span style="color:#7dd3fc;margin-right:8px">✓</span>BRCGS AA+</p>'
                    '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)"><span style="color:#7dd3fc;margin-right:8px">✓</span>Allergen-segregated</p>'
                    '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)"><span style="color:#7dd3fc;margin-right:8px">✓</span>Lot-level traceability</p>'
                    '<p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85)"><span style="color:#7dd3fc;margin-right:8px">✓</span>Metal-detected 100%</p>'
                    '</div>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
            right=[
                paragraph(
                    '<div style="border-radius:20px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);padding:32px;backdrop-filter:blur(8px)">'
                    '<p style="margin:0 0 6px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(255,255,255,0.55);font-weight:700">Per-lot documentation on file</p>'
                    '<h4 style="margin:0 0 20px;font-size:20px;color:#ffffff;font-weight:800;letter-spacing:-0.01em">Everything a UK / EU / GCC retailer asks for.</h4>'
                    '<ul style="margin:0;padding-left:0;list-style:none;display:grid;gap:10px">'
                    '<li style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5"><span style="color:#7dd3fc;margin-right:10px;font-weight:800">→</span>Certificate of analysis (per active + per finished lot)</li>'
                    '<li style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5"><span style="color:#7dd3fc;margin-right:10px;font-weight:800">→</span>Allergen matrix + &lsquo;may-contain&rsquo; disclosure</li>'
                    '<li style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5"><span style="color:#7dd3fc;margin-right:10px;font-weight:800">→</span>Nutrition panel matching EU/UK label requirements</li>'
                    '<li style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5"><span style="color:#7dd3fc;margin-right:10px;font-weight:800">→</span>Real-time + accelerated stability record</li>'
                    '<li style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5"><span style="color:#7dd3fc;margin-right:10px;font-weight:800">→</span>Country-of-origin for every raw material</li>'
                    '<li style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.5"><span style="color:#7dd3fc;margin-right:10px;font-weight:800">→</span>On-pack claim library (EFSA-compliant wording)</li>'
                    '</ul></div>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
        ),
    ],
)


# --- 6. TIME TO MARKET --------------------------------------------
def _timeline_card(step, title, body):
    return paragraph(
        f'<div style="border-radius:14px;border:1px solid #e5e9f0;background:#ffffff;padding:24px;height:100%">'
        f'<p style="margin:0 0 8px;font-size:11px;letter-spacing:0.22em;text-transform:uppercase;color:{BRAND_BLUE};font-weight:800">Step {step}</p>'
        f'<h3 style="margin:0 0 8px;font-size:19px;font-weight:800;color:{INK};letter-spacing:-0.01em">{title}</h3>'
        f'<p style="margin:0;font-size:14px;line-height:1.6;color:#556170">{body}</p>'
        f'</div>',
        padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
    )


TIME_TO_MARKET = section(
    bg=SLATE_100,
    padding=_pad(top=88, bottom=88),
    max_width=1200,
    align="left",
    content=[
        paragraph(
            f'<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:11px;font-weight:700;color:{BRAND_BLUE};margin:0">Launch timeline</p>',
            padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
        ),
        heading(
            "Ship in weeks, not months.",
            level="h2",
            color=INK,
            padding={"top": 0, "right": 0, "bottom": 20, "left": 0},
        ),
        paragraph(
            '<p style="font-size:16px;line-height:1.7;color:#4b5568;margin:0;max-width:640px">Because the formulation is done, the packaging is validated and the stability record is on file, you get from &lsquo;interested&rsquo; to &lsquo;first pallet on a truck&rsquo; in around six weeks.</p>',
            padding={"top": 0, "right": 0, "bottom": 40, "left": 0},
        ),
        columns(
            cols=3,
            gap=20,
            left=[
                _timeline_card(
                    "01",
                    "Sample kit + spec review",
                    "You request a sample; we ship the finished drink + a redacted spec sheet within 3 working days. Your team tastes it, reads the spec, decides.",
                ),
            ],
            middle=[
                _timeline_card(
                    "02",
                    "Artwork + first order",
                    "Send us your artwork on our template; we handle print-ready proofs. Deposit taken; first batch scheduled into our production window.",
                ),
            ],
            right=[
                _timeline_card(
                    "03",
                    "Production + delivery",
                    "Batch produced, QC-released, palletised, delivered. You get the CoA, allergen sheet and traceability record before the truck moves.",
                ),
            ],
        ),
    ],
)


# --- 7. PACKAGING ROWS --------------------------------------------
PACKAGING = section(
    bg=WHITE,
    padding=_pad(top=88, bottom=88),
    max_width=1200,
    align="left",
    content=[
        columns(
            cols=2,
            gap=48,
            left=[
                paragraph(
                    f'<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:11px;font-weight:700;color:{BRAND_BLUE};margin:0">Packaging</p>',
                    padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
                ),
                heading(
                    "Pick your format. We handle the rest.",
                    level="h2",
                    color=INK,
                    padding={"top": 0, "right": 0, "bottom": 20, "left": 0},
                ),
                paragraph(
                    '<p style="font-size:16px;line-height:1.7;color:#4b5568;margin:0 0 16px">Two production-ready packaging formats, both stability-tested against the finished formula. Full-colour artwork on your chosen substrate — matte, gloss or soft-touch.</p>'
                    '<p style="font-size:14px;line-height:1.6;color:#556170;margin:0"><strong style="color:#0b1220">Sample kits</strong> arrive in the exact format you&rsquo;ll ship in — so your team tastes and evaluates the real thing before committing to a first production run.</p>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
            right=[
                paragraph(
                    '<div style="display:grid;gap:14px">'
                    f'<div style="border:1px solid #e5e9f0;border-radius:16px;padding:22px;background:#fbfcfe">'
                    f'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><p style="margin:0;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:{BRAND_BLUE};font-weight:800">Option A</p><span style="background:{BRAND_BLUE};color:#fff;padding:3px 10px;border-radius:999px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;font-weight:800">Recommended</span></div>'
                    f'<h3 style="margin:0 0 6px;font-size:18px;font-weight:800;color:{INK}">Single-serve sachet · 12 g</h3>'
                    '<p style="margin:0;font-size:14px;line-height:1.6;color:#556170">Foil-laminate sachet, box of 30. On-the-go, retail-ready, tamper-evident. Best margin per unit for online / DTC.</p>'
                    '</div>'
                    '<div style="border:1px solid #e5e9f0;border-radius:16px;padding:22px;background:#fbfcfe">'
                    f'<p style="margin:0 0 8px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:{BRAND_BLUE};font-weight:800">Option B</p>'
                    f'<h3 style="margin:0 0 6px;font-size:18px;font-weight:800;color:{INK}">Multi-serve tub · 300 g</h3>'
                    '<p style="margin:0;font-size:14px;line-height:1.6;color:#556170">HDPE tub with tamper seal + scoop. 25-serving format. Better fit for gym-brand retail lines and subscription boxes.</p>'
                    '</div>'
                    '</div>',
                    padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
                ),
            ],
        ),
    ],
)


# --- 8. FINAL CTA BAND --------------------------------------------
FINAL_CTA = section(
    bg=ACCENT,
    text_color=WHITE,
    padding=_pad(top=96, bottom=96),
    max_width=980,
    align="center",
    content=[
        paragraph(
            '<p style="letter-spacing:0.24em;text-transform:uppercase;font-size:12px;font-weight:700;color:rgba(255,255,255,0.85);margin:0">Ready when you are</p>',
            align="center",
            padding={"top": 0, "right": 0, "bottom": 12, "left": 0},
        ),
        heading(
            "Try it before you brand it.",
            level="h2",
            align="center",
            color=WHITE,
            padding={"top": 0, "right": 0, "bottom": 16, "left": 0},
        ),
        paragraph(
            '<p style="font-size:18px;line-height:1.6;color:rgba(255,255,255,0.92);margin:0;max-width:640px;margin-left:auto;margin-right:auto">Sample kit ships in 3 working days. Full spec sheet + on-pack claim library included. £45 refundable against your first production order.</p>',
            align="center",
            padding={"top": 0, "right": 0, "bottom": 28, "left": 0},
        ),
        button(
            "Request the sample kit",
            href="#sample",
            variant="secondary",
            size="lg",
            align="center",
            padding={"top": 0, "right": 0, "bottom": 0, "left": 0},
        ),
    ],
)


PAGE = {
    "root": {"props": {"title": "Ultimate Fat Burner Drink — product page"}},
    "content": [
        HERO,
        VALUE_PILLARS,
        INGREDIENTS,
        SCIENCE,
        MANUFACTURING,
        TIME_TO_MARKET,
        PACKAGING,
        FINAL_CTA,
    ],
    "zones": {},
}


# --------------------------------------------------------------------
# Apply
# --------------------------------------------------------------------

f = Formulation.objects.filter(rtg_slug=SLUG).first()
if f is None:
    print(f"No formulation with rtg_slug={SLUG!r} — aborting.")
else:
    f.rtg_page_content = PAGE
    f.save(update_fields=["rtg_page_content"])
    block_count = len(PAGE["content"])
    print(f"Applied — {block_count} top-level blocks written to {f.name!r}.")
