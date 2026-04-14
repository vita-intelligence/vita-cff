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
  // Django routes require trailing slashes (``APPEND_SLASH``). We match the
  // backend convention site-wide so rewrites pass trailing slashes through
  // to ``/api/...`` and Next app routes get canonicalised consistently.
  trailingSlash: true,
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_INTERNAL_URL}/api/:path*/`,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
