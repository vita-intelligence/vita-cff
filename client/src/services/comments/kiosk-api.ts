/**
 * Kiosk (public) comment endpoints.
 *
 * These endpoints live under ``/api/public/specifications/<token>/``
 * and do not require cookie auth — the server issues its own signed
 * kiosk session cookie during ``identify``. We use ``fetch`` directly
 * rather than the shared Axios client so the identify / comment
 * flow is not tangled with the authenticated refresh interceptor.
 */

import type { CommentDto, PaginatedCommentsDto } from "./types";


export interface KioskIdentityInput {
  readonly name: string;
  readonly email: string;
  readonly company?: string;
}


export interface KioskIdentityEcho {
  readonly name: string;
  readonly email: string;
  readonly company: string;
}


async function handleJson<T>(res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  // Mirror the shape ``apiClient`` surfaces on 4xx / 5xx so the
  // kiosk callers can share the same ``translateCode`` helper.
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  const err = new Error(`kiosk_http_${res.status}`) as Error & {
    readonly status?: number;
    readonly body?: string;
  };
  (err as unknown as { status: number }).status = res.status;
  (err as unknown as { body: string }).body = bodyText;
  throw err;
}


function kioskBaseUrl(token: string): string {
  return `/api/public/specifications/${token}`;
}


/** Compute the kiosk base URL for either share surface.
 *
 * The spec kiosk lives under ``/api/public/specifications/<token>``
 * and the proposal kiosk under ``/api/public/proposals/<token>``.
 * Callers either pass a full override (``basePath``) or let the
 * default pick the spec URL so the legacy comments flow keeps
 * working untouched. The ``KioskSession`` row is identical on both
 * surfaces — only the URL prefix differs.
 */
function resolveBasePath(
  token: string,
  basePath: string | undefined,
): string {
  return basePath ?? kioskBaseUrl(token);
}


export async function identifyKioskVisitor(
  token: string,
  input: KioskIdentityInput,
  basePath?: string,
): Promise<KioskIdentityEcho> {
  const res = await fetch(`${resolveBasePath(token, basePath)}/identify/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      company: input.company ?? "",
    }),
  });
  return handleJson<KioskIdentityEcho>(res);
}


export async function signOutKioskVisitor(
  token: string,
  basePath?: string,
): Promise<void> {
  await fetch(`${resolveBasePath(token, basePath)}/identify/`, {
    method: "DELETE",
    credentials: "include",
  });
}


export interface KioskAcceptInput {
  readonly name: string;
  readonly email?: string;
  readonly company?: string;
  readonly signature_image: string;
}


export interface KioskAcceptEcho {
  readonly status: "accepted";
  readonly customer_name: string;
  readonly customer_signed_at: string;
}


/** Sign and accept a ``sent`` spec sheet from the kiosk page. The
 * server cross-checks the supplied ``name`` against the active
 * kiosk session cookie so a leaked cookie alone cannot forge a
 * signature under someone else's name. */
export async function acceptKioskSpecification(
  token: string,
  input: KioskAcceptInput,
): Promise<KioskAcceptEcho> {
  const res = await fetch(`${kioskBaseUrl(token)}/accept/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      name: input.name,
      email: input.email ?? "",
      company: input.company ?? "",
      signature_image: input.signature_image,
    }),
  });
  return handleJson<KioskAcceptEcho>(res);
}


export interface FetchKioskCommentsArgs {
  readonly cursorUrl?: string | null;
  readonly includeResolved?: boolean;
}


export async function fetchKioskCommentsPage(
  token: string,
  args: FetchKioskCommentsArgs = {},
): Promise<PaginatedCommentsDto> {
  let url = `${kioskBaseUrl(token)}/comments/`;
  if (args.cursorUrl) {
    const parsed = new URL(args.cursorUrl, "http://placeholder.local");
    url = `${parsed.pathname}${parsed.search}`;
  } else if (args.includeResolved === false) {
    url += "?include_resolved=false";
  }
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  return handleJson<PaginatedCommentsDto>(res);
}


export interface CreateKioskCommentInput {
  readonly body: string;
  readonly parent_id?: string | null;
}


export async function createKioskComment(
  token: string,
  input: CreateKioskCommentInput,
): Promise<CommentDto> {
  const res = await fetch(`${kioskBaseUrl(token)}/comments/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      body: input.body,
      parent_id: input.parent_id ?? null,
    }),
  });
  return handleJson<CommentDto>(res);
}
