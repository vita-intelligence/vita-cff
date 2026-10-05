/**
 * Shared Axios client.
 *
 * The client issues **same-origin** relative requests. Every call resolves
 * to the same host Next is serving, which means the browser sees a single
 * origin and the httpOnly auth cookie set by the backend lives on that
 * origin — which in turn means ``next/headers.cookies()`` inside server
 * components can actually read it. The Next ``rewrites()`` rule in
 * ``next.config.ts`` forwards ``/api/*`` to the real Django instance
 * server-to-server.
 */

import axios, { type AxiosInstance } from "axios";

import { attachRequestInterceptors, attachResponseInterceptors } from "./interceptors";

function createApiClient(): AxiosInstance {
  const instance = axios.create({
    baseURL: "",
    withCredentials: true,
    // Bumped from 15 s to 60 s because any endpoint that triggers
    // the synchronous PSP push cascade (save-version, stage
    // upsert, line replace with routing changes) can legitimately
    // run 20–40 s against a cold-start / un-paginated PSP, and
    // the shared default was aborting them with the "Network error"
    // toast while the backend quietly committed. Per-call overrides
    // (e.g. ``saveFormulationVersion``'s 120 s) remain in place for
    // the slowest cascades; this value protects every other mutation.
    timeout: 60_000,
    headers: {
      Accept: "application/json",
    },
    // Repeat-format array serialization: ``?status=a&status=b``
    // instead of the default ``?status[]=a&status[]=b``. DRF's
    // ``request.query_params.getlist("status")`` reads the repeat
    // form, and using the same serialization for every endpoint
    // keeps the filter-bar contract obvious from one shared spot
    // rather than per-call ``paramsSerializer`` overrides.
    paramsSerializer: { indexes: null },
  });
  attachRequestInterceptors(instance);
  attachResponseInterceptors(instance);
  return instance;
}

export const apiClient: AxiosInstance = createApiClient();
