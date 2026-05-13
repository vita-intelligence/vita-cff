"use client";

import { useTranslations } from "next-intl";
import type { Dispatch, SetStateAction } from "react";

import type {
  ModuleDefinitionDto,
  PermissionsDict,
} from "@/services/members";


// ---------------------------------------------------------------------------
// Mirrored capability pairs across the formulations + proposals modules.
//
// The proposals module was split off formulations so commercial roles
// could be granted the proposal pipeline without project-edit access
// — but for several capabilities the split has no day-to-day meaning:
// an "approver" approves on both surfaces; an "approvals queue
// viewer" wants both tabs; the "delete" role applies equally on
// either side. The admin grid used to render two identically-labelled
// checkboxes for each pair (one under Projects, one under Proposals),
// making it easy to grant half and leave the user with a partial
// surface.
//
// We collapse the duplicates here: the PRIMARY half (under
// ``formulations``) is the visible checkbox; the MIRROR half (under
// ``proposals``) is hidden. Toggling the visible checkbox sets or
// clears BOTH halves atomically. The on-disk permissions shape is
// unchanged — every server-side capability check keeps reading the
// same two keys.
//
// Pairs live as tuples ``[primary, mirror]`` keyed by
// ``"<module>:<capability>"``. Adding a new pair only requires one
// entry here and the appropriate label / hint on the formulations
// side of the i18n bundle.
const CAP_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["formulations:view_approvals", "proposals:view_approvals"],
  ["formulations:view_signed", "proposals:view_signed"],
  ["formulations:approve", "proposals:approve"],
  ["formulations:delete", "proposals:delete"],
  ["formulations:sign_spec", "proposals:sign"],
  // ``assign_sales_person`` was previously paired here, but
  // ``proposals.assign_sales_person`` was dead code — only
  // ``formulations.assign_sales_person`` is enforced server-side
  // (project-level sales-person assignment). Migration
  // ``organizations.0009_rbac_pair_normalisation`` strips the
  // dead grant from existing memberships.
];

// Pre-computed sets for hot-path lookups inside the render tree.
const MIRROR_HIDDEN_KEYS = new Set(
  CAP_PAIRS.map(([, mirror]) => mirror),
);
const PRIMARY_TO_MIRROR = new Map(CAP_PAIRS);
const MIRROR_TO_PRIMARY = new Map(
  CAP_PAIRS.map(([primary, mirror]) => [mirror, primary] as const),
);


function key(moduleKey: string, capability: string): string {
  return `${moduleKey}:${capability}`;
}


function splitKey(combined: string): [string, string] {
  const idx = combined.indexOf(":");
  return [combined.slice(0, idx), combined.slice(idx + 1)];
}


/**
 * Reusable capability picker that drives both the "Edit member
 * permissions" drawer and the invite-new-member form.
 *
 * For flat modules it renders a single row of capability checkboxes.
 * For row-scoped modules (``catalogues``) it renders one row per
 * known slug — the caller passes the slugs discovered via the
 * catalogue list. A special "All catalogues" slug row is offered
 * with ``allowBulkRowScoped`` so admins can grant "view all
 * catalogues" in one click without iterating every slug.
 *
 * The grid is controlled — the parent owns a ``PermissionsDict``
 * draft and threads updates back through :func:`onChange`.
 */
export function CapabilityGrid({
  modules,
  catalogueSlugs,
  value,
  onChange,
  disabled = false,
}: {
  modules: readonly ModuleDefinitionDto[];
  catalogueSlugs: readonly string[];
  value: PermissionsDict;
  onChange: Dispatch<SetStateAction<PermissionsDict>>;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      {modules.map((module) => (
        <ModuleBlock
          key={module.key}
          module={module}
          catalogueSlugs={catalogueSlugs}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      ))}
    </div>
  );
}


function ModuleBlock({
  module,
  catalogueSlugs,
  value,
  onChange,
  disabled,
}: {
  module: ModuleDefinitionDto;
  catalogueSlugs: readonly string[];
  value: PermissionsDict;
  onChange: Dispatch<SetStateAction<PermissionsDict>>;
  disabled: boolean;
}) {
  const tCapabilities = useTranslations("settings.capabilities");
  const tCapabilityHints = useTranslations("settings.capability_hints");
  const tCapabilityPages = useTranslations("settings.capability_pages");
  const tModules = useTranslations("settings.modules");
  const tRolePresets = useTranslations("settings.role_presets");

  // Safe label lookup — unknown keys fall back to the raw string so a
  // new capability shipped from the backend without a translation
  // still renders readable.
  const labelFor = (capability: string): string => {
    const key = `${module.key}.${capability}` as "members.view";
    try {
      return tCapabilities(key);
    } catch {
      return capability.replace(/_/g, " ");
    }
  };

  // Per-capability long-form description. Same fallback pattern as
  // the label so a brand-new capability shipped without an i18n
  // entry renders an empty description rather than crashing.
  const hintFor = (capability: string): string => {
    const key = `${module.key}.${capability}` as "members.view";
    try {
      return tCapabilityHints(key);
    } catch {
      return "";
    }
  };

  // Concrete pages / surfaces the capability gates. Surfaced
  // inline so admins editing a member's role know exactly which
  // routes they are opening up — way less guessing than the old
  // hover-tooltip-only view. Falls back to empty if not yet
  // translated.
  const pagesFor = (capability: string): string => {
    const key = `${module.key}.${capability}` as "members.view";
    try {
      return tCapabilityPages(key);
    } catch {
      return "";
    }
  };

  const moduleName = (() => {
    const key = module.key as "members";
    try {
      return tModules(key);
    } catch {
      return module.name;
    }
  })();

  const moduleDescription = (() => {
    const key = `${module.key}_description` as "members_description";
    try {
      return tModules(key);
    } catch {
      return module.description;
    }
  })();

  // Common-role hints rendered in the module footer. Both lookups
  // are wrapped so a missing translation produces no footer rather
  // than a render-time crash.
  const rolePresetLabel = (() => {
    const key = `${module.key}_label` as "members_label";
    try {
      return tRolePresets(key);
    } catch {
      return "";
    }
  })();

  const rolePresetText = (() => {
    const key = module.key as "members";
    try {
      return tRolePresets(key);
    } catch {
      return "";
    }
  })();

  return (
    <section className="rounded-xl bg-ink-50 p-4 ring-1 ring-inset ring-ink-200">
      <header className="mb-3">
        <h4 className="text-sm font-semibold text-ink-1000">{moduleName}</h4>
        <p className="mt-0.5 text-xs text-ink-500">{moduleDescription}</p>
      </header>

      {module.row_scoped ? (
        <div className="flex flex-col gap-2">
          {catalogueSlugs.length === 0 ? (
            <p className="rounded-lg bg-ink-0 px-3 py-2 text-xs text-ink-500 ring-1 ring-inset ring-ink-200">
              {tModules("no_row_scopes")}
            </p>
          ) : (
            catalogueSlugs.map((slug) => (
              <SlugRow
                key={slug}
                moduleKey={module.key}
                capabilities={module.capabilities}
                labelFor={labelFor}
                hintFor={hintFor}
                pagesFor={pagesFor}
                slug={slug}
                value={value}
                onChange={onChange}
                disabled={disabled}
              />
            ))
          )}
        </div>
      ) : (
        <CapabilityList
          // Hide the mirror half of paired capabilities — the
          // visible checkbox sits under the primary module
          // (formulations) and toggles both halves atomically.
          // Without this filter the admin sees two checkboxes
          // with the same label and easily grants only one.
          capabilities={module.capabilities.filter(
            (c) => !MIRROR_HIDDEN_KEYS.has(key(module.key, c)),
          )}
          labelFor={labelFor}
          hintFor={hintFor}
          pagesFor={pagesFor}
          selected={getFlatCapsWithMirror(value, module.key)}
          onToggle={(capability, next) =>
            onChange((prev) =>
              toggleFlatWithMirror(prev, module.key, capability, next),
            )
          }
          disabled={disabled}
        />
      )}

      {rolePresetText ? (
        <footer className="mt-3 rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200">
          {rolePresetLabel ? (
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-500">
              {rolePresetLabel}
            </p>
          ) : null}
          <p className="text-xs leading-relaxed text-ink-700">
            {rolePresetText}
          </p>
        </footer>
      ) : null}
    </section>
  );
}


function SlugRow({
  moduleKey,
  capabilities,
  labelFor,
  hintFor,
  pagesFor,
  slug,
  value,
  onChange,
  disabled,
}: {
  moduleKey: string;
  capabilities: readonly string[];
  labelFor: (cap: string) => string;
  hintFor: (cap: string) => string;
  pagesFor: (cap: string) => string;
  slug: string;
  value: PermissionsDict;
  onChange: Dispatch<SetStateAction<PermissionsDict>>;
  disabled: boolean;
}) {
  const selected = getScopedCaps(value, moduleKey, slug);
  return (
    <div className="rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200">
      <p className="mb-2 text-xs font-medium text-ink-1000">{slug}</p>
      <CapabilityList
        capabilities={capabilities}
        labelFor={labelFor}
        hintFor={hintFor}
        pagesFor={pagesFor}
        selected={selected}
        onToggle={(capability, next) =>
          onChange((prev) =>
            toggleScoped(prev, moduleKey, slug, capability, next),
          )
        }
        disabled={disabled}
      />
    </div>
  );
}


/**
 * Vertical list of per-capability detail cards.
 *
 * Replaces the older horizontal chip-row UX so admins editing a
 * member's role see, for every capability:
 *
 *  - the checkbox + short label,
 *  - the full long-form description (no more hover-only tooltips),
 *  - "Pages affected" — a concrete list of routes / surfaces the
 *    capability gates, so the admin knows exactly what they're
 *    opening up before saving.
 *
 * The vertical layout takes more screen but admins don't edit
 * permissions often — clarity beats density. Hover tooltip on the
 * label preserved as a quick-reference fallback.
 */
function CapabilityList({
  capabilities,
  labelFor,
  hintFor,
  pagesFor,
  selected,
  onToggle,
  disabled,
}: {
  capabilities: readonly string[];
  labelFor: (cap: string) => string;
  hintFor: (cap: string) => string;
  pagesFor: (cap: string) => string;
  selected: ReadonlySet<string>;
  onToggle: (capability: string, next: boolean) => void;
  disabled: boolean;
}) {
  if (capabilities.length === 0) {
    // Possible after the paired-mirror filter on a module that's
    // entirely mirrored away (none today, but safe to handle).
    return null;
  }
  return (
    <div className="flex flex-col gap-2">
      {capabilities.map((capability) => (
        <CapabilityCard
          key={capability}
          capability={capability}
          checked={selected.has(capability)}
          label={labelFor(capability)}
          hint={hintFor(capability)}
          pages={pagesFor(capability)}
          disabled={disabled}
          onToggle={(next) => onToggle(capability, next)}
        />
      ))}
    </div>
  );
}


function CapabilityCard({
  capability,
  checked,
  label,
  hint,
  pages,
  disabled,
  onToggle,
}: {
  capability: string;
  checked: boolean;
  label: string;
  hint: string;
  pages: string;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <label
      // Whole card is a click target — the checkbox visually
      // anchors it but the admin can tap anywhere on the row to
      // toggle. Native ``<label>`` keeps the labelling accessible
      // without aria glue.
      className={`flex cursor-pointer items-start gap-3 rounded-lg p-3 transition-colors ${
        checked
          ? "bg-orange-50 ring-1 ring-inset ring-orange-200"
          : "bg-ink-0 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded accent-orange-500"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={`text-sm font-medium ${
            checked ? "text-orange-900" : "text-ink-1000"
          }`}
        >
          {label}
        </span>
        {hint ? (
          <p className="text-xs leading-snug text-ink-600">{hint}</p>
        ) : null}
        {pages ? (
          <p className="text-[11px] leading-snug text-ink-500">
            <span className="font-semibold uppercase tracking-wide">
              Pages affected:
            </span>{" "}
            {pages}
          </p>
        ) : null}
        {/* Hidden helper — debug aid for missing translations during
            development. The capability key itself is rendered only
            when neither hint nor pages translation resolved, so a
            production build with full i18n stays clean. */}
        {!hint && !pages ? (
          <p className="text-[11px] italic text-ink-400">
            (no description available — capability key:{" "}
            <code>{capability}</code>)
          </p>
        ) : null}
      </div>
    </label>
  );
}


// ---------------------------------------------------------------------------
// Pure helpers — lift state updates out of the render tree so the
// parent can use the ``setState`` functional form safely.
// ---------------------------------------------------------------------------


function getFlatCaps(value: PermissionsDict, moduleKey: string): Set<string> {
  const raw = value[moduleKey];
  if (Array.isArray(raw)) return new Set(raw);
  return new Set();
}


function getScopedCaps(
  value: PermissionsDict,
  moduleKey: string,
  slug: string,
): Set<string> {
  const raw = value[moduleKey];
  if (raw && !Array.isArray(raw) && typeof raw === "object") {
    const inner = raw as Readonly<Record<string, readonly string[]>>;
    const caps = inner[slug];
    if (Array.isArray(caps)) return new Set(caps);
  }
  return new Set();
}


function toggleFlat(
  prev: PermissionsDict,
  moduleKey: string,
  capability: string,
  next: boolean,
): PermissionsDict {
  const current = getFlatCaps(prev, moduleKey);
  if (next) current.add(capability);
  else current.delete(capability);
  const updated: Record<
    string,
    readonly string[] | Readonly<Record<string, readonly string[]>>
  > = { ...prev };
  if (current.size === 0) delete updated[moduleKey];
  else updated[moduleKey] = Array.from(current);
  return updated;
}


/**
 * Like :func:`getFlatCaps` but counts a paired-capability primary as
 * checked whenever EITHER its primary or mirror half is granted on
 * the underlying permissions dict.
 *
 * Reads from both halves so the checkbox visually reflects the
 * real state even on permissions dicts persisted before this grid
 * existed (half-granted rows from manual edits). Pairs always
 * normalise on save via :func:`toggleFlatWithMirror`.
 */
function getFlatCapsWithMirror(
  value: PermissionsDict,
  moduleKey: string,
): Set<string> {
  const own = getFlatCaps(value, moduleKey);
  for (const cap of Array.from(own)) {
    // No-op: surface the primary cap as-is.
    void cap;
  }
  // For every primary cap on this module, also check whether the
  // mirror half is set on the partner module. If so, surface the
  // primary as checked even when only the mirror was granted.
  for (const [primary, mirror] of CAP_PAIRS) {
    const [pmod, pcap] = splitKey(primary);
    if (pmod !== moduleKey) continue;
    const [mmod, mcap] = splitKey(mirror);
    if (getFlatCaps(value, mmod).has(mcap)) {
      own.add(pcap);
    }
  }
  return own;
}


/**
 * Toggle a flat capability and, when the cap participates in a
 * cross-module pair, set / clear its mirror half atomically.
 *
 * This is the function the grid calls on every checkbox click —
 * keeping the mirror sync inside the picker means the wire format
 * still carries both halves, so every server-side
 * ``has_capability(..., 'view_approvals')`` keeps working on either
 * module without aliasing.
 */
function toggleFlatWithMirror(
  prev: PermissionsDict,
  moduleKey: string,
  capability: string,
  next: boolean,
): PermissionsDict {
  let updated = toggleFlat(prev, moduleKey, capability, next);
  const combined = key(moduleKey, capability);
  // Mirror partner: if this cap is the primary half of a pair,
  // propagate the change to the mirror; if it's the mirror half
  // (shouldn't happen via the grid, but defensive against future
  // call-sites), propagate the change to the primary instead.
  const mirror = PRIMARY_TO_MIRROR.get(combined);
  if (mirror) {
    const [mmod, mcap] = splitKey(mirror);
    updated = toggleFlat(updated, mmod, mcap, next);
    return updated;
  }
  const primary = MIRROR_TO_PRIMARY.get(combined);
  if (primary) {
    const [pmod, pcap] = splitKey(primary);
    updated = toggleFlat(updated, pmod, pcap, next);
  }
  return updated;
}


function toggleScoped(
  prev: PermissionsDict,
  moduleKey: string,
  slug: string,
  capability: string,
  next: boolean,
): PermissionsDict {
  const currentSlugMap: Record<string, readonly string[]> = {};
  const raw = prev[moduleKey];
  if (raw && !Array.isArray(raw) && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (Array.isArray(v)) currentSlugMap[k] = v;
    }
  }
  const capsForSlug = new Set(currentSlugMap[slug] ?? []);
  if (next) capsForSlug.add(capability);
  else capsForSlug.delete(capability);

  const updatedSlugMap = { ...currentSlugMap };
  if (capsForSlug.size === 0) {
    delete updatedSlugMap[slug];
  } else {
    updatedSlugMap[slug] = Array.from(capsForSlug);
  }

  const updated: Record<
    string,
    readonly string[] | Readonly<Record<string, readonly string[]>>
  > = { ...prev };
  if (Object.keys(updatedSlugMap).length === 0) {
    delete updated[moduleKey];
  } else {
    updated[moduleKey] = updatedSlugMap;
  }
  return updated;
}
