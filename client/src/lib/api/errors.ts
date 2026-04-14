/**
 * Typed API error shapes and a normalizer.
 *
 * Every HTTP failure in the app is routed through :func:`normalizeApiError`
 * so callers always receive an ``ApiError`` instance — never a raw Axios
 * error, never ``unknown``. That guarantees ``instanceof`` checks in hooks
 * and components are meaningful.
 */

import { AxiosError, type AxiosResponse } from "axios";

/** Shape the Django backend returns for validation errors. */
export type ApiFieldErrors = Record<string, readonly string[]>;

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
  const result: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (key === "detail" || key === "code" || key === "errors") continue;
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      result[key] = value as readonly string[];
    } else if (typeof value === "string") {
      result[key] = [value];
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
    return new ApiError({
      message,
      status,
      code: payload?.code,
      fieldErrors,
      payload: payload ?? undefined,
    });
  }

  if (error instanceof Error) {
    return new ApiError({ message: error.message, status: 0 });
  }

  return new ApiError({ message: "Unknown error", status: 0 });
}
