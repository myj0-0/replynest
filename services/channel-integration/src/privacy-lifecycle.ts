import { createHash, randomUUID } from "node:crypto";
import {adminRecordList} from './admin-record-lists.js';
import { pool } from "./database.js";

type Queryable={query:<T=Record<string,unknown>>(text:string,values?:unknown[])=>Promise<{rows:T[];rowCount:number|null}>};
export type PrivacyRequestType="access"|"copy"|"correction"|"deletion"|"withdraw_consent"|"account_closure";
export type PrivacyRequestStatus="submitted"|"identity_verification"|"in_review"|"fulfilled"|"partially_fulfilled"|"rejected"|"cancelled";

const requestTypes=new Set<PrivacyRequestType>(["access","copy","correction","deletion","withdraw_consent","account_closure"]);
const finalStatuses=new Set<PrivacyRequestStatus>(["fulfilled","partially_fulfilled","rejected","cancelled"]);
const transitions:Record<PrivacyRequestStatus,ReadonlySet<PrivacyRequestStatus>>={
  submitted:new Set(["identity_verification","in_review","cancelled"]),
  identity_verification:new Set(["in_review","rejected","cancelled"]),
  in_review:new Set(["fulfilled","partially_fulfilled","rejected","cancelled"]),
  fulfilled:new Set(),partially_fulfilled:new Set(),rejected:new Set(),cancelled:new Set(),
};
function boundedDays(name:string,fallback:number){const value=Number(process.env[name]??fallback);return Number.isSafeInteger(value)&&value>=1&&value<=3650?value:fallback}
function hash(value:string){return createHash("sha256").update(value).digest("hex")}
function cleanText(value:unknown,max:number){return typeof value==="string"?value.trim().slice(0,max):""}

export function retentionPolicy(){
  const policyApproved=process.env.REGISTRATION_RETENTION_POLICY_APPROVED==="true";
  const executionEnabled=process.env.REGISTRATION_RETENTION_EXECUTION_ENABLED==="true";
  return {
    policy_approved:policyApproved,execution_enabled:executionEnabled,
    effective_execution:policyApproved&&executionEnabled,
    failed_or_expired_days:boundedDays("REGISTRATION_FAILED_RETENTION_DAYS",30),
    completed_duplicate_days:boundedDays("REGISTRATION_COMPLETED_DUPLICATE_RETENTION_DAYS",30),
    batch_size:Math.min(boundedDays("REGISTRATION_RETENTION_BATCH_SIZE",100),500),
  };
}

export async function registrationRetentionPreview(db:Queryable=pool){
  const policy=retentionPolicy();
  const result=await db.query<{status:string;count:number}>(`SELECT status,COUNT(*)::int count FROM registration_attempts
    WHERE personal_data_state='active' AND (
      (status IN ('failed','expired') AND updated_at<NOW()-($1::text||' days')::interval)
      OR (status='completed' AND completed_at<NOW()-($2::text||' days')::interval)
    ) GROUP BY status ORDER BY status`,[policy.failed_or_expired_days,policy.completed_duplicate_days]);
  return {policy,candidates:result.rows,total:result.rows.reduce((sum,row)=>sum+Number(row.count),0)};
}

export async function runRegistrationRetention(db:Queryable=pool):Promise<{processed:number;policy:ReturnType<typeof retentionPolicy>}>{
  if(db===pool){const client=await pool.connect();try{await client.query("BEGIN");const result=await runRegistrationRetention(client);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}}
  const policy=retentionPolicy();
  if(!policy.effective_execution)throw new Error("registration_retention_execution_disabled");
  await db.query(`UPDATE registration_attempts SET status='expired',failure_code=COALESCE(failure_code,'registration_expired'),updated_at=NOW()
    WHERE status IN ('awaiting_verification','ready') AND expires_at<=NOW()`);
  const selected=await db.query<{registration_id:string;phone_challenge_id:string|null;status:string}>(`SELECT registration_id,phone_challenge_id,status FROM registration_attempts
    WHERE personal_data_state='active' AND (
      (status IN ('failed','expired') AND updated_at<NOW()-($1::text||' days')::interval)
      OR (status='completed' AND completed_at<NOW()-($2::text||' days')::interval)
    ) ORDER BY updated_at LIMIT $3 FOR UPDATE SKIP LOCKED`,[policy.failed_or_expired_days,policy.completed_duplicate_days,policy.batch_size]);
  for(const item of selected.rows){
    if(item.phone_challenge_id)await db.query(`UPDATE phone_verification_challenges SET phone_e164=$2,code_hash=$3,provider_message_id=NULL,consumed_at=COALESCE(consumed_at,NOW()),delivery_updated_at=NOW() WHERE challenge_id=$1`,[item.phone_challenge_id,`purged:${item.phone_challenge_id}`,hash(`purged:${item.phone_challenge_id}`)]);
    await db.query(`UPDATE registration_attempts SET email=$2,display_name='已清理',company_name='已清理',phone_e164=$3,password_hash=NULL,referral_code=NULL,
      resume_token_hash=$4,email_token_hash=$5,request_fingerprint=$6,personal_data_state='anonymized',anonymized_at=NOW(),updated_at=NOW() WHERE registration_id=$1`,[
      item.registration_id,`purged+${item.registration_id}@invalid.replynest`,`purged:${item.registration_id}`,
      hash(`resume:${item.registration_id}`),hash(`email:${item.registration_id}`),hash(`request:${item.registration_id}`)]);
    await db.query(`INSERT INTO registration_events(registration_id,event_type,facts,request_id) VALUES($1,'personal_data_anonymized',jsonb_build_object('prior_status',$2::text,'policy','registration-retention-v1'),$3)`,[item.registration_id,item.status,randomUUID()]);
  }
  return {processed:selected.rows.length,policy};
}

export async function createPrivacyRequest(input:{tenant_id:string;platform_user_id:string;request_type:string;details:unknown;request_id:string},db:Queryable=pool):Promise<Record<string,unknown>&{privacy_request_id:string;idempotent_replay:boolean}>{
  if(db===pool){const client=await pool.connect();try{await client.query("BEGIN");const result=await createPrivacyRequest(input,client);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}}
  if(!requestTypes.has(input.request_type as PrivacyRequestType))throw new Error("invalid_privacy_request_type");
  const details=cleanText(input.details,2000);if(details.length<5)throw new Error("privacy_request_details_required");
  const dueDays=boundedDays("PRIVACY_REQUEST_TARGET_DAYS",15);
  const existing=await db.query<Record<string,unknown>&{privacy_request_id:string}>(`SELECT * FROM privacy_requests WHERE tenant_id=$1 AND platform_user_id=$2 AND request_type=$3 AND status IN ('submitted','identity_verification','in_review')`,[input.tenant_id,input.platform_user_id,input.request_type]);
  if(existing.rows[0])return{...existing.rows[0],idempotent_replay:true};
  const inserted=await db.query<{privacy_request_id:string}>(`INSERT INTO privacy_requests(tenant_id,platform_user_id,request_type,details,due_at) VALUES($1,$2,$3,$4,NOW()+($5::text||' days')::interval) RETURNING *`,[input.tenant_id,input.platform_user_id,input.request_type,details,dueDays]);
  const row=inserted.rows[0];
  await db.query(`INSERT INTO privacy_request_events(privacy_request_id,event_type,actor_type,actor_id,reason,facts,request_id) VALUES($1,'submitted','platform_user',$2,$3,jsonb_build_object('target_days',$4::int),$5)`,[row.privacy_request_id,input.platform_user_id,details,dueDays,input.request_id]);
  return{...row,idempotent_replay:false};
}

const privacyPageSize=20;
function privacyCursor(value:string|null){
  if(value===null)return null;
  try{
    if(value.length>256||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();
    const decoded=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
    if(!Array.isArray(decoded)||decoded.length!==2||typeof decoded[0]!=='string'||typeof decoded[1]!=='string'
      ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(decoded[0])
      ||!Number.isFinite(Date.parse(decoded[0]))
      ||new Date(decoded[0]).toISOString().slice(0,19)!==decoded[0].slice(0,19)
      ||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(decoded[1]))throw Error();
    return decoded as [string,string];
  }catch{throw Error('invalid_privacy_cursor')}
}
export async function listMyPrivacyRequests(tenantId:string,userId:string,db:Queryable=pool,params=new URLSearchParams()){
  if(params.getAll('before').length>1||params.getAll('after').length>1||params.has('before')&&params.has('after'))throw Error('invalid_privacy_cursor');
  const ascending=params.has('after'),cursor=privacyCursor(params.get(ascending?'after':'before'));
  // Retain PostgreSQL microseconds in the cursor: JS Date truncation can skip rows.
  // Cursors only specify a position; tenant and user scope always come from auth.
  const rows=await db.query<Record<string,unknown>&{privacy_request_id:string;cursor_at:string}>(`SELECT privacy_request_id,request_type,status,details,due_at,resolution_summary,legal_hold_reason,completed_at,created_at,updated_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
    FROM privacy_requests WHERE tenant_id=$1 AND platform_user_id=$2
    ${cursor?`AND (created_at,privacy_request_id) ${ascending?'>':'<'} ($3::timestamptz,$4::uuid)`:''}
    ORDER BY created_at ${ascending?'ASC':'DESC'},privacy_request_id ${ascending?'ASC':'DESC'} LIMIT 21`,cursor?[tenantId,userId,...cursor]:[tenantId,userId]);
  const more=rows.rows.length>privacyPageSize,selected=rows.rows.slice(0,privacyPageSize);if(ascending)selected.reverse();
  const encode=(row:typeof selected[number])=>Buffer.from(JSON.stringify([row.cursor_at,row.privacy_request_id])).toString('base64url');
  return {items:selected.map(({cursor_at,...row})=>row),pagination:{page_size:privacyPageSize,
    next:selected.length&&(ascending?Boolean(cursor):more)?encode(selected[selected.length-1]):null,
    previous:selected.length&&(ascending?more:Boolean(cursor))?encode(selected[0]):null}};
}
export async function listPlatformPrivacyRequests(db:Queryable=pool,params=new URLSearchParams()){
  const [rows,summary,retention]=await Promise.all([
    adminRecordList('privacy',params,db),
    db.query(`SELECT status,COUNT(*)::int count FROM privacy_requests GROUP BY status ORDER BY status`),registrationRetentionPreview(db)
  ]);return{requests:rows.items,page:rows.page,has_more:rows.has_more,statuses:summary.rows,retention};
}
export async function platformPrivacyDetail(id:string,params=new URLSearchParams(),db:Queryable=pool){
  const page=Number(params.get('page')??1);if(!Number.isSafeInteger(page)||page<1||page>10000)throw Error('invalid_search');
  const row=(await db.query(`SELECT r.*,t.name AS tenant_name,u.email AS user_email,u.display_name AS user_name,a.display_name AS assigned_admin_name
    FROM privacy_requests r JOIN tenants t USING(tenant_id) JOIN platform_users u USING(platform_user_id)
    LEFT JOIN platform_admin_accounts a ON a.admin_id=r.assigned_admin_id WHERE r.privacy_request_id=$1`,[id])).rows[0];
  if(!row)return undefined;
  const events=(await db.query(`SELECT e.privacy_request_event_id,e.event_type,e.actor_type,e.reason,e.facts,e.created_at,
    CASE WHEN e.actor_type='platform_admin' THEN a.display_name WHEN e.actor_type='platform_user' THEN u.display_name ELSE '系统' END AS actor_name
    FROM privacy_request_events e LEFT JOIN platform_admin_accounts a ON e.actor_type='platform_admin' AND a.admin_id::text=e.actor_id
    LEFT JOIN platform_users u ON e.actor_type='platform_user' AND u.platform_user_id::text=e.actor_id
    WHERE e.privacy_request_id=$1 ORDER BY e.created_at DESC,e.privacy_request_event_id DESC LIMIT 21 OFFSET $2`,[id,(page-1)*20])).rows;
  return{request:row,events:events.slice(0,20),page,has_more:events.length>20};
}

/** Internal progress note in the existing review event stream; not a new state
 * transition or a customer-visible resolution. No event schema/ACL expansion. */
export async function addPrivacyHandlingNote(input:{privacy_request_id:string;reason:unknown;admin_id:string;request_id:string},db:Queryable=pool):Promise<{privacy_request_id:string;recorded:boolean}>{
  if(db===pool){const c=await pool.connect();try{await c.query('BEGIN');const r=await addPrivacyHandlingNote(input,c);await c.query('COMMIT');return r}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
  const reason=cleanText(input.reason,2000);if(reason.length<10)throw Error('privacy_request_reason_required');
  const r=(await db.query<{status:PrivacyRequestStatus}>(`SELECT status FROM privacy_requests WHERE privacy_request_id=$1 FOR UPDATE`,[input.privacy_request_id])).rows[0];
  if(!r)throw Error('privacy_request_not_found');if(r.status!=='in_review')throw Error('privacy_note_requires_review');
  await db.query(`INSERT INTO privacy_request_events(privacy_request_id,event_type,actor_type,actor_id,reason,facts,request_id)
    VALUES($1,'review_started','platform_admin',$2,$3,'{"record_kind":"handling_note","internal_only":true}'::jsonb,$4)`,[input.privacy_request_id,input.admin_id,reason,input.request_id]);
  return{privacy_request_id:input.privacy_request_id,recorded:true};
}

export async function transitionPrivacyRequest(input:{privacy_request_id:string;next_status:string;reason:unknown;legal_hold_reason?:unknown;identity_verified?:unknown;manual_completed?:unknown;admin_id:string;request_id:string},db:Queryable=pool):Promise<{privacy_request_id:string;status:PrivacyRequestStatus}>{
  if(db===pool){const client=await pool.connect();try{await client.query("BEGIN");const result=await transitionPrivacyRequest(input,client);await client.query("COMMIT");return result}catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}}
  const next=input.next_status as PrivacyRequestStatus;if(!Object.hasOwn(transitions,next))throw new Error("invalid_privacy_request_status");
  const reason=cleanText(input.reason,2000);if(reason.length<10)throw new Error("privacy_request_reason_required");
  const current=await db.query<{status:PrivacyRequestStatus}>(`SELECT status FROM privacy_requests WHERE privacy_request_id=$1 FOR UPDATE`,[input.privacy_request_id]);if(!current.rows[0])throw new Error("privacy_request_not_found");
  if(!transitions[current.rows[0].status].has(next))throw new Error("invalid_privacy_request_transition");
  const confirmed=(value:unknown)=>value===true||value==='confirmed';
  if(['in_review','fulfilled','partially_fulfilled'].includes(next)&&!confirmed(input.identity_verified))throw Error('privacy_identity_confirmation_required');
  if(['fulfilled','partially_fulfilled'].includes(next)&&!confirmed(input.manual_completed))throw Error('privacy_manual_completion_required');
  if(next==='partially_fulfilled'&&cleanText(input.legal_hold_reason,1000).length<10)throw Error('privacy_partial_reason_required');
  const legalHold=cleanText(input.legal_hold_reason,1000)||null,event:Record<PrivacyRequestStatus,string>={submitted:"submitted",identity_verification:"identity_verification_requested",in_review:"review_started",fulfilled:"fulfilled",partially_fulfilled:"partially_fulfilled",rejected:"rejected",cancelled:"cancelled"};
  const changed=await db.query(`UPDATE privacy_requests SET status=$2,assigned_admin_id=$3,resolution_summary=CASE WHEN $4::boolean THEN $5 ELSE resolution_summary END,legal_hold_reason=$6,completed_at=CASE WHEN $4::boolean THEN NOW() ELSE NULL END,updated_at=NOW() WHERE privacy_request_id=$1 AND status=$7`,[input.privacy_request_id,next,input.admin_id,finalStatuses.has(next),reason,legalHold,current.rows[0].status]);
  if(changed.rowCount!==1)throw new Error("privacy_request_concurrent_update");
  await db.query(`INSERT INTO privacy_request_events(privacy_request_id,event_type,actor_type,actor_id,reason,facts,request_id) VALUES($1,$2,'platform_admin',$3,$4,jsonb_build_object('from_status',$5::text,'to_status',$6::text,'legal_hold',($7::text IS NOT NULL),'identity_verified',$9::boolean,'manual_completed',$10::boolean),$8)`,[input.privacy_request_id,event[next],input.admin_id,reason,current.rows[0].status,next,legalHold,input.request_id,confirmed(input.identity_verified),confirmed(input.manual_completed)]);
  return{privacy_request_id:input.privacy_request_id,status:next};
}
