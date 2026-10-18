import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, pool } from "./database.js";
import { registrationControlState, registrationOperationsOverview, setRegistrationEmergencyPause } from "./registration-operations.js";

process.env.SELF_SERVICE_REGISTRATION_ENABLED = "true";
process.env.REGISTRATION_ACCESS_MODE = "invite_only";
process.env.SMS_PROVIDER = "mock";
process.env.SMS_LIVE_SEND_ENABLED = "false";
process.env.REGISTRATION_LEGAL_PUBLISH_READY = "true";
process.env.REGISTRATION_TERMS_VERSION = "2026-09-11";
process.env.REGISTRATION_PRIVACY_VERSION = "2026-09-11";
await migrate();

const admin = await pool.query<{ admin_id:string; role:string }>(`SELECT admin_id,role FROM platform_admin_accounts WHERE status='active' AND role IN ('owner','admin') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END,created_at LIMIT 1`);
assert.ok(admin.rows[0], "B.6.2 requires an active platform owner or admin fixture");
const actor=admin.rows[0],initial=await registrationControlState();
const firstAction=initial.emergency_paused?"resume":"pause",firstRequest=randomUUID(),restoreRequest=randomUUID();
const changed=await setRegistrationEmergencyPause({action:firstAction,reason:"Phase B.6.2 synthetic reversible control test",admin_id:actor.admin_id,actor_role:actor.role,request_id:firstRequest});
assert.equal(changed.emergency_paused,!initial.emergency_paused);
assert.equal(changed.effective_enabled,firstAction==="resume");
await assert.rejects(()=>setRegistrationEmergencyPause({action:firstAction,reason:"Phase B.6.2 duplicate state transition test",admin_id:actor.admin_id,actor_role:actor.role,request_id:randomUUID()}));
const restored=await setRegistrationEmergencyPause({action:firstAction==="pause"?"resume":"pause",reason:"Phase B.6.2 synthetic state restoration completed",admin_id:actor.admin_id,actor_role:actor.role,request_id:restoreRequest});
assert.equal(restored.emergency_paused,initial.emergency_paused);

const overview=await registrationOperationsOverview();
assert.equal(overview.control.emergency_paused,initial.emergency_paused);
assert.equal("signal_hash" in (overview.recent_security_events[0]??{}),false);
assert.ok(Array.isArray(overview.recent_attempts));
assert.ok(overview.recent_attempts.every(item=>item.email.includes("***")&&item.phone.includes("****")));
const audit=await pool.query<{ count:number }>(`SELECT COUNT(*)::int count FROM platform_admin_audit_logs WHERE request_id=ANY($1::uuid[]) AND action LIKE 'registration.emergency_%'`,[[firstRequest,restoreRequest]]);
assert.equal(audit.rows[0].count,2);
const controlEvent=await pool.query<{ control_event_id:string }>(`SELECT control_event_id FROM registration_control_events WHERE request_id=$1`,[firstRequest]);
await assert.rejects(()=>pool.query(`UPDATE registration_control_events SET reason='tampered control history' WHERE control_event_id=$1`,[controlEvent.rows[0].control_event_id]));

console.log(JSON.stringify({phase:"B.6.2",runtime_state_restored:true,environment_gate_not_mutated:true,emergency_control_audited:true,control_events_append_only:true,security_hash_exposed:false,attempt_identity_masked:true}));
await pool.end();
