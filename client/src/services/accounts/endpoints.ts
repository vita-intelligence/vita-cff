/**
 * URL constants for the accounts domain.
 *
 * Every path the app hits in this domain lives here — never inlined in a
 * hook or a form. Rename a backend route once and the whole frontend
 * tracks the change.
 */

export const accountsEndpoints = {
  register: "/api/auth/register/",
  login: "/api/auth/login/",
  logout: "/api/auth/logout/",
  refresh: "/api/auth/refresh/",
  me: "/api/auth/me/",
  passwordResetRequest: "/api/auth/password-reset/request/",
  passwordResetValidate: "/api/auth/password-reset/validate/",
  passwordResetConfirm: "/api/auth/password-reset/confirm/",
} as const;

export type AccountsEndpoint =
  (typeof accountsEndpoints)[keyof typeof accountsEndpoints];
