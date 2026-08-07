"use client";

/**
 * Puck custom field for per-breakpoint padding.
 *
 * Value shape (v2 — responsive):
 *   {
 *     mobile:  { top, right, bottom, left },     // required baseline
 *     tablet?: { top?, right?, bottom?, left? }, // partial override
 *     desktop?:{ top?, right?, bottom?, left? }, // partial override
 *   }
 *
 * Legacy shape (v1 — flat): { top, right, bottom, left }
 * is auto-migrated to { mobile: <flat> } on read so old pages keep
 * working without a data migration.
 *
 * The block ``render`` function pairs this with ``paddingStyle`` in
 * ``./config`` — that helper writes CSS custom properties per
 * breakpoint, and ``globals.css`` resolves them via ``@container``
 * queries so padding actually differs when the preview is set to
 * mobile / tablet / desktop.
 *
 * Using ``@container`` (not ``@media``) is deliberate: the page
 * builder's viewport toggle constrains the preview element's
 * width, but the browser window stays the same. Container queries
 * respond to element width, so "mobile preview" behaves like a
 * real narrow viewport without an iframe.
 */

import { useState } from "react";
import { Smartphone, Tablet, Monitor, RotateCcw } from "lucide-react";

import { NumberField } from "./number-field";


type Breakpoint = "mobile" | "tablet" | "desktop";

type Side = "top" | "right" | "bottom" | "left";

interface PaddingSet {
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  left?: number | string;
}

export interface ResponsivePadding {
  mobile: PaddingSet;
  tablet?: PaddingSet;
  desktop?: PaddingSet;
}


// Detect legacy flat shape ({top, right, bottom, left}) and lift it
// into { mobile: <flat> } so the rest of the system only ever sees
// the responsive shape.
export function normalizeResponsivePadding(
  value: unknown,
): ResponsivePadding {
  if (!value || typeof value !== "object") {
    return { mobile: { top: 0, right: 0, bottom: 0, left: 0 } };
  }
  const v = value as Record<string, unknown>;
  const isFlat =
    ("top" in v || "right" in v || "bottom" in v || "left" in v) &&
    !("mobile" in v) &&
    !("tablet" in v) &&
    !("desktop" in v);
  if (isFlat) {
    return { mobile: v as PaddingSet };
  }
  return {
    mobile: (v.mobile as PaddingSet) || {
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    },
    tablet: v.tablet as PaddingSet | undefined,
    desktop: v.desktop as PaddingSet | undefined,
  };
}


interface Props {
  readonly value?: unknown;
  readonly onChange: (value: ResponsivePadding) => void;
  readonly readOnly?: boolean;
}


const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

const TAB_META: Record<
  Breakpoint,
  { label: string; icon: typeof Smartphone; hint: string }
> = {
  mobile: {
    label: "Mobile",
    icon: Smartphone,
    hint: "Base values. Tablet & desktop inherit from here unless overridden.",
  },
  tablet: {
    label: "Tablet",
    icon: Tablet,
    hint: "Overrides mobile at ≥ 640px preview width.",
  },
  desktop: {
    label: "Desktop",
    icon: Monitor,
    hint: "Overrides tablet + mobile at ≥ 1024px preview width.",
  },
};


export function ResponsivePaddingField({
  value,
  onChange,
  readOnly,
}: Props) {
  const [tab, setTab] = useState<Breakpoint>("mobile");
  const normalized = normalizeResponsivePadding(value);
  const active = normalized[tab] || {};

  const setSide = (side: Side, next: number | string | undefined) => {
    const updated: ResponsivePadding = {
      ...normalized,
      [tab]: { ...active, [side]: next },
    };
    onChange(updated);
  };

  const clearOverride = () => {
    if (tab === "mobile") return; // mobile is the baseline, can't clear
    const updated: ResponsivePadding = { mobile: normalized.mobile };
    if (tab === "tablet" && normalized.desktop) {
      updated.desktop = normalized.desktop;
    }
    if (tab === "desktop" && normalized.tablet) {
      updated.tablet = normalized.tablet;
    }
    onChange(updated);
  };

  const hasOverride =
    tab !== "mobile" &&
    normalized[tab] !== undefined &&
    Object.keys(normalized[tab] || {}).length > 0;

  return (
    <div className="pb-resp-pad">
      <div className="pb-resp-pad-tabs" role="tablist">
        {(Object.keys(TAB_META) as Breakpoint[]).map((bp) => {
          const Meta = TAB_META[bp];
          const Icon = Meta.icon;
          const isActive = tab === bp;
          const isOverridden =
            bp !== "mobile" &&
            normalized[bp] !== undefined &&
            Object.keys(normalized[bp] || {}).length > 0;
          return (
            <button
              key={bp}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setTab(bp)}
              className="pb-resp-pad-tab"
              data-active={isActive || undefined}
              data-overridden={isOverridden || undefined}
              disabled={readOnly}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{Meta.label}</span>
              {isOverridden ? (
                <span className="pb-resp-pad-dot" aria-hidden />
              ) : null}
            </button>
          );
        })}
      </div>
      <p className="pb-resp-pad-hint">{TAB_META[tab].hint}</p>
      <div className="pb-resp-pad-grid">
        {SIDES.map((side) => {
          // For non-mobile tabs, show the mobile value as placeholder
          // so authors see what they'd inherit if they leave it blank.
          const inheritedFrom =
            tab !== "mobile"
              ? normalized.tablet?.[side] !== undefined && tab === "desktop"
                ? normalized.tablet[side]
                : normalized.mobile[side]
              : undefined;
          return (
            <div key={side} className="pb-resp-pad-cell">
              <span className="pb-resp-pad-label">{side}</span>
              <NumberField
                value={active[side]}
                onChange={(v) => setSide(side, v)}
                readOnly={readOnly}
                min={0}
                placeholder={
                  inheritedFrom !== undefined && inheritedFrom !== ""
                    ? String(inheritedFrom)
                    : undefined
                }
              />
            </div>
          );
        })}
      </div>
      {hasOverride && !readOnly ? (
        <button
          type="button"
          onClick={clearOverride}
          className="pb-resp-pad-clear"
        >
          <RotateCcw className="h-3 w-3" />
          Clear {TAB_META[tab].label.toLowerCase()} overrides
        </button>
      ) : null}
    </div>
  );
}
