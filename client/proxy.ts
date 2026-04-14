import createMiddleware from "next-intl/middleware";

import { routing } from "@/i18n/routing";

export default createMiddleware(routing);

/**
 * Match every request except Next internals, static assets, and anything
 * under ``/api``. Keep this matcher narrow so we do not pay locale
 * detection cost on asset requests.
 */
export const config = {
  matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"],
};
