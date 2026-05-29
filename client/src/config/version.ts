/** Single source of truth for the app version shown in the
 *  bottom-right footer of every staff page.
 *
 *  Bump this constant whenever you ship a deploy — the user's
 *  policy is "version up on every deployment so we don't sit on
 *  0.1.0 forever". Keep it in lockstep with ``package.json``;
 *  there is a CI check sitting on it as a smoke test.
 *
 *  Semver discipline:
 *    - patch (0.0.x) for bug-fix-only deploys
 *    - minor (0.x.0) for new features that don't break existing flows
 *    - major (x.0.0) for breaking changes (RBAC migration, model
 *      schema rewrite, etc.). vita-cff is live for paying users —
 *      majors should never ship without explicit confirmation.
 */

export const APP_VERSION = "0.2.0" as const;
