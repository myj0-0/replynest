import assert from "node:assert/strict";
import test from "node:test";
import { registrationLegalState, validateRegistrationLegalConsent } from "./registration-legal.js";

test("registration legal gate rejects drafts and stale consent versions", () => {
  process.env.REGISTRATION_LEGAL_PUBLISH_READY="true";
  process.env.REGISTRATION_TERMS_VERSION="draft-2026-09-11";
  process.env.REGISTRATION_PRIVACY_VERSION="draft-2026-09-11";
  assert.equal(registrationLegalState().publish_ready,false);
  process.env.REGISTRATION_TERMS_VERSION="2026-09-11";
  process.env.REGISTRATION_PRIVACY_VERSION="2026-09-11";
  assert.deepEqual(validateRegistrationLegalConsent({accepted:false,terms_version:"2026-09-11",privacy_version:"2026-09-11"}),{valid:false,code:"registration_legal_consent_required"});
  assert.equal(validateRegistrationLegalConsent({accepted:true,terms_version:"old",privacy_version:"2026-09-11"}).valid,false);
  assert.deepEqual(validateRegistrationLegalConsent({accepted:true,terms_version:"2026-09-11",privacy_version:"2026-09-11"}),{valid:true,terms_version:"2026-09-11",privacy_version:"2026-09-11"});
  delete process.env.REGISTRATION_LEGAL_PUBLISH_READY;
  delete process.env.REGISTRATION_TERMS_VERSION;
  delete process.env.REGISTRATION_PRIVACY_VERSION;
});
