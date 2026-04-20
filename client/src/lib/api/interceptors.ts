/**
 * Axios interceptor wiring.
 *
 * Cross-cutting concerns:
 *
 * - **request**: stamp every outbound call with a consistent ``Accept``
 *   header and default JSON content type.
 * - **response**: on a 401 from a protected endpoint, transparently
 *   call ``POST /api/auth/refresh/`` and replay the original request
 *   so the user never sees an expired access token. Concurrent 401s
 *   during a single refresh are queued and replayed after the refresh
 *   completes so we never issue multiple refresh calls at once.
 * - All errors, before or after refresh, are normalised into
 *   :class:`ApiError` so downstream hooks never see raw Axios errors.
 */

import type {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

import { ApiError, normalizeApiError } from "./errors";

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean;
}

/** Path segment used by the locked-workspace landing page. */
const WORKSPACE_LOCKED_PATH = "/workspace-locked";
/** Error code the backend returns on an inactive-org 403. */
const ORGANIZATION_INACTIVE_CODE = "organization_inactive";

/**
 * Redirect the browser to the ``workspace-locked`` landing page,
 * preserving the current locale prefix if one is present. Runs as a
 * hard navigation rather than a router push so any stale client
 * caches are cleared — an inactive workspace should render nothing
 * from the authed shell.
 */
function redirectToWorkspaceLocked(): void {
  if (typeof window === "undefined") return;
  const { pathname, search } = window.location;
  if (pathname.startsWith(WORKSPACE_LOCKED_PATH)) return;
  const match = pathname.match(/^\/([a-z]{2})(?:\/|$)/);
  const localePrefix = match ? `/${match[1]}` : "";
  if (pathname.startsWith(`${localePrefix}${WORKSPACE_LOCKED_PATH}`)) return;
  const target = `${localePrefix}${WORKSPACE_LOCKED_PATH}`;
  // ``assign`` keeps the original entry in the history stack so the
  // user can hit back after activation and resume what they were
  // doing (the page gate will re-check at that point).
  window.location.assign(
    `${target}?from=${encodeURIComponent(pathname + search)}`,
  );
}

/**
 * Requests that must never trigger a refresh. Hitting any of these
 * with a 401 means the refresh attempt itself would be pointless (the
 * endpoint is how you *get* a session, not how you extend one).
 */
const REFRESH_BYPASS_PATHS: readonly string[] = [
  "/api/auth/login/",
  "/api/auth/register/",
  "/api/auth/logout/",
  "/api/auth/refresh/",
];

function shouldSkipRefresh(url: string | undefined): boolean {
  if (!url) return true;
  return REFRESH_BYPASS_PATHS.some((path) => url.includes(path));
}

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
  // Module-scoped state for the refresh coordinator. We intentionally
  // lift this out of the handler so concurrent 401s share one refresh.
  let isRefreshing = false;
  let pendingQueue: Array<(error?: ApiError) => void> = [];

  const drainQueue = (error?: ApiError) => {
    const queue = pendingQueue;
    pendingQueue = [];
    for (const cb of queue) cb(error);
  };

  instance.interceptors.response.use(
    (response: AxiosResponse): AxiosResponse => response,
    async (error: unknown): Promise<never | AxiosResponse> => {
      const axiosError = error as AxiosError;
      const originalRequest = axiosError.config as RetryableConfig | undefined;
      const status = axiosError.response?.status;

      // Anything that is not a 401, or we cannot retry safely, becomes
      // a plain :class:`ApiError`. Before we reject we inspect the
      // payload for the inactive-org sentinel — a 403 with that code
      // means every authed page the user is looking at is about to
      // render stale data, so we hard-redirect to the locked page
      // first and let the rejected promise also bubble up for any
      // caller that needs it.
      if (
        status !== 401 ||
        !originalRequest ||
        originalRequest._retried ||
        shouldSkipRefresh(originalRequest.url)
      ) {
        const apiErr = normalizeApiError(error);
        if (
          apiErr.status === 403 &&
          apiErr.code === ORGANIZATION_INACTIVE_CODE
        ) {
          redirectToWorkspaceLocked();
        }
        return Promise.reject(apiErr);
      }

      originalRequest._retried = true;

      if (isRefreshing) {
        // Wait for the in-flight refresh to finish, then replay.
        return new Promise<AxiosResponse>((resolve, reject) => {
          pendingQueue.push((queuedError) => {
            if (queuedError) {
              reject(queuedError);
              return;
            }
            instance(originalRequest).then(resolve).catch(reject);
          });
        });
      }

      isRefreshing = true;
      try {
        await instance.post("/api/auth/refresh/");
      } catch (refreshError) {
        // Refresh itself failed — the refresh cookie is dead or the
        // server is unreachable. Drain the queue with the original
        // 401 so every waiting request rejects consistently, then
        // propagate the original error for the caller to handle.
        const apiErr = normalizeApiError(error);
        drainQueue(apiErr);
        isRefreshing = false;
        return Promise.reject(apiErr);
      }

      // Refresh succeeded. Release waiters and replay the original.
      drainQueue();
      isRefreshing = false;
      try {
        return await instance(originalRequest);
      } catch (replayError) {
        return Promise.reject(normalizeApiError(replayError));
      }
    },
  );
}
