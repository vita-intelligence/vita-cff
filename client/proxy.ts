import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { routing } from "@/i18n/routing";

const intlMiddleware = createMiddleware(routing);

/**
 * Cookie names as seen by the browser. The Next rewrite surfaces the
 * backend at the same origin as the app, so both cookies are readable
 * here through :func:`request.cookies`.
 */
const ACCESS_COOKIE = "vita_access";
const REFRESH_COOKIE = "vita_refresh";

/**
 * Refresh only once the access token is actually expired (or within this
 * many seconds of expiry). Paying a round-trip to the backend on every
 * page load would be absurd — 30 s of skew tolerance keeps us safe
 * without being chatty.
 */
const EXPIRY_SKEW_SECONDS = 30;

const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.BACKEND_INTERNAL_URL ??
  "http://127.0.0.1:8000";


/**
 * Decode a JWT's ``exp`` claim without verifying the signature — the
 * middleware doesn't need to trust the token, it just needs to know
 * whether to renew it. The backend still verifies every request.
 *
 * Returns ``null`` if the token is malformed, which we treat as
 * "expired" so the refresh path still fires.
 */
function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payloadJson = Buffer.from(
      parts[1]!.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf-8");
    const payload = JSON.parse(payloadJson) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}


function isTokenExpiredOrClose(token: string | undefined): boolean {
  if (!token) return true;
  const exp = decodeJwtExp(token);
  if (exp === null) return true;
  return Date.now() >= (exp - EXPIRY_SKEW_SECONDS) * 1000;
}


interface RefreshResult {
  readonly setCookies: readonly string[];
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
}


/**
 * Hard ceiling on a single proxy refresh round-trip. The backend
 * runs single-process Daphne; under shared-WiFi load (multiple users
 * navigating simultaneously) sync views can queue behind one another
 * and a refresh that would normally take ~30ms can balloon past the
 * Edge runtime's overall request budget. Bailing fast lets the
 * downstream page guard fall back to its server-side refresh /
 * redirect path instead of stalling the whole navigation.
 */
const REFRESH_TIMEOUT_MS = 4_000;


/**
 * POST ``/api/auth/refresh/`` using the current refresh cookie. Returns
 * the raw ``Set-Cookie`` headers plus the parsed token values so we can
 * both (a) rewrite the inbound request's cookies (so SSR sees the fresh
 * access token on this very same render) and (b) forward the cookies to
 * the browser through the outgoing response.
 */
async function attemptRefresh(
  refreshToken: string,
): Promise<RefreshResult | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BACKEND_URL}/api/auth/refresh/`, {
      method: "POST",
      headers: {
        Cookie: `${REFRESH_COOKIE}=${refreshToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) return null;

    // ``getSetCookie`` returns each Set-Cookie as a separate entry in
    // Node 20+. This is the only safe way — the cookies are
    // comma-embedded inside a single header when joined naively.
    const headers = res.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const setCookies = headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) return null;

    let accessToken: string | null = null;
    let refreshTokenNext: string | null = null;
    for (const cookie of setCookies) {
      const [nameValue] = cookie.split(";", 1);
      const eqIdx = nameValue!.indexOf("=");
      if (eqIdx === -1) continue;
      const name = nameValue!.slice(0, eqIdx).trim();
      const value = nameValue!.slice(eqIdx + 1).trim();
      if (name === ACCESS_COOKIE) accessToken = value;
      else if (name === REFRESH_COOKIE) refreshTokenNext = value;
    }
    return { setCookies, accessToken, refreshToken: refreshTokenNext };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}


/** Header name used to surface the inbound pathname to server pages. */
const APP_PATHNAME_HEADER = "x-app-pathname";

export default async function proxy(
  request: NextRequest,
): Promise<NextResponse> {
  const accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;

  // Preemptive refresh: if the refresh cookie is still good but the
  // access cookie is missing / expired / close to expiry, swap in a
  // fresh pair before the Server Components run. This is what the
  // browser's Axios interceptor does for client-triggered XHRs, just
  // moved up the chain so SSR navigations stop booting the user to
  // ``/login`` while a valid refresh cookie is sitting there.
  let refreshed: RefreshResult | null = null;
  if (refreshToken && isTokenExpiredOrClose(accessToken)) {
    refreshed = await attemptRefresh(refreshToken);
  }

  // Mirror the new tokens back onto ``request.cookies`` so the
  // downstream :func:`getCurrentUserServer` (and every sibling server
  // fetch) forwards the fresh access cookie when it probes the backend.
  // The Edge runtime's ``RequestCookies.set`` side-effects through to
  // ``request.headers["cookie"]``, so next-intl's ``new Headers(...)``
  // pickup at line ``createMiddleware`` captures the rotated value.
  // We also rebuild the ``cookie`` header explicitly as a belt-and-
  // braces defence: under load some Edge runtime builds have been
  // observed to skip the header sync, which would leave server
  // components reading stale cookies on the same render that just
  // rotated them.
  if (refreshed?.accessToken) {
    request.cookies.set(ACCESS_COOKIE, refreshed.accessToken);
  }
  if (refreshed?.refreshToken) {
    request.cookies.set(REFRESH_COOKIE, refreshed.refreshToken);
  }
  if (refreshed) {
    const rebuilt = request.cookies
      .getAll()
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");
    request.headers.set("cookie", rebuilt);
  }

  // Surface the inbound pathname on the *request* headers (not the
  // response) so ``next/headers.headers()`` inside server components
  // sees it. ``intlMiddleware`` does ``new Headers(request.headers)``
  // internally and forwards that copy through ``NextResponse.next``,
  // so anything we add here survives the locale-routing layer and
  // reaches the page guards downstream.
  const pathnameWithSearch =
    request.nextUrl.pathname + (request.nextUrl.search ?? "");
  request.headers.set(APP_PATHNAME_HEADER, pathnameWithSearch);

  const response = intlMiddleware(request);

  // Strip the leaked container port from any absolute ``Location``
  // header next-intl emits for its locale-canonicalisation redirects.
  //
  // Behind Azure App Service the container binds to the internal
  // port (3000 — see ``Dockerfile.PORT``) and Next.js builds
  // absolute redirect URLs from ``request.url``, which carries that
  // bound port through. The browser then chases the redirect to
  // ``https://npd.vitaintelligent.com:3000/...`` — a port Azure
  // doesn't expose externally — and the customer's tab sits on
  // ``ERR_CONNECTION_TIMED_OUT``. The kiosk activation link landed
  // squarely in this trap, since hitting ``/en/portal/activate/<t>``
  // triggers exactly that 307. Trimming any explicit ``:3000`` on
  // ``Location`` is the smallest surgical fix that survives until
  // next-intl learns to honour ``X-Forwarded-Host`` properly.
  //
  // Local dev hits the dev server directly on ``localhost:3000`` —
  // the inbound ``Host`` header carries that port. Stripping it in
  // that case would redirect the browser to ``http://localhost/``
  // (port 80, nothing listening) and surface the symptom we are
  // trying to fix in prod. So we only strip when the request did
  // NOT come in via ``:3000`` — i.e. we are behind a reverse proxy
  // that already terminated the port mapping.
  const loc = response.headers.get("location");
  if (loc && /:3000(\/|$)/.test(loc)) {
    const inboundHost = request.headers.get("host") ?? "";
    if (!/:3000$/.test(inboundHost)) {
      response.headers.set("location", loc.replace(/:3000(?=\/|$)/, ""));
    }
  }

  // Append the raw Set-Cookie headers so the browser persists the
  // rotated tokens. ``append`` (not ``set``) because we emit two
  // cookies and they must both reach the client.
  if (refreshed) {
    for (const cookie of refreshed.setCookies) {
      response.headers.append("Set-Cookie", cookie);
    }
  }

  return response;
}


/**
 * Match every request except Next internals, static assets, and anything
 * under ``/api``. Keep this matcher narrow so we do not pay locale
 * detection (or refresh probing) cost on asset requests.
 */
export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
