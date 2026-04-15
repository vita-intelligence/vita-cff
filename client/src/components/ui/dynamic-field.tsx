"use client";

import type { ChangeEvent } from "react";

import { FormField } from "@/components/ui/form-field";
import type { AttributeDefinitionDto } from "@/services/attributes/types";

type DynamicValue = string | number | boolean | readonly string[] | null;

interface DynamicFieldProps {
  definition: AttributeDefinitionDto;
  value: DynamicValue;
  onChange: (value: DynamicValue) => void;
  onBlur?: () => void;
  errorMessage?: string;
  name?: string;
}

/**
 * Render a single typed dynamic attribute as an input control.
 *
 * The component is a thin switch over :attr:`AttributeDefinition.data_type`
 * so the forms themselves stay declarative: iterate the definitions,
 * render one ``<DynamicField>`` per entry, and let this component
 * produce the right control (text, number, toggle, date, select, or
 * checkbox group).
 *
 * Values are always delivered to ``onChange`` in the shape the backend
 * validator expects:
 *
 * * text / date → string (empty string when cleared)
 * * number → string (we keep strings so controlled inputs do not thrash)
 * * boolean → ``boolean``
 * * single_select → string
 * * multi_select → ``string[]``
 */
export function DynamicField({
  definition,
  value,
  onChange,
  onBlur,
  errorMessage,
  name,
}: DynamicFieldProps) {
  const label = `${definition.label}${definition.required ? " *" : ""}`;
  const fieldName = name ?? `attributes.${definition.key}`;

  switch (definition.data_type) {
    case "text":
      return (
        <FormField
          name={fieldName}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v)}
          onBlur={onBlur}
          label={label}
          type="text"
          errorMessage={errorMessage}
        />
      );

    case "number":
      return (
        <FormField
          name={fieldName}
          value={
            value === null || value === undefined ? "" : String(value)
          }
          onChange={(v) => onChange(v === "" ? null : v)}
          onBlur={onBlur}
          label={label}
          type="number"
          errorMessage={errorMessage}
        />
      );

    case "date":
      return (
        <FormField
          name={fieldName}
          value={typeof value === "string" ? value : ""}
          onChange={(v) => onChange(v)}
          onBlur={onBlur}
          label={label}
          type="date"
          errorMessage={errorMessage}
        />
      );

    case "boolean": {
      const checked = value === true;
      return (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-3 text-xs font-bold tracking-widest uppercase text-ink-700">
            <input
              type="checkbox"
              name={fieldName}
              checked={checked}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                onChange(event.target.checked)
              }
              onBlur={onBlur}
              className="h-5 w-5 cursor-pointer appearance-none border-2 border-ink-1000 bg-ink-0 checked:border-ink-1000 checked:bg-ink-1000 focus:outline-none"
            />
            {label}
          </label>
          {errorMessage ? (
            <p className="text-xs font-medium text-danger">{errorMessage}</p>
          ) : null}
        </div>
      );
    }

    case "single_select": {
      const currentValue =
        typeof value === "string" ? value : "";
      return (
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={fieldName}
            className="text-xs font-bold tracking-widest uppercase text-ink-700"
          >
            {label}
          </label>
          <select
            id={fieldName}
            name={fieldName}
            value={currentValue}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              onChange(event.target.value === "" ? null : event.target.value)
            }
            onBlur={onBlur}
            className="w-full cursor-pointer border-2 border-ink-1000 bg-ink-0 px-3 py-2 font-mono text-sm text-ink-1000 outline-none focus:shadow-hard"
          >
            <option value="">—</option>
            {definition.options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {errorMessage ? (
            <p className="text-xs font-medium text-danger">{errorMessage}</p>
          ) : null}
        </div>
      );
    }

    case "multi_select": {
      const selected = new Set<string>(
        Array.isArray(value) ? (value as readonly string[]) : [],
      );
      const toggle = (optionValue: string) => {
        const next = new Set(selected);
        if (next.has(optionValue)) {
          next.delete(optionValue);
        } else {
          next.add(optionValue);
        }
        onChange(Array.from(next));
      };
      return (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold tracking-widest uppercase text-ink-700">
            {label}
          </span>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {definition.options.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-center gap-2 border-2 border-ink-1000 bg-ink-0 px-3 py-2 text-sm text-ink-1000 hover:bg-ink-100"
              >
                <input
                  type="checkbox"
                  checked={selected.has(opt.value)}
                  onChange={() => toggle(opt.value)}
                  onBlur={onBlur}
                  className="h-4 w-4 appearance-none border-2 border-ink-1000 bg-ink-0 checked:bg-ink-1000"
                />
                <span className="font-mono text-xs">{opt.label}</span>
              </label>
            ))}
          </div>
          {errorMessage ? (
            <p className="text-xs font-medium text-danger">{errorMessage}</p>
          ) : null}
        </div>
      );
    }

    default:
      return null;
  }
}
