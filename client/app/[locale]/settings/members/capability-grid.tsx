"use client";

import { useTranslations } from "next-intl";
import type { Dispatch, SetStateAction } from "react";

import type {
  ModuleDefinitionDto,
  PermissionsDict,
} from "@/services/members";


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

  // Per-capability description used as a hover tooltip + a11y label.
  // Falls back to an empty string so unknown capabilities render
  // without the help indicator instead of crashing.
  const hintFor = (capability: string): string => {
    const key = `${module.key}.${capability}` as "members.view";
    try {
      return tCapabilityHints(key);
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
                slug={slug}
                value={value}
                onChange={onChange}
                disabled={disabled}
              />
            ))
          )}
        </div>
      ) : (
        <CheckboxRow
          capabilities={module.capabilities}
          labelFor={labelFor}
          hintFor={hintFor}
          selected={getFlatCaps(value, module.key)}
          onToggle={(capability, next) =>
            onChange((prev) =>
              toggleFlat(prev, module.key, capability, next),
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
  slug,
  value,
  onChange,
  disabled,
}: {
  moduleKey: string;
  capabilities: readonly string[];
  labelFor: (cap: string) => string;
  hintFor: (cap: string) => string;
  slug: string;
  value: PermissionsDict;
  onChange: Dispatch<SetStateAction<PermissionsDict>>;
  disabled: boolean;
}) {
  const selected = getScopedCaps(value, moduleKey, slug);
  return (
    <div className="rounded-lg bg-ink-0 p-3 ring-1 ring-inset ring-ink-200">
      <p className="mb-2 text-xs font-medium text-ink-1000">{slug}</p>
      <CheckboxRow
        capabilities={capabilities}
        labelFor={labelFor}
        hintFor={hintFor}
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


function CheckboxRow({
  capabilities,
  labelFor,
  hintFor,
  selected,
  onToggle,
  disabled,
}: {
  capabilities: readonly string[];
  labelFor: (cap: string) => string;
  hintFor: (cap: string) => string;
  selected: ReadonlySet<string>;
  onToggle: (capability: string, next: boolean) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {capabilities.map((capability) => {
        const checked = selected.has(capability);
        const hint = hintFor(capability);
        // Native ``title`` is enough for a hover tooltip and gets the
        // accessible name treatment for free; no extra dependency
        // needed and nothing to wire up on the keyboard side beyond
        // the focusable input we already render.
        return (
          <label
            key={capability}
            title={hint || undefined}
            className={
              checked
                ? "flex cursor-pointer items-center gap-2 rounded-lg bg-orange-50 px-3 py-1.5 text-sm text-orange-800 ring-1 ring-inset ring-orange-200"
                : "flex cursor-pointer items-center gap-2 rounded-lg bg-ink-0 px-3 py-1.5 text-sm text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50"
            }
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={(event) => onToggle(capability, event.target.checked)}
              className="h-4 w-4 rounded accent-orange-500"
            />
            <span>{labelFor(capability)}</span>
            {hint ? (
              <span
                aria-hidden="true"
                className="flex h-4 w-4 items-center justify-center rounded-full bg-ink-200/60 text-[10px] font-bold leading-none text-ink-600"
              >
                ?
              </span>
            ) : null}
          </label>
        );
      })}
    </div>
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
