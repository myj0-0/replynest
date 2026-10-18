import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, pool } from "./database.js";
import { registrationOperationsOverview, registrationSmsHealth } from "./registration-operations.js";

process.env.SELF_SERVICE_REGISTRATION_ENABLED = "false";
process.env.SMS_PROVIDER = "mock";
process.env.SMS_LIVE_SEND_ENABLED = "false";
process.env.REGISTRATION_SMS_COST_WARNING_MINOR = "1";
await migrate();

const acceptedId=randomUUID(),failedId=randomUUID();
try {
  await pool.query(`INSERT INTO phone_verification_challenges(challenge_id,phone_e164,purpose,code_hash,provider,provider_message_id,provider_code,send_status,estimated_cost_minor,delivery_updated_at,expires_at,consumed_at)
    VALUES($1,'+8613900000001','registration','synthetic','mock','synthetic-accepted','OK','accepted',5,NOW(),NOW()+INTERVAL '5 minutes',NOW())`,[acceptedId]);
  await pool.query(`INSERT INTO phone_verification_challenges(challenge_id,phone_e164,purpose,code_hash,provider,provider_code,send_status,failure_category,failure_retryable,estimated_cost_minor,delivery_updated_at,expires_at,consumed_at)
    VALUES($1,'+8613900000002','registration','synthetic','mock','isv.BUSINESS_LIMIT_CONTROL','failed','rate_limit',TRUE,0,NOW(),NOW()+INTERVAL '5 minutes',NOW())`,[failedId]);
  const overview=await registrationOperationsOverview();
  assert.ok(overview.sms_delivery_24h.accepted>=1);
  assert.ok(overview.sms_delivery_24h.failed>=1);
  assert.ok(overview.sms_delivery_24h.estimated_cost_minor>=5);
  assert.equal(overview.sms_delivery_24h.cost_warning,true);
  assert.ok(overview.sms_delivery_24h.failure_categories.some(item=>item.failure_category==="rate_limit"));
  assert.equal(JSON.stringify(overview).includes("13900000001"),false);
  const health=await registrationSmsHealth();
  assert.equal(health.status,"registration_closed");
  assert.equal(health.registration_enabled,false);
  console.log(JSON.stringify({phase:"B.6.3",delivery_metrics:true,failure_taxonomy:true,cost_warning:true,health_closed_safe:true,recipient_not_exposed:true}));
} finally {
  await pool.query(`DELETE FROM phone_verification_challenges WHERE challenge_id=ANY($1::uuid[])`,[[acceptedId,failedId]]).catch(()=>undefined);
  await pool.end();
}
