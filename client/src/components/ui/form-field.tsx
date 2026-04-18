"use client";

import {
  FieldError,
  Input,
  Label,
  TextField,
  type TextFieldRootProps,
} from "@heroui/react";
import { forwardRef } from "react";

/**
 * Field wrapper tailored to our React Hook Form integration.
 *
 * HeroUI v3 exposes ``TextField`` as a composition primitive — consumers
 * assemble ``<Label>``, ``<Input>``, and ``<FieldError>`` themselves. This
 * helper bundles the common layout so forms stay readable while still
 * leaving the underlying pieces reachable if a screen needs custom markup.
 */
export interface FormFieldProps
  extends Omit<TextFieldRootProps, "children" | "type"> {
  label: string;
  placeholder?: string;
  description?: string;
  errorMessage?: string;
  type?: string;
  autoComplete?: string;
}

export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(
  function FormField(
    {
      label,
      placeholder,
      description,
      errorMessage,
      type = "text",
      autoComplete,
      isInvalid,
      isDisabled,
      isRequired,
      name,
      value,
      onChange,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const invalid = Boolean(errorMessage) || Boolean(isInvalid);
    return (
      <TextField
        {...rest}
        name={name}
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        isInvalid={invalid}
        isDisabled={isDisabled}
        isRequired={isRequired}
        className="flex flex-col gap-1.5"
      >
        <Label className="text-xs font-medium text-ink-700">{label}</Label>
        <Input
          ref={ref}
          type={type}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className="w-full rounded-lg bg-ink-0 px-3 py-2 text-sm text-ink-1000 ring-1 ring-inset ring-ink-200 outline-none transition-shadow placeholder:text-ink-400 focus:ring-2 focus:ring-orange-400 data-[invalid=true]:ring-danger/40"
        />
        {description && !invalid ? (
          <p className="text-xs text-ink-500">{description}</p>
        ) : null}
        {invalid && errorMessage ? (
          <FieldError className="text-xs font-medium text-danger">
            {errorMessage}
          </FieldError>
        ) : null}
      </TextField>
    );
  },
);
