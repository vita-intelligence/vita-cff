/**
 * Typed API error shapes and a normalizer.
 *
 * Every HTTP failure in the app is routed through :func:`normalizeApiError`
 * so callers always receive an ``ApiError`` instance — never a raw Axios
 * error, never ``unknown``. That guarantees ``instanceof`` checks in hooks
 * and components are meaningful.
 */

import { AxiosError, type AxiosResponse } from "axios";

/** Shape the Django backend returns for validation errors.
 *
 * Each top-level key maps either to a list of error codes for that
 * field (the standard DRF shape: ``{"name": ["blank"]}``) OR to a
 * nested object when the field carries a dictionary of sub-errors
 * (DRF nested-serializer shape: ``{"attributes": {"purity":
 * ["invalid"]}}``). Forms read ``fieldErrors.<field>`` for a flat
 * array, and ``fieldErrors.<container>.<sub_field>`` for a nested
 * key -- both paths are populated by :func:`normalizeApiError`. */
export type ApiFieldErrors = Record<
  string,
  readonly string[] | Record<string, readonly string[]>
>;

export interface ApiErrorPayload {
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: ApiFieldErrors;
  readonly [key: string]: unknown;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string | undefined;
  public readonly fieldErrors: ApiFieldErrors;
  public readonly payload: ApiErrorPayload | undefined;

  constructor(args: {
    message: string;
    status: number;
    code?: string;
    fieldErrors?: ApiFieldErrors;
    payload?: ApiErrorPayload;
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.code = args.code;
    this.fieldErrors = args.fieldErrors ?? {};
    this.payload = args.payload;
  }

  get isValidation(): boolean {
    return this.status === 400 || this.status === 422;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isServer(): boolean {
    return this.status >= 500;
  }
}

function extractFieldErrors(data: unknown): ApiFieldErrors {
  if (!data || typeof data !== "object") return {};
  const result: Record<
    string,
    readonly string[] | Record<string, readonly string[]>
  > = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    // ``error`` is a top-level error-code alias emitted by some services
    // (integration controllers, Phoenix-style bodies proxied through
    // NPD). Treated the same as ``code`` in ``normalizeApiError``
    // below; DON'T let it leak into ``fieldErrors`` where the
    // translator would try to resolve it as an i18n code and throw
    // ``MISSING_MESSAGE`` under next-intl strict mode.
    if (key === "detail" || key === "code" || key === "error" || key === "errors") continue;
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      result[key] = value as readonly string[];
    } else if (typeof value === "string") {
      result[key] = [value];
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      // Nested-serializer shape (e.g. ``attributes`` on the catalogue
      // item form). Each child key maps to a string array of codes;
      // anything that isn't a clean array is coerced into one or
      // skipped so a malformed branch doesn't corrupt the whole map.
      const nested: Record<string, readonly string[]> = {};
      for (const [subKey, subValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (
          Array.isArray(subValue) &&
          subValue.every((v) => typeof v === "string")
        ) {
          nested[subKey] = subValue as readonly string[];
        } else if (typeof subValue === "string") {
          nested[subKey] = [subValue];
        }
      }
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    }
  }
  return result;
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof AxiosError) {
    const response = error.response as AxiosResponse<ApiErrorPayload> | undefined;
    const status = response?.status ?? 0;
    const payload = response?.data;
    const fieldErrors = extractFieldErrors(payload);
    const message =
      payload?.detail ?? error.message ?? "Request failed. Please try again.";
    // Accept either ``code`` (Django/DRF convention) or ``error``
    // (Phoenix / integration-controller convention). NPD forwards
    // PSP's 4xx bodies verbatim, and those use ``error``. Preferring
    // ``code`` when both are present keeps the Django-native behaviour
    // stable.
    const codeAlias =
      typeof payload?.code === "string"
        ? payload.code
        : typeof payload?.error === "string"
          ? (payload.error as string)
          : undefined;
    return new ApiError({
      message,
      status,
      code: codeAlias,
      fieldErrors,
      payload: payload ?? undefined,
    });
  }

  if (error instanceof Error) {
    return new ApiError({ message: error.message, status: 0 });
  }

  return new ApiError({ message: "Unknown error", status: 0 });
}
