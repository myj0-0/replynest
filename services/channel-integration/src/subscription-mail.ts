import {pool} from './database.js';
import {sendMail,mailProviderDiagnostic} from './mail-provider.js';
import type {Mail} from './smtp-mailer.js';

// Payment fulfillment already commits a durable subscription event in its transaction.
export async function scheduleSubscriptionMail(now=new Date()){
 await pool.query(`INSERT INTO subscription_mail_events(event_key,tenant_id,subscription_id,kind,period_end,facts,created_at)
 SELECT 'purchase:'||e.subscription_event_id,e.tenant_id,e.subscription_id,'purchased',
 COALESCE(w.period_end,d.period_end),jsonb_build_object('tenant_name',t.name,'plan_name',COALESCE(w.plan_name,d.plan_name),'amount_minor',COALESCE(w.amount_minor,d.amount_minor),'reference',COALESCE(w.purchase_id::text,d.payment_order_id::text),'billing_period',COALESCE(w.billing_period,d.billing_period),'source',e.source),e.created_at
 FROM subscription_events e JOIN tenant_subscriptions s USING(subscription_id) JOIN tenants t ON t.tenant_id=e.tenant_id
 LEFT JOIN wallet_purchases w ON w.purchase_id::text=e.facts->>'purchase_id' AND w.tenant_id=e.tenant_id
 LEFT JOIN plan_payment_purchases d ON d.payment_order_id::text=e.facts->>'payment_order_id' AND d.tenant_id=e.tenant_id
 WHERE e.created_at>=(SELECT starts_at FROM subscription_mail_rollout WHERE id=1) AND e.event_type IN ('activated','renewed')
 AND e.source IN ('wallet','alipay') AND s.source='payment' AND t.status='active'
 AND (w.purchase_id IS NOT NULL OR (d.status='fulfilled' AND d.payment_mode='live'))
 AND NOT EXISTS(SELECT 1 FROM subscription_mail_events m WHERE m.event_key='purchase:'||e.subscription_event_id)
 ORDER BY e.created_at LIMIT 200 ON CONFLICT(event_key) DO NOTHING`);
 await pool.query(`INSERT INTO subscription_mail_events(event_key,tenant_id,subscription_id,kind,period_end,facts)
 SELECT 'expiry:'||s.subscription_id||':'||EXTRACT(EPOCH FROM s.current_period_end)::text,s.tenant_id,s.subscription_id,'expiring',s.current_period_end,
 jsonb_build_object('tenant_name',t.name,'plan_name',p.name)
 FROM tenant_subscriptions s JOIN tenants t USING(tenant_id) JOIN plan_catalog_versions p USING(plan_version_id)
 WHERE s.source IN ('payment','manual') AND s.status='active' AND t.status='active' AND p.plan_code<>'free'
 AND s.current_period_end>$1 AND s.current_period_end<=$1::timestamptz+INTERVAL '3 days'
 AND NOT EXISTS(SELECT 1 FROM subscription_mail_events e WHERE e.event_key='expiry:'||s.subscription_id||':'||EXTRACT(EPOCH FROM s.current_period_end)::text)
 ORDER BY s.current_period_end LIMIT 200 ON CONFLICT(event_key) DO NOTHING`,[now]);
}

async function validEvent(event:any,now:Date){
 const row=(await pool.query(`SELECT s.status,s.source,s.current_period_end,t.status AS tenant_status FROM tenant_subscriptions s JOIN tenants t USING(tenant_id) WHERE s.subscription_id=$1 AND s.tenant_id=$2`,[event.subscription_id,event.tenant_id])).rows[0];
 if(!row||row.status!=='active'||row.tenant_status!=='active')return false;
 if(event.kind==='expiring')return ['payment','manual'].includes(row.source)&&row.current_period_end!==null&&+new Date(row.current_period_end)===+new Date(event.period_end)&&+new Date(event.period_end)>+now&&+new Date(event.period_end)<=+now+3*86400000;
 if(row.source!=='payment')return false;
 if(+now-+new Date(event.created_at)>7*86400000)return false;
 if(event.facts.source==='wallet')return !(await pool.query(`SELECT 1 FROM wallet_requests WHERE purchase_id::text=$1 AND status='paid'`,[event.facts.reference])).rowCount;
 return !(await pool.query(`SELECT 1 FROM payment_refund_requests WHERE payment_order_id::text=$1 AND status='succeeded'`,[event.facts.reference])).rowCount;
}
async function recipients(tenant:string){return (await pool.query(`SELECT DISTINCT lower(u.email) AS email FROM tenant_memberships m JOIN platform_users u USING(platform_user_id)
 WHERE m.tenant_id=$1 AND m.role='tenant_admin' AND m.status='active' AND u.status='active' AND u.email_verified_at IS NOT NULL AND u.email IS NOT NULL`,[tenant])).rows.map(r=>r.email as string);}
export function subscriptionMailContent(event:any):Omit<Mail,'to'>{
 const end=new Date(event.period_end).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 const info=`企业：${String(event.facts.tenant_name)}\n套餐：${String(event.facts.plan_name)}\n到期时间：${end}（北京时间）`;
 return event.kind==='purchased'?{subject:'【答巢】套餐购买成功',text:`您的套餐购买／续费已成功。\n\n${info}\n本次支付：¥${(Number(event.facts.amount_minor)/100).toFixed(2)}（含赠金抵扣）\n订单编号：${event.facts.reference}\n\n请登录 https://console.replynest.cn/billing 查看套餐与账务。套餐不会自动续费。`}
 :{subject:'【答巢】套餐将在 3 天内到期',text:`您的套餐即将到期，请及时续费以保持服务权益。\n\n${info}\n\n请登录 https://console.replynest.cn/billing 查看并续费。不会自动扣款；如刚完成续费，请以控制台显示的最新期限为准。`};
}

export async function processSubscriptionMail(now=new Date(),sender:typeof sendMail=sendMail){
 if(sender===sendMail){const d=mailProviderDiagnostic();if(!d.configured||(d.provider!=='mailpit'&&!d.live_send_enabled))return;}
 const lock=await pool.connect();try{
 if(!(await lock.query("SELECT pg_try_advisory_lock(hashtext('subscription-mail-worker')) AS locked")).rows[0].locked)return;
 try{
  await scheduleSubscriptionMail(now);
  // Acceptance followed by process failure is ambiguous; do not blindly resend.
  await pool.query(`UPDATE subscription_mail_deliveries SET status='review',error_code='delivery_outcome_unknown',updated_at=NOW() WHERE status='sending'`);
  const events=(await pool.query(`SELECT * FROM subscription_mail_events WHERE status='pending' AND next_attempt_at<=GREATEST($1::timestamptz,NOW()) ORDER BY next_attempt_at LIMIT 200`,[now])).rows;
  for(const event of events){
   if(!await validEvent(event,now)){await pool.query(`UPDATE subscription_mail_events SET status='canceled' WHERE event_id=$1`,[event.event_id]);continue;}
   const emails=await recipients(event.tenant_id);if(!emails.length){await pool.query(`UPDATE subscription_mail_events SET next_attempt_at=$2::timestamptz+INTERVAL '1 hour' WHERE event_id=$1`,[event.event_id,now]);continue;}
   for(const email of emails)await pool.query(`INSERT INTO subscription_mail_deliveries(event_id,email) VALUES($1,$2) ON CONFLICT DO NOTHING`,[event.event_id,email]);
   await pool.query(`UPDATE subscription_mail_events SET status='prepared' WHERE event_id=$1`,[event.event_id]);
  }
  const jobs=(await pool.query(`SELECT d.delivery_id,d.email,d.attempts,e.* FROM subscription_mail_deliveries d JOIN subscription_mail_events e USING(event_id) WHERE d.status IN ('pending','retry') AND d.next_attempt_at<=GREATEST($1::timestamptz,NOW()) ORDER BY d.next_attempt_at LIMIT 20`,[now])).rows;
  for(const job of jobs){
   if(!await validEvent(job,now)||!(await recipients(job.tenant_id)).includes(job.email)){await pool.query(`UPDATE subscription_mail_deliveries SET status='canceled',updated_at=NOW() WHERE delivery_id=$1`,[job.delivery_id]);continue;}
   await pool.query(`UPDATE subscription_mail_deliveries SET status='sending',attempts=attempts+1,updated_at=NOW() WHERE delivery_id=$1`,[job.delivery_id]);
   try{await sender({to:job.email,...subscriptionMailContent(job)});await pool.query(`UPDATE subscription_mail_deliveries SET status='sent',error_code=NULL,updated_at=NOW() WHERE delivery_id=$1`,[job.delivery_id]);}
   catch(error){const message=error instanceof Error?error.message:'';
    const rejected=/^SMTP (command failed with|greeting failed with|message rejected with) [45]\d\d$/.test(message)||message==='Mailgun send failed with HTTP 429';
    await pool.query(`UPDATE subscription_mail_deliveries SET status=$2,error_code=$3,next_attempt_at=$4::timestamptz+INTERVAL '10 minutes',updated_at=NOW() WHERE delivery_id=$1`,[job.delivery_id,rejected&&job.attempts<4?'retry':'review',rejected?'provider_rejected':'delivery_outcome_unknown',now]);
   }
  }
 }finally{await lock.query("SELECT pg_advisory_unlock(hashtext('subscription-mail-worker'))");}
 }finally{lock.release();}
}
