/**
 * Friendly error text for the portal forms.
 *
 * Maps the small, codified errors the backend already returns
 * (``{ code, detail, messages }``) onto a sentence a customer can
 * act on. Falls back to whatever string the backend sent — never
 * "something went wrong", because a customer staring at that has
 * no idea whether to retry, re-read, or call support.
 */

interface ApiErrorShape {
  response?: {
    status?: number;
    data?: {
      code?: string;
      detail?: string[] | string;
      messages?: string[];
    };
  };
  message?: string;
}


const FRIENDLY: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  weak_password: "Password is too weak. Try a longer one.",
  invalid_activation_token: "This activation link is not valid or has already been used.",
  invalid_activation_code: "That code doesn't match the one in your email. Double-check it and try again.",
  account_already_activated: "An account for this email already exists. Please sign in.",
  customer_email_missing: "We don't have an email on file for your customer record. Please contact our customer service.",
  invalid_or_expired_token: "This reset link is no longer valid. Request a new one.",
  proposal_acknowledgements_required: "Tick every acknowledgement before signing.",
  signature_required: "Please draw your signature before submitting.",
  invalid_proposal_transition: "This proposal can no longer accept that action.",
  invalid_status_transition: "This specification sheet can no longer accept that action.",
  email_already_in_use: "Another portal account already uses this email.",
  invalid_email_change_code: "That code doesn't match. Check the email we just sent and try again.",
  current_password_incorrect: "Current password is incorrect.",
  privacy_policy_not_accepted: "Please tick the privacy-policy box before continuing.",
  registration_email_missing: "Enter the email address you'd like to use for your portal account.",
  invalid_registration_token: "We couldn't match that code to an open registration. Start again from the registration page.",
  registration_expired: "This registration has expired. Start again from the registration page.",
  registration_already_used: "This registration has already been completed. Sign in instead.",
  invalid_registration_code: "That code doesn't match the one we just emailed. Double-check it and try again.",
  no_active_organization: "Sign-ups are temporarily unavailable. Please try again later or contact customer service.",
  multiple_active_organizations: "Sign-ups are temporarily unavailable. Please try again later or contact customer service.",
};


export function portalErrorMessage(err: unknown): string {
  const e = err as ApiErrorShape;

  // 1. Codified backend error → friendly map.
  const code = e?.response?.data?.code;
  if (code && FRIENDLY[code]) {
    return FRIENDLY[code];
  }

  // 2. Backend returned ``messages`` (validators) — join and show.
  const messages = e?.response?.data?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    return messages.join(" ");
  }

  // 3. Backend returned ``detail`` (DRF default) — show it raw if a
  //    string; pick the first if a list.
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string" && detail) {
    return detail;
  }
  if (Array.isArray(detail) && detail.length > 0 && typeof detail[0] === "string") {
    return detail[0];
  }

  // 4. Unmapped code → show it verbatim so it's at least actionable
  //    for support.
  if (code) {
    return code.replace(/_/g, " ");
  }

  // 5. Network / timeout / unparsed.
  const status = e?.response?.status;
  if (status) {
    return `Request failed with HTTP ${status}. Try again or contact support.`;
  }
  if (e?.message) {
    return e.message;
  }

  return "We couldn't reach the server. Try again in a moment.";
}
