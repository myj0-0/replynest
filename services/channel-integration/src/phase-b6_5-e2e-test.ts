import { createHash,randomUUID } from "node:crypto";
import { pool } from "./database.js";
import { createPrivacyRequest,listMyPrivacyRequests,registrationRetentionPreview,runRegistrationRetention,transitionPrivacyRequest } from "./privacy-lifecycle.js";
const h=(v:string)=>createHash("sha256").update(v).digest("hex");
const marker=`phase-b65-${Date.now()}`,tenantId=`${marker}-tenant`,userId=randomUUID(),registrationId=randomUUID(),requestId=randomUUID();
const oldApproved=process.env.REGISTRATION_RETENTION_POLICY_APPROVED,oldEnabled=process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED,oldFailed=process.env.REGISTRATION_FAILED_RETENTION_DAYS;
const client=await pool.connect();
try{
  await client.query("BEGIN");
  await client.query(`INSERT INTO tenants(tenant_id,name,status) VALUES($1,'Phase B6.5','test')`,[tenantId]);
  await client.query(`INSERT INTO platform_users(platform_user_id,email,display_name,status) VALUES($1,$2,'Phase B6.5','active')`,[userId,`${marker}@example.invalid`]);
  const created=await createPrivacyRequest({tenant_id:tenantId,platform_user_id:userId,request_type:"deletion",details:"合成删除请求，用于验证状态机与追加式事件。",request_id:requestId},client);
  const privacyRequestId=String((created as {privacy_request_id:string}).privacy_request_id);if(!privacyRequestId)throw new Error("privacy request id missing");
  const replay=await createPrivacyRequest({tenant_id:tenantId,platform_user_id:userId,request_type:"deletion",details:"合成删除请求，用于验证状态机与追加式事件。",request_id:randomUUID()},client);
  if(!replay.idempotent_replay)throw new Error("active request was duplicated");
  let invalid=false;try{await transitionPrivacyRequest({privacy_request_id:privacyRequestId,next_status:"fulfilled",reason:"不能从提交状态直接完成此请求。",admin_id:randomUUID(),request_id:randomUUID()},client)}catch{invalid=true}
  if(!invalid)throw new Error("invalid privacy transition accepted");
  const admin=await client.query<{admin_id:string}>(`INSERT INTO platform_admin_accounts(email,display_name,password_hash,role) VALUES($1,'Phase B6.5','synthetic','owner') RETURNING admin_id`,[`${marker}-admin@example.invalid`]);
  await transitionPrivacyRequest({privacy_request_id:privacyRequestId,next_status:"in_review",reason:"合成请求已完成身份和范围核验。",admin_id:admin.rows[0].admin_id,request_id:randomUUID()},client);
  await transitionPrivacyRequest({privacy_request_id:privacyRequestId,next_status:"fulfilled",reason:"合成请求已执行并完成结果复核。",admin_id:admin.rows[0].admin_id,request_id:randomUUID()},client);
  const mine=await listMyPrivacyRequests(tenantId,userId,client);if(mine.items.length!==1||String(mine.items[0].status)!=="fulfilled")throw new Error("privacy request visibility failed");
  await client.query(`INSERT INTO registration_attempts(registration_id,idempotency_key,request_fingerprint,resume_token_hash,email_token_hash,email,display_name,company_name,phone_e164,password_hash,proposed_tenant_id,status,email_expires_at,expires_at,created_at,updated_at,terms_version,privacy_version,legal_consented_at) VALUES($1,$2,$3,$4,$5,$6,'待清理姓名','待清理企业','+8617610000000','synthetic',$7,'expired',NOW()-INTERVAL '40 days',NOW()-INTERVAL '40 days',NOW()-INTERVAL '40 days',NOW()-INTERVAL '40 days','test-v1','test-v1',NOW()-INTERVAL '40 days')`,[registrationId,`${marker}-registration`,h("finger"),h("resume"),h("email"),`${marker}-registration@example.invalid`,`${marker}-proposed`]);
  process.env.REGISTRATION_RETENTION_POLICY_APPROVED="true";process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED="true";process.env.REGISTRATION_FAILED_RETENTION_DAYS="30";
  const preview=await registrationRetentionPreview(client);if(preview.total<1)throw new Error("retention preview missed candidate");
  const result=await runRegistrationRetention(client);if(result.processed<1)throw new Error("retention executor did not process candidate");
  const scrubbed=await client.query<{personal_data_state:string;email:string;phone_e164:string;password_hash:string|null}>(`SELECT personal_data_state,email,phone_e164,password_hash FROM registration_attempts WHERE registration_id=$1`,[registrationId]);
  if(scrubbed.rows[0].personal_data_state!=="anonymized"||!scrubbed.rows[0].email.startsWith("purged+")||!scrubbed.rows[0].phone_e164.startsWith("purged:")||scrubbed.rows[0].password_hash!==null)throw new Error("registration identifiers were not anonymized");
  const events=await client.query<{count:number}>(`SELECT COUNT(*)::int count FROM privacy_request_events WHERE privacy_request_id=$1`,[privacyRequestId]);if(events.rows[0].count!==3)throw new Error("privacy events missing");
  await client.query("ROLLBACK");
  console.log(JSON.stringify({phase:"B.6.5",double_retention_gate:true,preview_before_execution:true,direct_identifiers_anonymized:true,privacy_request_idempotent:true,invalid_transition_rejected:true,append_only_events:true,production_data_mutated:false}));
}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release();if(oldApproved===undefined)delete process.env.REGISTRATION_RETENTION_POLICY_APPROVED;else process.env.REGISTRATION_RETENTION_POLICY_APPROVED=oldApproved;if(oldEnabled===undefined)delete process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED;else process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED=oldEnabled;if(oldFailed===undefined)delete process.env.REGISTRATION_FAILED_RETENTION_DAYS;else process.env.REGISTRATION_FAILED_RETENTION_DAYS=oldFailed;await pool.end()}
