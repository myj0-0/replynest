import type {Pool} from 'pg';
export const WEBHOOK_MAX_ATTEMPTS=5;
export const WEBHOOK_TEST_EVENT='webhook.configuration_test';
type Database=Pick<Pool,'query'|'connect'>;
export function webhookFailure(error:unknown,provider?:string){
 const text=error instanceof Error?error.message:'';
 const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
 const http=text.match(/^webhook_http_(\d{3})$/);
 if(http){const status=Number(http[1]);return {code:`webhook_http_${status}`,retryable:[408,425,429].includes(status)||status>=500};}
 if(/^webhook_(?:dns_timeout|transport_failed|timeout|response_failed|response_aborted|response_closed|connection_closed|capacity_exceeded)$/.test(text))return {code:text,retryable:true};
 if(['ETIMEOUT','EAI_AGAIN','ESERVFAIL','ENOTFOUND','ECONNRESET','ECONNREFUSED'].includes(code))return {code:'webhook_network_unavailable',retryable:true};
 // Feishu explicitly documents 11232 as temporary bot flow control.
 if(provider==='feishu'&&text==='webhook_provider_11232')return {code:'webhook_provider_rate_limited',retryable:true};
 if(/^webhook_provider_\d+$/.test(text))return {code:text,retryable:false};
 return {code:'webhook_configuration_or_response_invalid',retryable:false};
}
export function webhookRetrySeconds(attempt:number){return Math.min(900,30*2**Math.max(0,attempt-1));}

/** Existing columns form a bounded 60-second lease; attempt count fences late completions. */
export async function claimNotificationWebhook(db:Database,id:string,tenant:string){
 await db.query(`UPDATE notification_deliveries SET status='failed',error_code='webhook_retry_exhausted',next_attempt_at=NULL,updated_at=NOW()
  WHERE delivery_id=$1 AND tenant_id=$2 AND channel='webhook' AND status='pending' AND attempt_count>=5
   AND (next_attempt_at IS NULL OR next_attempt_at<=NOW())`,[id,tenant]);
 const result=await db.query<{attempt_count:number}>(`UPDATE notification_deliveries d SET attempt_count=d.attempt_count+1,
  next_attempt_at=NOW()+INTERVAL '60 seconds',error_code='webhook_in_progress',updated_at=NOW()
  FROM notification_events e,tenants t WHERE d.delivery_id=$1 AND d.tenant_id=$2 AND d.channel='webhook'
   AND d.status='pending' AND d.attempt_count<5 AND (d.next_attempt_at IS NULL OR d.next_attempt_at<=NOW())
   AND e.notification_id=d.notification_id AND e.tenant_id=d.tenant_id AND (e.requires_action=FALSE OR e.status IN ('open','acknowledged'))
   AND t.tenant_id=d.tenant_id AND t.status IN ('active','test') RETURNING d.attempt_count`,[id,tenant]);
 return result.rows[0]?.attempt_count??null;
}
export async function finishNotificationWebhook(db:Database,id:string,tenant:string,attempt:number,status:'delivered'|'pending'|'failed'|'suppressed',code:string|null){
 const result=await db.query(`UPDATE notification_deliveries SET status=$4,error_code=$5,
  next_attempt_at=CASE WHEN $4='pending' THEN NOW()+make_interval(secs=>$6) ELSE NULL END,
  delivered_at=CASE WHEN $4='delivered' THEN NOW() ELSE delivered_at END,updated_at=NOW()
  WHERE delivery_id=$1 AND tenant_id=$2 AND channel='webhook' AND status='pending' AND attempt_count=$3 AND next_attempt_at>NOW() RETURNING delivery_id`,
  [id,tenant,attempt,status,code,webhookRetrySeconds(attempt)]);
 if(result.rowCount)await db.query(`UPDATE notification_webhook_destinations w SET
  last_test_status=CASE WHEN $4='delivered' THEN 'delivered' WHEN $4 IN ('failed','suppressed') THEN 'failed' ELSE NULL END,
  last_error_code=$5,updated_at=NOW() FROM notification_deliveries d,notification_events e
  WHERE d.delivery_id=$1 AND d.tenant_id=$2 AND e.notification_id=d.notification_id AND e.tenant_id=d.tenant_id
   AND e.event_type=$3 AND w.destination_id::text=d.target_ref AND w.tenant_id=d.tenant_id
   AND d.delivery_id=(SELECT latest.delivery_id FROM notification_deliveries latest JOIN notification_events le ON le.notification_id=latest.notification_id AND le.tenant_id=latest.tenant_id
    WHERE latest.tenant_id=d.tenant_id AND latest.target_ref=d.target_ref AND latest.channel='webhook' AND le.event_type=$3
    ORDER BY latest.created_at DESC,latest.delivery_id DESC LIMIT 1)`,[id,tenant,WEBHOOK_TEST_EVENT,status,code]);
 return Boolean(result.rowCount);
}

/** Only an explicitly requested, destination-bound test; no customer data or other targets. */
export async function queueNotificationWebhookTest(db:Database,tenant:string,destination:string){
 const client=await db.connect();
 try{
  await client.query('BEGIN');
  const target=await client.query(`SELECT destination_id FROM notification_webhook_destinations WHERE tenant_id=$1 AND destination_id=$2 AND status='active' FOR UPDATE`,[tenant,destination]);
  if(!target.rowCount)throw Error('notification_destination_not_found');
  const existing=await client.query(`SELECT d.delivery_id,d.status,d.attempt_count,d.next_attempt_at FROM notification_deliveries d
   JOIN notification_events e ON e.notification_id=d.notification_id AND e.tenant_id=d.tenant_id
   WHERE d.tenant_id=$1 AND d.target_ref=$2 AND d.channel='webhook' AND d.status='pending' AND e.event_type=$3
   ORDER BY d.created_at DESC,d.delivery_id DESC LIMIT 1`,[tenant,destination,WEBHOOK_TEST_EVENT]);
  if(existing.rows[0]){await client.query('COMMIT');return existing.rows[0];}
  const event=await client.query<{notification_id:string}>(`INSERT INTO notification_events(tenant_id,event_type,severity,title,summary,dedupe_key,status,requires_action,resolved_at,metadata)
   VALUES($1,$2,'info','Webhook 配置测试','ReplyNest 测试通知：不包含客户数据。','webhook-test:'||gen_random_uuid()::text,'resolved',FALSE,NOW(),'{"synthetic":true}'::jsonb) RETURNING notification_id`,[tenant,WEBHOOK_TEST_EVENT]);
  const delivery=await client.query(`INSERT INTO notification_deliveries(notification_id,tenant_id,channel,target_ref,status,next_attempt_at)
   VALUES($1,$2,'webhook',$3,'pending',NOW()) RETURNING delivery_id,status,attempt_count,next_attempt_at`,[event.rows[0].notification_id,tenant,destination]);
  await client.query(`UPDATE notification_webhook_destinations SET last_tested_at=NOW(),last_test_status=NULL,last_error_code=NULL,updated_at=NOW() WHERE tenant_id=$1 AND destination_id=$2`,[tenant,destination]);
  await client.query('COMMIT');return delivery.rows[0];
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
