import assert from "node:assert/strict";
import { migrate, pool } from "./database.js";
import { registrationControlState } from "./registration-operations.js";
import { validateRegistrationLegalConsent } from "./registration-legal.js";

const before={
  enabled:process.env.SELF_SERVICE_REGISTRATION_ENABLED,
  ready:process.env.REGISTRATION_LEGAL_PUBLISH_READY,
  terms:process.env.REGISTRATION_TERMS_VERSION,
  privacy:process.env.REGISTRATION_PRIVACY_VERSION,
};
await migrate();
try {
  process.env.SELF_SERVICE_REGISTRATION_ENABLED="true";
  process.env.REGISTRATION_LEGAL_PUBLISH_READY="false";
  process.env.REGISTRATION_TERMS_VERSION="draft-2026-09-11";
  process.env.REGISTRATION_PRIVACY_VERSION="draft-2026-09-11";
  const draft=await registrationControlState();
  assert.equal(draft.legal.publish_ready,false);
  assert.equal(draft.effective_enabled,false,"environment switch must not bypass legal readiness");

  process.env.REGISTRATION_LEGAL_PUBLISH_READY="true";
  process.env.REGISTRATION_TERMS_VERSION="2026-09-11";
  process.env.REGISTRATION_PRIVACY_VERSION="2026-09-11";
  const final=await registrationControlState();
  assert.equal(final.effective_enabled,!final.emergency_paused);
  assert.equal(validateRegistrationLegalConsent({accepted:true,terms_version:"old",privacy_version:"2026-09-11"}).valid,false);
  assert.equal(validateRegistrationLegalConsent({accepted:true,terms_version:"2026-09-11",privacy_version:"2026-09-11"}).valid,true);

  const columns=await pool.query<{count:number}>(`SELECT COUNT(*)::int count FROM information_schema.columns WHERE table_name='registration_attempts' AND column_name IN ('terms_version','privacy_version','legal_consented_at')`);
  assert.equal(columns.rows[0].count,3);
  console.log(JSON.stringify({phase:"B.6.4",draft_cannot_open:true,version_mismatch_rejected:true,consent_columns:true,runtime_state_not_mutated:true}));
} finally {
  for(const [name,value] of [["SELF_SERVICE_REGISTRATION_ENABLED",before.enabled],["REGISTRATION_LEGAL_PUBLISH_READY",before.ready],["REGISTRATION_TERMS_VERSION",before.terms],["REGISTRATION_PRIVACY_VERSION",before.privacy]] as const){if(value===undefined)delete process.env[name];else process.env[name]=value;}
  await pool.end();
}
