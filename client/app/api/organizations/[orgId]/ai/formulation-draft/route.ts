/**
 * Dedicated route handler for the AI formulation-draft endpoint.
 *
 * Every other ``/api/*`` request goes through the ``rewrites()`` rule
 * in ``next.config.ts``, which is fine for the sub-second CRUD calls
 * that make up the bulk of our traffic. The AI endpoint is different
 * — it blocks for tens of seconds while Ollama generates, and the
 * Next dev rewrite proxy has been observed to drop those connections
 * with ``ECONNRESET`` / "socket hang up" before Django replies.
 *
 * This handler short-circuits the rewrite by running the forward
 * ourselves. We control the fetch, so we control the timeout: five
 * minutes, which is plenty for a cold-start 3B / 8B model on CPU.
 *
 * Route handlers take precedence over rewrites in Next's routing, so
 * dropping this file next to the rewrite-served paths is enough —
 * no extra config change required.
 */

import type { NextRequest } from "next/server";


/** Where Django actually lives. Matches the variable that drives the
 *  rewrite in ``next.config.ts`` so there's a single source of truth. */
const BACKEND_INTERNAL_URL =
  process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:8000";


/**
 * Upper bound on a single AI call. Must stay greater than
 * ``AI_PROVIDER_TIMEOUT_SECONDS`` on the Django side so a provider-
 * level timeout bubbles back as a 504 rather than this abort
 * masking it with a generic client error.
 */
const AI_REQUEST_TIMEOUT_MS = 300_000;


export const dynamic = "force-dynamic";


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
): Promise<Response> {
  const { orgId } = await params;

  const body = await request.text();
  const cookie = request.headers.get("cookie") ?? "";

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort("ai_request_timeout"),
    AI_REQUEST_TIMEOUT_MS,
  );

  try {
    const upstream = await fetch(
      `${BACKEND_INTERNAL_URL}/api/organizations/${orgId}/ai/formulation-draft/`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          // Propagate the auth cookies so DRF sees the same session
          // the browser authenticated with.
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
        // Opt out of Next's data cache for POST — the response is
        // always request-specific and must never leak to other users.
        cache: "no-store",
        signal: controller.signal,
      },
    );

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (err) {
    // Two failure modes matter to the UI:
    // 1. Our own abort (>5 minutes upstream). We mimic Django's
    //    504 so ``extractDraftError`` maps it to the same copy.
    // 2. Anything else (network, upstream crash, etc.) — 502 so the
    //    UI shows the "AI provider misbehaving" copy rather than a
    //    generic "something went wrong".
    const isAbort =
      err instanceof DOMException && err.name === "AbortError";
    const status = isAbort ? 504 : 502;
    const code = isAbort ? "provider_timeout" : "provider_unreachable";
    return new Response(JSON.stringify({ detail: [code] }), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    clearTimeout(timeout);
  }
}
