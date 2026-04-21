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


export async function identifyKioskVisitor(
  token: string,
  input: KioskIdentityInput,
): Promise<KioskIdentityEcho> {
  const res = await fetch(`${kioskBaseUrl(token)}/identify/`, {
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


export async function signOutKioskVisitor(token: string): Promise<void> {
  await fetch(`${kioskBaseUrl(token)}/identify/`, {
    method: "DELETE",
    credentials: "include",
  });
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
