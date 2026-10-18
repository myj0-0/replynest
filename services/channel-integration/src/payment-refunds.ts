import { randomUUID } from 'node:crypto';
import { pool } from './database.js';
import { createAlipayOperations } from './alipay-operations.js';
import { recordProviderPaymentEvent } from './payment-order.js';
import { quoteRefund } from './refund-policy.js';

export async function requestPaymentRefund(orderId:string,adminId:string,reason:string) {
  if(!/^[0-9a-f-]{36}$/i.test(orderId)||reason.trim().length<10||reason.trim().length>256)throw new Error('invalid_refund_request');
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const order=(await client.query(`SELECT o.*,p.period_start,p.period_end,p.refund_policy_version FROM payment_orders o JOIN plan_payment_purchases p USING(payment_order_id)
      WHERE o.payment_order_id=$1 AND o.provider='alipay' AND o.status='paid' AND o.refunded_minor=0 FOR UPDATE OF o`,[orderId])).rows[0];
    if(!order)throw new Error('refund_order_not_eligible');
    if(order.refund_policy_version!==1)throw new Error('legacy_refund_requires_review');
    if(!order.period_start||!order.period_end)throw new Error('refund_term_requires_review');
    const quote=quoteRefund(Number(order.amount_minor),new Date(order.paid_at),new Date(order.period_start),new Date(order.period_end));
    const id=randomUUID();
    const result=await client.query(`INSERT INTO payment_refund_requests(payment_order_id,tenant_id,amount_minor,request_number,reason,requested_by,policy_quote)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(payment_order_id) DO NOTHING RETURNING *`,[orderId,order.tenant_id,quote.amount_minor,`RNR${id.replaceAll('-','')}`,reason.trim(),adminId,quote]);
    if(!result.rows[0])throw new Error('refund_already_requested');
    await client.query('COMMIT');return result.rows[0];
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function approvePaymentRefund(id:string,adminId:string) {
  // Owner/admin may approve their own request; approval is still a separate, audited action.
  const result=await pool.query(`UPDATE payment_refund_requests SET approved_by=$2,status='approved',updated_at=NOW()
    WHERE refund_request_id=$1 AND status='requested' RETURNING *`,[id,adminId]);
  if(!result.rows[0])throw new Error('refund_not_approvable');return result.rows[0];
}
export async function listPaymentRefunds() {
  return (await pool.query(`SELECT r.*,o.order_number FROM payment_refund_requests r JOIN payment_orders o USING(payment_order_id) ORDER BY r.created_at DESC LIMIT 100`)).rows;
}
export async function rejectPaymentRefund(id:string) {
  const result=await pool.query(`UPDATE payment_refund_requests SET status='rejected',updated_at=NOW() WHERE refund_request_id=$1 AND status='requested' RETURNING *`,[id]);
  if(!result.rows[0])throw new Error('refund_not_rejectable');return result.rows[0];
}
type RefundAdapter=Pick<ReturnType<typeof createAlipayOperations>,'refund'>;
export async function executePaymentRefund(id:string,adapter?:RefundAdapter) {
  if(process.env.ALIPAY_REFUND_ENABLED!=='true'||process.env.PAYMENT_PROVIDER!=='alipay')return false;
  const client=await pool.connect();let locked=false,tenantId:string|undefined;
  try {
    const entry=(await client.query('SELECT tenant_id FROM payment_refund_requests WHERE refund_request_id=$1',[id])).rows[0];
    if(!entry)return false;tenantId=entry.tenant_id;
    // Session lock covers external uncertainty as well as the local transaction. No order row lock crosses network calls.
    const lock=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[`subscription-change:${tenantId}`])).rows[0];
    if(!lock.acquired)return false;locked=true;
    const r=(await client.query(`SELECT r.*,o.amount_minor AS order_amount_minor,o.status AS payment_status,o.order_number,o.provider,o.provider_order_id,o.currency,o.refunded_minor,
      p.payment_mode,p.status AS fulfillment_status,p.subscription_id,p.period_start,p.period_end
      FROM payment_refund_requests r JOIN payment_orders o USING(payment_order_id) JOIN plan_payment_purchases p USING(payment_order_id)
      WHERE r.refund_request_id=$1 AND r.status IN ('approved','processing','retry') AND r.available_at<=NOW()`,[id])).rows[0];
    if(!r||!r.approved_by)return false;
    const s=r.subscription_id?(await client.query('SELECT * FROM tenant_subscriptions WHERE subscription_id=$1',[r.subscription_id])).rows[0]:null;
    const matchingTerm=!s||(s.source==='payment'&&s.status==='active'&&new Date(s.current_period_end).getTime()===new Date(r.period_end).getTime());
    if(!matchingTerm&&!r.receipt_time){await client.query(`UPDATE payment_refund_requests SET status='review',last_error_code='subscription_term_changed',updated_at=NOW() WHERE refund_request_id=$1`,[id]);return false;}
    if(!['paid','partially_refunded','refunded'].includes(r.payment_status)||Number(r.refunded_minor)>0&&(!r.receipt_time||Number(r.refunded_minor)!==Number(r.amount_minor)))throw new Error('refund_payment_state_mismatch');
    await client.query(`UPDATE payment_refund_requests SET status='processing',attempt_count=attempt_count+1,available_at=NOW()+INTERVAL '60 seconds',updated_at=NOW() WHERE refund_request_id=$1`,[id]);
    // Persist a verified receipt before local recording. Recovery never invents a new request ID or timestamp.
    let receiptTime=r.receipt_time;
    if(!receiptTime){const result=await (adapter??createAlipayOperations()).refund({...r,amount_minor:Number(r.order_amount_minor)},r.request_number,Number(r.amount_minor),r.reason);
      if(result.amount_minor!==Number(r.amount_minor))throw new Error('refund_amount_mismatch');
      receiptTime=result.occurred_at;
      await client.query('UPDATE payment_refund_requests SET receipt_time=$2,updated_at=NOW() WHERE refund_request_id=$1',[id,receiptTime]);
    }
    await recordProviderPaymentEvent(r.tenant_id,r.payment_order_id,'alipay',{
      provider_event_id:`refund:${r.request_number}`,event_type:'payment_refunded',amount_minor:Number(r.amount_minor),currency:r.currency,
      occurred_at:new Date(receiptTime).toISOString(),provider_order_id:r.provider_order_id
    },{actor_id:'alipay-refund-worker',request_id:randomUUID()});
    await client.query('BEGIN');
    if(s&&matchingTerm){
      if(new Date(r.period_start).getTime()>new Date(s.current_period_start).getTime()) {
        await client.query(`UPDATE tenant_subscriptions SET current_period_end=$2,status=CASE WHEN $2::timestamptz>NOW() THEN 'active' ELSE 'expired' END,updated_at=NOW() WHERE subscription_id=$1`,[s.subscription_id,r.period_start]);
      }else await client.query(`UPDATE tenant_subscriptions SET status='canceled',updated_at=NOW() WHERE subscription_id=$1`,[s.subscription_id]);
      await client.query(`INSERT INTO subscription_events(tenant_id,subscription_id,event_type,source,event_key,facts)
        VALUES($1,$2,'plan_changed','alipay_refund',$3,$4) ON CONFLICT(tenant_id,event_key) DO NOTHING`,[r.tenant_id,s.subscription_id,`refund:${r.request_number}`,JSON.stringify({payment_order_id:r.payment_order_id,removed_period_start:r.period_start,removed_period_end:r.period_end})]);
    }
    await client.query(`UPDATE payment_refund_requests SET status=$2,last_error_code=$3,completed_at=NOW(),updated_at=NOW() WHERE refund_request_id=$1`,[id,matchingTerm?'succeeded':'review',matchingTerm?null:'refunded_subscription_review_required']);
    await client.query('COMMIT');return true;
  }catch(error){
    await client.query('ROLLBACK');
    // Do not persist arbitrary SDK errors or credentials; ambiguous results remain retryable.
    await client.query(`UPDATE payment_refund_requests SET status=CASE WHEN attempt_count>=10 THEN 'review' ELSE 'retry' END,
      last_error_code='refund_unconfirmed',available_at=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE refund_request_id=$1 AND status IN ('processing','retry','approved')`,[id]);
    return false;
  }finally{
    if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`subscription-change:${tenantId}`]);
    client.release();
  }
}
export async function processPaymentRefunds() {
  if(process.env.ALIPAY_REFUND_ENABLED!=='true')return;
  const rows=await pool.query(`SELECT refund_request_id FROM payment_refund_requests WHERE status IN ('approved','processing','retry') AND available_at<=NOW() ORDER BY created_at LIMIT 5`);
  for(const row of rows.rows)await executePaymentRefund(row.refund_request_id);
}
