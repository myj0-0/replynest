import {pool} from './database.js';
import {adminRecordList,recordFilters} from './admin-record-lists.js';
import {aiPointBalances,aiPointsEnabled} from './ai-points.js';
import {walletTransaction,walletFunds,walletRequestKey,walletAudit} from './wallet.js';
import {WalletError,allocatePayment,takeGifts,parseYuan,feeQuote,splitRefund} from './wallet-core.js';
import {postLedgerInTransaction} from './ledger.js';
import {quoteAiPack,initialAiPrices} from './ai-points-core.js';
const uuid=/^[a-f0-9-]{36}$/i;
export async function purchaseAiPack(tenant:string,actor:string,raw:any,requestId:string){
 if(!aiPointsEnabled())throw new WalletError('ai_points_disabled',503);
 const key=walletRequestKey(raw);if(!uuid.test(raw.pack_version_id??'')||raw.accepted!==true)throw new WalletError('invalid_request',400);
 return walletTransaction(tenant,async c=>{
  const replay=(await c.query('SELECT * FROM ai_point_pack_purchases WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,key])).rows[0];
  if(replay){if(replay.pack_version_id!==raw.pack_version_id)throw new WalletError('idempotency_conflict');return replay;}
  const pack=(await c.query(`SELECT * FROM ai_point_pack_versions WHERE pack_version_id=$1 AND status='active' FOR SHARE`,[raw.pack_version_id])).rows[0];if(!pack)throw new WalletError('plan_unavailable');
  const balance=await walletFunds(c,tenant),amount=Number(pack.price_minor),allocation=allocatePayment(amount,balance.gift_minor,balance.available_cash_minor),gifts=takeGifts(balance.lots,allocation.gift_minor);
  const p=(await c.query(`INSERT INTO ai_point_pack_purchases(tenant_id,idempotency_key,pack_version_id,points,amount_minor,gift_minor,cash_minor,gift_allocations,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[tenant,key,pack.pack_version_id,pack.points,amount,allocation.gift_minor,allocation.cash_minor,JSON.stringify(gifts),actor])).rows[0];
  const common={source_type:'ai_point_pack',source_id:p.purchase_id,occurred_at:p.created_at.toISOString()};
  await postLedgerInTransaction(c,tenant,{...common,transaction_type:'charge',currency:'CNY',idempotency_key:`ai-pack-money:${p.purchase_id}`,metadata:{gift_allocations:gifts},entries:[...(allocation.gift_minor?[{account:'gift',direction:'debit',amount_minor:allocation.gift_minor}]:[]),...(allocation.cash_minor?[{account:'cash',direction:'debit',amount_minor:allocation.cash_minor}]:[]),{account:'revenue',direction:'credit',amount_minor:amount}]},{actor_id:actor,request_id:requestId});
  await postLedgerInTransaction(c,tenant,{...common,transaction_type:'ai_credit_grant',currency:'AIC',idempotency_key:`ai-pack-points:${p.purchase_id}`,entries:[{account:'clearing',direction:'debit',amount_minor:Number(pack.points)*100},{account:'ai_credit',direction:'credit',amount_minor:Number(pack.points)*100}]},{actor_id:actor,request_id:requestId});
  await walletAudit(c,tenant,actor,'ai_points.pack_purchased',p.purchase_id,requestId);return p;
 });
}
export async function aiPackRecords(tenant:string){return {purchases:(await pool.query(`SELECT p.*,r.status AS refund_status FROM ai_point_pack_purchases p LEFT JOIN ai_point_refunds r ON r.purchase_id=p.purchase_id AND r.status<>'rejected' WHERE p.tenant_id=$1 ORDER BY p.created_at DESC LIMIT 50`,[tenant])).rows,refunds:(await pool.query('SELECT * FROM ai_point_refunds WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 50',[tenant])).rows};}
export async function requestAiPackRefund(tenant:string,actor:string,raw:any,requestId:string){
 if(!uuid.test(raw.purchase_id??'')||raw.accepted!==true||typeof raw.reason!=='string'||raw.reason.trim().length<5||raw.reason.length>256)throw new WalletError('invalid_request',400);
 return walletTransaction(tenant,async c=>{
  const p=(await c.query('SELECT * FROM ai_point_pack_purchases WHERE tenant_id=$1 AND purchase_id=$2',[tenant,raw.purchase_id])).rows[0];if(!p)throw new WalletError('purchase_not_found',404);
  const old=(await c.query(`SELECT * FROM ai_point_refunds WHERE purchase_id=$1 AND status IN ('requested','approved')`,[p.purchase_id])).rows[0];if(old)return old;
  const entries=(await c.query(`SELECT e.entry_id FROM ledger_entries e JOIN ledger_transactions t USING(transaction_id) WHERE t.source_type='ai_point_pack' AND t.source_id=$1 AND e.tenant_id=$2 AND e.account='ai_credit' AND e.currency='AIC' AND e.direction='credit'`,[p.purchase_id,tenant])).rows;
  if(entries.length!==1)throw new WalletError('balance_requires_review');
  const b=await aiPointBalances(c,tenant),lot=b.lots.find(l=>l.entry_id===entries[0].entry_id),micros=lot?.amount_minor??0;
  // Active reservations were already removed from lots; wait for them to settle before refunding the remainder.
  if((await c.query(`SELECT 1 FROM ai_usage_calls WHERE tenant_id=$1 AND status='reserved' AND credit_allocations @> $2::jsonb`,[tenant,JSON.stringify([{entry_id:entries[0].entry_id}])])).rowCount)throw new WalletError('ai_usage_in_progress');
  const gross=Number(BigInt(p.amount_minor)*BigInt(micros)/(BigInt(p.points)*1_000_000n));if(gross<=0)throw new WalletError('no_refundable_points');
  const quote=feeQuote(gross),split=splitRefund(quote.net_minor,Number(p.gift_minor),Number(p.cash_minor));if(quote.net_minor<=0)throw new WalletError('no_refundable_points');
  const r=(await c.query(`INSERT INTO ai_point_refunds(tenant_id,purchase_id,entry_id,point_micros,amount_minor,fee_minor,net_minor,cash_minor,gift_minor,reason,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[tenant,p.purchase_id,entries[0].entry_id,micros,gross,quote.fee_minor,quote.net_minor,split.cash_minor,split.gift_minor,raw.reason.trim(),actor])).rows[0];
  await walletAudit(c,tenant,actor,'ai_points.refund_requested',r.request_id,requestId);return r;
 });
}
export async function reviewAiPackRefund(id:string,action:string,actor:string,raw:any,requestId:string){
 if(!uuid.test(id)||!['approve','reject'].includes(action)||typeof raw.reason!=='string'||raw.reason.trim().length<10||raw.reason.length>256)throw new WalletError('invalid_request',400);
 const tenant=(await pool.query('SELECT tenant_id FROM ai_point_refunds WHERE request_id=$1',[id])).rows[0]?.tenant_id;if(!tenant)throw new WalletError('request_not_found',404);
 return walletTransaction(tenant,async c=>{
  const r=(await c.query('SELECT * FROM ai_point_refunds WHERE request_id=$1 FOR UPDATE',[id])).rows[0],status=action==='approve'?'approved':'rejected';
  if(r.status===status)return r;if(r.status!=='requested')throw new WalletError('request_already_finished');
  if(action==='approve'){
   const p=(await c.query('SELECT * FROM ai_point_pack_purchases WHERE purchase_id=$1',[r.purchase_id])).rows[0],gifts=takeGifts(p.gift_allocations,Number(r.gift_minor));
   await postLedgerInTransaction(c,tenant,{transaction_type:'refund',currency:'CNY',idempotency_key:`ai-pack-refund:${id}`,source_type:'ai_point_refund',source_id:id,occurred_at:new Date().toISOString(),entries:[{account:'revenue',direction:'debit',amount_minor:Number(r.net_minor)},...(Number(r.cash_minor)?[{account:'cash',direction:'credit',amount_minor:Number(r.cash_minor)}]:[]),...gifts.map(g=>({account:'gift',direction:'credit',amount_minor:g.amount_minor,expires_at:g.expires_at}))]},{actor_id:actor,request_id:requestId});
  }
  await c.query('UPDATE ai_point_refunds SET status=$2,reviewed_by=$3,review_note=$4,updated_at=NOW() WHERE request_id=$1',[id,status,actor,raw.reason.trim()]);
  await walletAudit(c,tenant,actor,`ai_points.refund_${action}`,id,requestId);return {...r,status};
 });
}
import {readAiUsageSummary} from './ai-usage-summary.js';
export async function aiPointsAdminOverview(params=new URLSearchParams()){
 recordFilters(params,'points');
 const versions=(await pool.query('SELECT * FROM ai_point_pack_versions ORDER BY version DESC LIMIT 50')).rows;
 const summary=await readAiUsageSummary();
 const refunds=await adminRecordList('points',params);
 return {versions:versions.map(p=>({...p,...quoteAiPack(Number(p.points),Number(p.price_minor))})),...summary,refunds:refunds.items,page:refunds.page,has_more:refunds.has_more,prices:initialAiPrices,price_basis:'公开参考价格估算，实际渠道账单待核对；不含基础设施、税费与支付手续费'};
}
export async function publishAiPack(raw:any,actor:string){
 const points=Number(raw.points),expected=Number(raw.expected_version),price=parseYuan(raw.price_yuan);
 if(!Number.isSafeInteger(points)||points<1||points>10000000||price>10000000||!Number.isSafeInteger(expected)||typeof raw.reason!=='string'||raw.reason.trim().length<10||raw.reason.length>500)throw new WalletError('invalid_request',400);
 const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('ai-point-pack-prices'))");
 const old=(await c.query(`SELECT * FROM ai_point_pack_versions WHERE status='active' FOR UPDATE`)).rows[0];if(!old||old.version!==expected)throw new WalletError('version_conflict');
 await c.query(`UPDATE ai_point_pack_versions SET status='retired' WHERE pack_version_id=$1`,[old.pack_version_id]);
 const p=(await c.query(`INSERT INTO ai_point_pack_versions(version,points,price_minor,status,created_by,reason) VALUES($1,$2,$3,'active',$4,$5) RETURNING *`,[expected+1,points,price,actor,raw.reason.trim()])).rows[0];await c.query('COMMIT');return p;
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
