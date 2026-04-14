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
    timeout: 15_000,
    headers: {
      Accept: "application/json",
    },
  });
  attachRequestInterceptors(instance);
  attachResponseInterceptors(instance);
  return instance;
}

export const apiClient: AxiosInstance = createApiClient();
