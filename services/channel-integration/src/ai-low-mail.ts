import type {PoolClient} from 'pg';
import {pool} from './database.js';
import {aiPointBalances,aiPointsEnabled} from './ai-points.js';
import {sendMail,mailProviderDiagnostic} from './mail-provider.js';
import type {Mail} from './smtp-mailer.js';

export function lowPointRatio(b:{monthly_limit_micros:number|null;monthly_available_micros:number|null;credit_limit_micros:number;credit_available_micros:number}){
 if(b.monthly_limit_micros===null||b.monthly_available_micros===null)return null;
 const capacity=b.monthly_limit_micros+b.credit_limit_micros,remaining=b.monthly_available_micros+b.credit_available_micros;
 if(!Number.isSafeInteger(capacity)||!Number.isSafeInteger(remaining)||capacity<0||remaining<0)throw Error('ai_balance_requires_review');
 return {capacity,remaining,low:capacity>0&&BigInt(remaining)*10n<BigInt(capacity)};
}

// Called within the bounded quota scan's tenant transaction. Same lock order as purchases/refunds.
export async function enqueueAiLowMail(tenant:string,db:PoolClient,now=new Date()){
 if(!aiPointsEnabled())return 0;
 const t=(await db.query("SELECT name FROM tenants WHERE tenant_id=$1 AND status='active'",[tenant])).rows[0];if(!t)return 0;
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${tenant}`]);
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`ai-points:${tenant}`]);
 const ratio=lowPointRatio(await aiPointBalances(db,tenant));
 await db.query('INSERT INTO ai_low_mail_state(tenant_id)VALUES($1) ON CONFLICT DO NOTHING',[tenant]);
 const state=(await db.query('SELECT * FROM ai_low_mail_state WHERE tenant_id=$1 FOR UPDATE',[tenant])).rows[0];
 if(!ratio?.low){await db.query('UPDATE ai_low_mail_state SET is_low=FALSE,updated_at=$2 WHERE tenant_id=$1',[tenant,now]);return 0;}
 const last=Math.max(state.last_enqueued_at?+new Date(state.last_enqueued_at):0,state.last_sent_at?+new Date(state.last_sent_at):0);
 if(state.is_low||+now-last<86400000)return 0;
 const changed=(await db.query('UPDATE ai_low_mail_state SET is_low=TRUE,generation=generation+1,last_enqueued_at=$2,updated_at=$2 WHERE tenant_id=$1 RETURNING generation',[tenant,now])).rows[0];
 await db.query(`INSERT INTO ai_low_mail_events(tenant_id,generation,facts,created_at,next_attempt_at)VALUES($1,$2,$3,$4,$4)`,[tenant,changed.generation,JSON.stringify({tenant_name:t.name,remaining_micros:ratio.remaining,capacity_micros:ratio.capacity}),now]);
 return 1;
}
async function currentLow(event:any){
 if(!aiPointsEnabled())return null;
 const db=await pool.connect();try{
  await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='2s'");await db.query("SET LOCAL lock_timeout='500ms'");
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`wallet:${event.tenant_id}`]);
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`ai-points:${event.tenant_id}`]);
  const row=(await db.query(`SELECT t.name,s.is_low,s.generation FROM tenants t JOIN ai_low_mail_state s USING(tenant_id) WHERE t.tenant_id=$1 AND t.status='active'`,[event.tenant_id])).rows[0];
  const ratio=row?lowPointRatio(await aiPointBalances(db,event.tenant_id)):null;
  if(row&&!ratio?.low)await db.query('UPDATE ai_low_mail_state SET is_low=FALSE,updated_at=NOW() WHERE tenant_id=$1',[event.tenant_id]);
  await db.query('COMMIT');
  return row&&row.is_low&&String(row.generation)===String(event.generation)&&ratio?.low?{tenant_name:row.name,remaining_micros:ratio.remaining,capacity_micros:ratio.capacity}:null;
 }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
}
async function recipients(tenant:string){return (await pool.query(`SELECT DISTINCT lower(u.email) AS email FROM tenant_memberships m JOIN platform_users u USING(platform_user_id)
 WHERE m.tenant_id=$1 AND m.role='tenant_admin' AND m.status='active' AND u.status='active' AND u.email_verified_at IS NOT NULL AND u.email IS NOT NULL ORDER BY email LIMIT 101`,[tenant])).rows.map(r=>r.email as string);}
export function aiLowMailContent(facts:any):Omit<Mail,'to'>{
 const points=(n:number)=>(n/1_000_000).toLocaleString('zh-CN',{maximumFractionDigits:2});
 return {subject:'【答巢】AI 点数剩余不足 10%',text:`企业：${String(facts.tenant_name)}\n您的可用 AI 点数已低于总额度的 10%。\n当前剩余：${points(Number(facts.remaining_micros))} AI 点数\n参考总额度：${points(Number(facts.capacity_micros))} AI 点数\n\n按本月套餐额度与仍有效的额外点数授予额度合计计算，已排除过期、撤销及申请退款的额度；可用余额含正在使用的预留扣减。\n请登录 https://console.replynest.cn/billing 查看用量并按需补充点数。不会自动购买或扣款；实际余额以控制台为准。`};
}
export async function processAiLowMail(now=new Date(),sender:typeof sendMail=sendMail){
 if(!aiPointsEnabled())return;
 if(sender===sendMail){const d=mailProviderDiagnostic();if(!d.configured||(d.provider!=='mailpit'&&!d.live_send_enabled))return;}
 const lock=await pool.connect();let locked=false,destroy=false;
 try{
  locked=Boolean((await lock.query("SELECT pg_try_advisory_lock(hashtext('ai-low-mail-worker')) AS locked")).rows[0].locked);if(!locked)return;
  // Provider acceptance followed by a crash is ambiguous: hold for review, never blindly resend.
  await pool.query(`WITH due AS(SELECT delivery_id FROM ai_low_mail_deliveries WHERE status='sending' ORDER BY updated_at LIMIT 100)
   UPDATE ai_low_mail_deliveries SET status='review',error_code='delivery_outcome_unknown',updated_at=NOW() WHERE delivery_id IN(SELECT delivery_id FROM due)`);
  const events=(await pool.query("SELECT * FROM ai_low_mail_events WHERE status='pending' AND next_attempt_at<=$1 ORDER BY next_attempt_at,event_id LIMIT 50",[now])).rows;
  for(const event of events){try{
   if(!await currentLow(event)){await pool.query("UPDATE ai_low_mail_events SET status='canceled' WHERE event_id=$1",[event.event_id]);continue;}
   const emails=await recipients(event.tenant_id);
   // Do not silently truncate recipients. An unusually large admin set waits for operator review.
   if(!emails.length||emails.length>100){await pool.query("UPDATE ai_low_mail_events SET next_attempt_at=$2::timestamptz+INTERVAL '1 hour' WHERE event_id=$1",[event.event_id,now]);continue;}
   for(const email of emails)await pool.query('INSERT INTO ai_low_mail_deliveries(event_id,email,next_attempt_at)VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[event.event_id,email,now]);
   await pool.query("UPDATE ai_low_mail_events SET status='prepared' WHERE event_id=$1",[event.event_id]);
  }catch{await pool.query("UPDATE ai_low_mail_events SET next_attempt_at=$2::timestamptz+INTERVAL '10 minutes' WHERE event_id=$1",[event.event_id,now]);}}
  const jobs=(await pool.query(`SELECT d.delivery_id,d.email,d.attempts,e.* FROM ai_low_mail_deliveries d JOIN ai_low_mail_events e USING(event_id)
   WHERE d.status IN ('pending','retry') AND d.next_attempt_at<=$1 ORDER BY d.next_attempt_at,d.delivery_id LIMIT 20`,[now])).rows;
  for(const job of jobs){
   let facts;try{facts=await currentLow(job);}catch{await pool.query("UPDATE ai_low_mail_deliveries SET next_attempt_at=$2::timestamptz+INTERVAL '10 minutes',error_code='balance_check_failed' WHERE delivery_id=$1",[job.delivery_id,now]);continue;}
   if(!facts||!(await recipients(job.tenant_id)).includes(job.email)){await pool.query("UPDATE ai_low_mail_deliveries SET status='canceled',updated_at=NOW() WHERE delivery_id=$1",[job.delivery_id]);continue;}
   await pool.query("UPDATE ai_low_mail_deliveries SET status='sending',attempts=attempts+1,updated_at=NOW() WHERE delivery_id=$1",[job.delivery_id]);
   try{await sender({to:job.email,...aiLowMailContent(facts)});await pool.query("UPDATE ai_low_mail_state SET last_sent_at=$2 WHERE tenant_id=$1",[job.tenant_id,now]);await pool.query("UPDATE ai_low_mail_deliveries SET status='sent',error_code=NULL,updated_at=NOW() WHERE delivery_id=$1",[job.delivery_id]);}
   catch(error){const message=error instanceof Error?error.message:'';
    const rejected=/^SMTP (command failed with|greeting failed with|message rejected with) [45]\d\d$/.test(message)||message==='Mailgun send failed with HTTP 429';
    await pool.query(`UPDATE ai_low_mail_deliveries SET status=$2,error_code=$3,next_attempt_at=$4::timestamptz+INTERVAL '10 minutes',updated_at=NOW() WHERE delivery_id=$1`,[job.delivery_id,rejected&&job.attempts<4?'retry':'review',rejected?'provider_rejected':'delivery_outcome_unknown',now]);
   }
  }
 }finally{try{if(locked)await lock.query("SELECT pg_advisory_unlock(hashtext('ai-low-mail-worker'))");}catch{destroy=true;}finally{lock.release(destroy);}}
}
