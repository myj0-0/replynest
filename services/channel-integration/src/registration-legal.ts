export type RegistrationLegalState = {
  publish_ready: boolean;
  terms_version: string;
  privacy_version: string;
};

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function registrationLegalState(): RegistrationLegalState {
  const termsVersion = process.env.REGISTRATION_TERMS_VERSION ?? "2026-09-13-zh";
  const privacyVersion = process.env.REGISTRATION_PRIVACY_VERSION ?? "2026-09-13-zh";
  const finalVersions = VERSION.test(termsVersion) && VERSION.test(privacyVersion) && !termsVersion.startsWith("draft-") && !privacyVersion.startsWith("draft-");
  return {
    publish_ready: process.env.REGISTRATION_LEGAL_PUBLISH_READY === "true" && finalVersions,
    terms_version: termsVersion,
    privacy_version: privacyVersion,
  };
}

export function validateRegistrationLegalConsent(input: { accepted: boolean; terms_version: string; privacy_version: string }) {
  const current = registrationLegalState();
  if (!current.publish_ready) return { valid: false, code: "registration_legal_not_ready" as const };
  if (!input.accepted || input.terms_version !== current.terms_version || input.privacy_version !== current.privacy_version) return { valid: false, code: "registration_legal_consent_required" as const };
  return { valid: true as const, terms_version: current.terms_version, privacy_version: current.privacy_version };
}
