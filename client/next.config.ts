import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * The backend runs on a separate origin (``127.0.0.1:8000``) in dev. If
 * the browser talked to it directly, the httpOnly auth cookie would be
 * stored on the backend origin and invisible to Next's server runtime —
 * server components would always see an unauthenticated request.
 *
 * Proxying every ``/api/*`` call through Next fixes that: the browser
 * sees a single origin (``localhost:3000``), cookies are stored there,
 * and ``cookies()`` inside server components can read them.
 */
const BACKEND_INTERNAL_URL =
  process.env.BACKEND_INTERNAL_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Standalone output ships a minimal node server + only the
  // dependencies the build actually pulls in. The container image
  // copies that tree alongside ``public/`` and ``.next/static/`` and
  // runs ``node server.js`` — keeps the image small and reproducible.
  output: "standalone",
  // Django routes require trailing slashes (``APPEND_SLASH``). We match the
  // backend convention site-wide so rewrites pass trailing slashes through
  // to ``/api/...`` and Next app routes get canonicalised consistently.
  trailingSlash: true,
  // Next 16 blocks cross-origin access to dev resources (HMR, static
  // chunks) by default. When a teammate browses to this machine via
  // its LAN IP, their browser origin is not ``localhost`` so the HMR
  // websocket gets refused and hot reload stops working. Listing the
  // LAN hosts here opts them back in — still dev-only, and has no
  // effect on production builds.
  allowedDevOrigins: [
    "192.168.1.170",
    "192.168.1.0/24",
    "10.0.0.0/8",
    "localhost",
  ],
  async rewrites() {
    // ``fallback`` runs only after both static AND dynamic filesystem
    // routes have been checked — so the AI route handler at
    // ``app/api/organizations/[orgId]/ai/formulation-draft/route.ts``
    // can intercept that single dynamic path (where we need a long
    // fetch timeout under our own control) while every other
    // ``/api/*`` call continues to fall through to Django. A bare
    // array or ``afterFiles`` bucket would shadow the dynamic
    // handler, because both are checked BEFORE dynamic routes.
    //
    // ``/ws/*`` lives at ``beforeFiles`` so Next never tries to
    // match the path against an app route first — WebSocket upgrade
    // handshakes come in as HTTP GETs with ``Connection: Upgrade``,
    // and the rewrite forwards them to Daphne verbatim. Daphne's
    // ProtocolTypeRouter then routes them into the Channels
    // consumer stack.
    return {
      beforeFiles: [
        {
          source: "/ws/:path*",
          destination: `${BACKEND_INTERNAL_URL}/ws/:path*/`,
        },
      ],
      fallback: [
        {
          source: "/api/:path*",
          destination: `${BACKEND_INTERNAL_URL}/api/:path*/`,
        },
      ],
    };
  },
};

export default withNextIntl(nextConfig);
