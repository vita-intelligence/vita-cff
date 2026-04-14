/**
 * Axios interceptor wiring.
 *
 * The interceptors are kept stateless and side-effect free where possible so
 * they are easy to unit test. Cross-cutting concerns that live here:
 *
 * - request: stamp every outbound call with a consistent ``Accept`` header
 * - response: unwrap successful responses and normalise errors into
 *   :class:`ApiError` so downstream hooks never see raw Axios errors.
 */

import type {
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

import { normalizeApiError } from "./errors";

export function attachRequestInterceptors(instance: AxiosInstance): void {
  instance.interceptors.request.use(
    (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
      config.headers.set("Accept", "application/json");
      if (!config.headers.has("Content-Type") && config.data !== undefined) {
        config.headers.set("Content-Type", "application/json");
      }
      return config;
    },
  );
}

export function attachResponseInterceptors(instance: AxiosInstance): void {
  instance.interceptors.response.use(
    (response: AxiosResponse): AxiosResponse => response,
    (error: unknown): Promise<never> => Promise.reject(normalizeApiError(error)),
  );
}
