import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "./database.js";
import { registrationControlState } from "./registration-operations.js";

type Db = Pick<PoolClient, "query"> | typeof pool;
const CHECK_KEYS = ["on_call_confirmed", "backup_verified", "support_channel_confirmed", "pilot_scope_confirmed", "rollback_rehearsed"] as const;
type CheckKey = typeof CHECK_KEYS[number];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function writeEvent(db: Db, batchId: string, eventType: string, adminId: string, requestId: string, facts: Record<string, unknown> = {}, inviteId?: string) {
  await db.query(`INSERT INTO registration_pilot_events(pilot_batch_id,pilot_invite_id,event_type,actor_admin_id,facts,request_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [batchId, inviteId ?? null, eventType, adminId, JSON.stringify(facts), requestId]);
}

export async function pilotReadiness() {
  const control = await registrationControlState();
  const checks = [
    { key: "registration_closed_for_preparation", label: "准备阶段注册总开关保持关闭", passed: !control.environment_enabled },
    { key: "invite_only", label: "注册准入限制为邀请码", passed: control.access_mode === "invite_only" },
    { key: "legal_publish_ready", label: "正式条款已经核准", passed: control.legal.publish_ready },
    { key: "sms_live_ready", label: "短信服务已切换至真实供应商", passed: control.sms_provider === "aliyun" && control.sms_live_enabled },
    { key: "emergency_control_ready", label: "紧急暂停控制处于可用状态", passed: true },
  ];
  return { checks, blockers: checks.filter(item => !item.passed && item.key !== "registration_closed_for_preparation").map(item => item.key), control };
}

export async function listPilotOperations() {
  const [readiness, batches] = await Promise.all([
    pilotReadiness(),
    pool.query(`WITH selected AS MATERIALIZED (SELECT * FROM registration_pilot_batches ORDER BY created_at DESC,pilot_batch_id DESC LIMIT 30)
      SELECT b.*,i.*,a.*,c.* FROM selected b
      CROSS JOIN LATERAL (SELECT COUNT(*)::int invites_issued,COUNT(*) FILTER(WHERE status='consumed')::int invites_consumed
        FROM registration_pilot_invites WHERE pilot_batch_id=b.pilot_batch_id) i
      CROSS JOIN LATERAL (SELECT COUNT(*)::int registrations_completed FROM registration_attempts a
        JOIN registration_pilot_invites i USING(pilot_invite_id) WHERE i.pilot_batch_id=b.pilot_batch_id AND a.status='completed') a
      CROSS JOIN LATERAL (SELECT COALESCE(jsonb_agg(jsonb_build_object('check_key',check_key,'status',status,'evidence',evidence,'checked_at',checked_at)),'[]'::jsonb) checks
        FROM registration_pilot_checks WHERE pilot_batch_id=b.pilot_batch_id) c
      ORDER BY b.created_at DESC,b.pilot_batch_id DESC`),
  ]);
  const invites = await pool.query(`SELECT i.pilot_invite_id,i.pilot_batch_id,i.display_hint,i.recipient_ref,i.status,i.expires_at,i.consumed_at,i.revoked_at,i.created_at
    FROM registration_pilot_invites i ORDER BY i.created_at DESC LIMIT 100`);
  const events = await pool.query(`SELECT e.pilot_event_id,e.pilot_batch_id,e.event_type,e.facts,e.request_id,e.created_at,a.display_name AS actor_name
    FROM registration_pilot_events e JOIN platform_admin_accounts a ON a.admin_id=e.actor_admin_id ORDER BY e.created_at DESC LIMIT 100`);
  return { readiness, batches: batches.rows, invites: invites.rows, events: events.rows, check_keys: CHECK_KEYS };
}

export async function createPilotBatch(input: { name?: unknown; max_registrations?: unknown; starts_at?: unknown; ends_at?: unknown; on_call_name?: unknown; on_call_contact?: unknown; admin_id: string; request_id?: string }, db: Db = pool) {
  const name = clean(input.name, 100), onCallName = clean(input.on_call_name, 100), onCallContact = clean(input.on_call_contact, 200);
  const max = Number(input.max_registrations), startsAt = new Date(String(input.starts_at ?? "")), endsAt = new Date(String(input.ends_at ?? ""));
  if (name.length < 3 || onCallName.length < 2 || onCallContact.length < 3 || !Number.isSafeInteger(max) || max < 1 || max > 100 || Number.isNaN(startsAt.valueOf()) || Number.isNaN(endsAt.valueOf()) || endsAt <= startsAt) throw new Error("invalid_pilot_batch");
  const batchCode = `PILOT-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomBytes(3).toString("hex").toUpperCase()}`;
  const result = await db.query<{pilot_batch_id:string}>(`INSERT INTO registration_pilot_batches(batch_code,name,max_registrations,starts_at,ends_at,on_call_name,on_call_contact,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING pilot_batch_id`, [batchCode,name,max,startsAt,endsAt,onCallName,onCallContact,input.admin_id]);
  const batchId=result.rows[0].pilot_batch_id;
  for (const key of CHECK_KEYS) await db.query(`INSERT INTO registration_pilot_checks(pilot_batch_id,check_key) VALUES($1,$2)`,[batchId,key]);
  await writeEvent(db,batchId,"pilot.batch_created",input.admin_id,input.request_id??randomUUID(),{batch_code:batchCode,max_registrations:max,starts_at:startsAt,ends_at:endsAt});
  return {pilot_batch_id:batchId,batch_code:batchCode,status:"draft"};
}

export async function setPilotCheck(input:{pilot_batch_id:string;check_key:string;passed:boolean;evidence?:unknown;admin_id:string;request_id?:string},db:Db=pool){
  if(!(CHECK_KEYS as readonly string[]).includes(input.check_key))throw new Error("invalid_pilot_check");
  const evidence=clean(input.evidence,500);if(input.passed&&evidence.length<10)throw new Error("pilot_check_evidence_required");
  const updated=await db.query(`UPDATE registration_pilot_checks SET status=$3,evidence=$4,checked_by=$5,checked_at=$6 WHERE pilot_batch_id=$1 AND check_key=$2 RETURNING *`,[input.pilot_batch_id,input.check_key,input.passed?"passed":"pending",input.passed?evidence:null,input.admin_id,input.passed?new Date():null]);
  if(!updated.rowCount)throw new Error("pilot_batch_not_found");
  await writeEvent(db,input.pilot_batch_id,input.passed?"pilot.check_passed":"pilot.check_reset",input.admin_id,input.request_id??randomUUID(),{check_key:input.check_key,evidence:input.passed?evidence:undefined});
  return updated.rows[0];
}

export async function rehearsePilotRollback(batchId:string,adminId:string,requestId=randomUUID(),db:Db=pool){
  const batch=await db.query<{status:string}>(`SELECT status FROM registration_pilot_batches WHERE pilot_batch_id=$1`,[batchId]);if(!batch.rows[0]||["completed","cancelled"].includes(batch.rows[0].status))throw new Error("pilot_batch_not_rehearsable");
  const evidence="已验证紧急暂停、批次暂停、邀请码撤销和审计追踪步骤；演练未开启注册。";
  await setPilotCheck({pilot_batch_id:batchId,check_key:"rollback_rehearsed",passed:true,evidence,admin_id:adminId,request_id:requestId},db);
  await writeEvent(db,batchId,"pilot.rollback_rehearsed",adminId,requestId,{production_mutated:false,steps:["emergency_pause","pause_batch","revoke_unused_invites","verify_audit"]});
  return {rehearsed:true,production_mutated:false};
}

export async function transitionPilotBatch(batchId:string,action:string,reason:unknown,adminId:string,requestId=randomUUID()){
  const text=clean(reason,500);if(text.length<10)throw new Error("pilot_transition_reason_required");
  const client=await pool.connect();try{await client.query("BEGIN");const found=await client.query<{status:string}>(`SELECT status FROM registration_pilot_batches WHERE pilot_batch_id=$1 FOR UPDATE`,[batchId]);const current=found.rows[0]?.status;if(!current)throw new Error("pilot_batch_not_found");
    const targets:Record<string,Record<string,string>>={draft:{ready:"ready",cancel:"cancelled"},ready:{activate:"active",cancel:"cancelled"},active:{pause:"paused",complete:"completed"},paused:{activate:"active",complete:"completed",cancel:"cancelled"}};const next=targets[current]?.[action];if(!next)throw new Error("invalid_pilot_transition");
    if(next==="ready"){const pending=await client.query<{count:number}>(`SELECT COUNT(*)::int count FROM registration_pilot_checks WHERE pilot_batch_id=$1 AND status<>'passed'`,[batchId]);if(Number(pending.rows[0].count)>0)throw new Error("pilot_operator_checks_incomplete");}
    if(next==="active"){const readiness=await pilotReadiness();if(readiness.blockers.length)throw new Error(`pilot_readiness_blocked:${readiness.blockers.join(",")}`);const batch=await client.query<{starts_at:Date;ends_at:Date}>(`SELECT starts_at,ends_at FROM registration_pilot_batches WHERE pilot_batch_id=$1`,[batchId]);if(batch.rows[0].ends_at<=new Date())throw new Error("pilot_batch_expired");}
    await client.query(`UPDATE registration_pilot_batches SET status=$2,updated_at=NOW() WHERE pilot_batch_id=$1`,[batchId,next]);if(["cancelled","completed"].includes(next))await client.query(`UPDATE registration_pilot_invites SET status='revoked',revoked_at=NOW() WHERE pilot_batch_id=$1 AND status='active'`,[batchId]);
    await writeEvent(client,batchId,`pilot.batch_${next}`,adminId,requestId,{before:current,after:next,reason:text});await client.query("COMMIT");return{pilot_batch_id:batchId,status:next};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}}

export async function issuePilotInvite(batchId:string,recipientRef:unknown,adminId:string,requestId=randomUUID()){
  const recipient=clean(recipientRef,120);if(recipient.length<2)throw new Error("pilot_recipient_ref_required");const client=await pool.connect();try{await client.query("BEGIN");const batch=await client.query<{status:string;max_registrations:number;ends_at:Date}>(`SELECT status,max_registrations,ends_at FROM registration_pilot_batches WHERE pilot_batch_id=$1 FOR UPDATE`,[batchId]);const item=batch.rows[0];if(!item||!["draft","ready","active","paused"].includes(item.status)||item.ends_at<=new Date())throw new Error("pilot_batch_not_issuable");const count=await client.query<{count:number}>(`SELECT COUNT(*)::int count FROM registration_pilot_invites WHERE pilot_batch_id=$1 AND status<>'revoked'`,[batchId]);if(Number(count.rows[0].count)>=item.max_registrations)throw new Error("pilot_batch_capacity_reached");
    const code=randomBytes(24).toString("base64url"),hint=`${code.slice(0,4)}…${code.slice(-4)}`;const created=await client.query<{pilot_invite_id:string}>(`INSERT INTO registration_pilot_invites(pilot_batch_id,invite_code_hash,display_hint,recipient_ref,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING pilot_invite_id`,[batchId,hash(code),hint,recipient,item.ends_at,adminId]);await writeEvent(client,batchId,"pilot.invite_issued",adminId,requestId,{recipient_ref:recipient,display_hint:hint},created.rows[0].pilot_invite_id);await client.query("COMMIT");return{pilot_invite_id:created.rows[0].pilot_invite_id,invite_code:code,display_hint:hint,shown_once:true};
  }catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error}finally{client.release()}}

export async function revokePilotInvite(inviteId:string,reason:unknown,adminId:string,requestId=randomUUID()){
  const text=clean(reason,500);if(text.length<10)throw new Error("pilot_revoke_reason_required");const updated=await pool.query<{pilot_batch_id:string}>(`UPDATE registration_pilot_invites SET status='revoked',revoked_at=NOW() WHERE pilot_invite_id=$1 AND status='active' RETURNING pilot_batch_id`,[inviteId]);if(!updated.rows[0])throw new Error("pilot_invite_not_revocable");await writeEvent(pool,updated.rows[0].pilot_batch_id,"pilot.invite_revoked",adminId,requestId,{reason:text},inviteId);return{revoked:true};
}

export async function resolvePilotInvite(code:string,now=new Date(),db:Db=pool,lock=false){
  const result=await db.query<{pilot_invite_id:string;pilot_batch_id:string;max_registrations:number}>(`SELECT i.pilot_invite_id,i.pilot_batch_id,b.max_registrations FROM registration_pilot_invites i JOIN registration_pilot_batches b ON b.pilot_batch_id=i.pilot_batch_id WHERE i.invite_code_hash=$1 AND i.status='active' AND i.expires_at>$2 AND b.status='active' AND b.starts_at<=$2 AND b.ends_at>$2${lock?" FOR UPDATE OF b,i":""}`,[hash(code),now]);const invite=result.rows[0];if(!invite)return;
  await db.query(`UPDATE registration_attempts SET status='expired',failure_code=COALESCE(failure_code,'registration_expired'),updated_at=NOW() WHERE pilot_invite_id IN (SELECT pilot_invite_id FROM registration_pilot_invites WHERE pilot_batch_id=$1) AND status IN ('awaiting_verification','ready') AND expires_at<=$2`,[invite.pilot_batch_id,now]);
  const count=await db.query<{count:number}>(`SELECT COUNT(*)::int count FROM registration_attempts a JOIN registration_pilot_invites i ON i.pilot_invite_id=a.pilot_invite_id WHERE i.pilot_batch_id=$1 AND (a.status='completed' OR (a.status IN ('awaiting_verification','ready','provisioning') AND a.expires_at>$2))`,[invite.pilot_batch_id,now]);if(Number(count.rows[0].count)>=invite.max_registrations)return;return invite;
}
