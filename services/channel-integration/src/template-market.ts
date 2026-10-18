import type { PoolClient } from 'pg';
import {randomUUID} from 'node:crypto';
import {parseMarketPayee,sealMarketPayee,openMarketPayee} from './market-payee-crypto.js';
import {lockKnowledgeCapacity} from './knowledge-capacity.js';
import {contentChecksum} from './knowledge-ingestion.js';
import { pool } from './database.js';
import { walletTransaction, walletFunds, walletAudit } from './wallet.js';
import { postLedgerInTransaction } from './ledger.js';
import { marketContent, marketKey, marketKind, marketMoney, marketQuote, marketText, TemplateMarketError } from './template-market-core.js';
import {validateDefinition,definitionHash} from './extension-core.js';
import {codePolicy} from './extension-code.js';

// Internal service layer only. HTTP endpoints must additionally enforce session, origin and request limits.
export async function browseMarketTemplates(input:{limit?:number;category?:string;kind?:string;cursor?:{created_at:string;listing_id:string}}={}) {
 const limit=input.limit??20;
 if(input.kind!==undefined)marketKind(input.kind);
 if(!Number.isInteger(limit)||limit<1||limit>50)throw new TemplateMarketError('invalid_market_page');
 if(input.category&&!['saas','education','ecommerce','email','wechat','general'].includes(input.category))throw new TemplateMarketError('invalid_market_category');
 const cursor=input.cursor;
 if(cursor&&(!Number.isFinite(Date.parse(cursor.created_at))||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.listing_id)))throw new TemplateMarketError('invalid_market_cursor');
 // Explicit projection: paid template content and private review notes never enter the catalog.
 const rows=(await pool.query(`SELECT listing_id,title,summary,category,kind,price_minor,created_at
  FROM template_market_listings WHERE status='published' AND ($1::text IS NULL OR category=$1)
  AND ($2::timestamptz IS NULL OR (created_at,listing_id)<($2::timestamptz,$3::uuid))
  AND ($5::text IS NULL OR kind=$5)
  ORDER BY created_at DESC,listing_id DESC LIMIT $4`,[input.category??null,cursor?.created_at??null,cursor?.listing_id??null,limit+1,input.kind??null])).rows;
 const more=rows.length>limit,items=rows.slice(0,limit),last=items.at(-1);
 return {items,next_cursor:more?{created_at:last.created_at.toISOString(),listing_id:last.listing_id}:null};
}
async function member(c:PoolClient,tenant:string,user:string) {
 const row=await c.query(`SELECT 1 FROM tenant_memberships m JOIN platform_users u USING(platform_user_id) JOIN tenants t USING(tenant_id)
 WHERE m.tenant_id=$1 AND m.platform_user_id=$2 AND m.role='tenant_admin' AND m.status='active' AND u.status='active' AND t.status='active'`,[tenant,user]);
 if(!row.rowCount)throw new TemplateMarketError('market_forbidden');
}
async function administrator(c:PoolClient,id:string) {
 const row=(await c.query(`SELECT role FROM platform_admin_accounts WHERE admin_id=$1 AND status='active' AND role IN ('owner','admin')`,[id])).rows[0];
 if(!row)throw new TemplateMarketError('market_forbidden');return row.role as string;
}
async function adminAudit(c:PoolClient,id:string,role:string,action:string,resource:string,reason:string,facts:unknown,requestId:string) {
 await c.query(`INSERT INTO platform_admin_audit_logs(actor_admin_id,actor_role,action,resource_type,resource_id,reason,after_data,request_id)
 VALUES($1,$2,$3,'template_market',$4,$5,$6::jsonb,$7)`,[id,role,action,resource,reason,JSON.stringify(facts),requestId]);
}
async function transaction<T>(fn:(c:PoolClient)=>Promise<T>) {
 const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
// Separate from buyer wallet locks: all seller liability mutations serialize here.
// Never acquire a buyer wallet/order lock while holding this lock.
async function sellerLock(c:PoolClient,tenant:string) {
 await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[`market-seller:${tenant}`]);
}
const payeeProjection='payee_id,tenant_id,subject_type,masked_name,masked_account,status,created_at,review_note';
export async function submitMarketPayee(tenant:string,user:string,raw:Record<string,unknown>,requestId:string){
 const value=parseMarketPayee(raw),id=randomUUID();
 if(raw.confirmed!==true)throw new TemplateMarketError('market_payee_confirmation_required');
 return transaction(async c=>{
  await member(c,tenant,user);await sellerLock(c,tenant);
  if((await c.query(`SELECT 1 FROM template_market_payouts WHERE seller_tenant_id=$1 AND status IN ('requested','approved') LIMIT 1`,[tenant])).rowCount)throw new TemplateMarketError('market_payee_payout_pending');
  const current=(await c.query(`SELECT payee_id FROM template_market_payees WHERE tenant_id=$1 ORDER BY created_at DESC,payee_id DESC LIMIT 1`,[tenant])).rows[0];
  if((raw.expected_payee_id??null)!==(current?.payee_id??null))throw new TemplateMarketError('market_payee_conflict');
  const sealed=sealMarketPayee(value,tenant,id);
  await c.query(`UPDATE template_market_payees SET status='superseded' WHERE tenant_id=$1 AND status IN ('pending','verified')`,[tenant]);
  const row=(await c.query(`INSERT INTO template_market_payees(payee_id,tenant_id,created_by,subject_type,sealed,masked_name,masked_account) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${payeeProjection}`,[id,tenant,user,value.subject_type,JSON.stringify(sealed),value.name.slice(0,1)+'***','***'+value.account.slice(-4)])).rows[0];
  await walletAudit(c,tenant,user,'market.payee_submitted',id,requestId);return row;
 });
}
export async function marketPayees(actor:string,tenant:string|null,offset=0){
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new TemplateMarketError('invalid_market_page');
 return transaction(async c=>{
  if(tenant)await member(c,tenant,actor);else await administrator(c,actor);
  const rows=(await c.query(`SELECT ${payeeProjection} FROM template_market_payees WHERE ($1::text IS NULL OR tenant_id=$1) ORDER BY created_at DESC,payee_id DESC LIMIT $2 OFFSET $3`,[tenant,tenant?1:21,offset])).rows;
  return {items:rows.slice(0,20),next_offset:!tenant&&rows.length>20?offset+20:null};
 });
}
export async function revealMarketPayee(admin:string,id:string,note:string,requestId:string){
 const reason=marketText(note,10,500);
 return transaction(async c=>{
  const role=await administrator(c,admin),row=(await c.query('SELECT tenant_id,sealed FROM template_market_payees WHERE payee_id=$1',[id])).rows[0];
  if(!row)throw new TemplateMarketError('market_payee_missing');
  const value=openMarketPayee(row.sealed,row.tenant_id,id);
  await adminAudit(c,admin,role,'market.payee_revealed',id,reason,{tenant_id:row.tenant_id},requestId);
  return value;
 });
}
export async function reviewMarketPayee(admin:string,id:string,action:string,note:string,requestId:string){
 const reason=marketText(note,10,500);
 if(!['verify','reject','revoke'].includes(action))throw new TemplateMarketError('invalid_market_action');
 return transaction(async c=>{
  const role=await administrator(c,admin),found=(await c.query('SELECT tenant_id FROM template_market_payees WHERE payee_id=$1',[id])).rows[0];
  if(!found)throw new TemplateMarketError('market_payee_missing');await sellerLock(c,found.tenant_id);
  const row=(await c.query('SELECT status FROM template_market_payees WHERE payee_id=$1 FOR UPDATE',[id])).rows[0];
  const status=action==='verify'?'verified':action==='reject'?'rejected':'revoked';
  if(row.status===status)return {payee_id:id,status,idempotent_replay:true};
  if(row.status!==(action==='revoke'?'verified':'pending'))throw new TemplateMarketError('market_payee_conflict');
  if(action==='verify'&&!(await c.query(`SELECT 1 FROM platform_admin_audit_logs WHERE actor_admin_id=$1 AND resource_id=$2 AND action='market.payee_revealed' AND created_at>NOW()-INTERVAL '30 minutes' LIMIT 1`,[admin,id])).rowCount)throw new TemplateMarketError('market_payee_review_requires_reveal');
  await c.query(`UPDATE template_market_payees SET status=$2,reviewed_by=$3,review_note=$4,reviewed_at=NOW() WHERE payee_id=$1`,[id,status,admin,reason]);
  await adminAudit(c,admin,role,'market.payee_'+status,id,reason,{status},requestId);return {payee_id:id,status};
 });
}
async function sellerFunds(c:PoolClient,tenant:string) {
 const row=(await c.query(`SELECT
 COALESCE(SUM(o.seller_minor) FILTER(WHERE r.status IS DISTINCT FROM 'approved'),0)::text total,
 COALESCE(SUM(o.seller_minor) FILTER(WHERE o.available_at<=NOW() AND (r.status IS NULL OR r.status='rejected')),0)::text matured
 FROM template_market_orders o LEFT JOIN template_market_refunds r USING(order_id) WHERE o.seller_tenant_id=$1`,[tenant])).rows[0];
 const payouts=(await c.query(`SELECT
 COALESCE(SUM(amount_minor) FILTER(WHERE status IN ('approved','paid')),0)::text committed,
 COALESCE(SUM(amount_minor) FILTER(WHERE status='requested'),0)::text reserved,
 COALESCE(SUM(amount_minor) FILTER(WHERE status='paid'),0)::text paid
 FROM template_market_payouts WHERE seller_tenant_id=$1`,[tenant])).rows[0];
 const total=BigInt(row.total),matured=BigInt(row.matured),committed=BigInt(payouts.committed),reserved=BigInt(payouts.reserved);
 const positive=(n:bigint)=>(n>0n?n:0n).toString();
 return {available_minor:positive(matured-committed-reserved),debt_minor:positive(committed-total),
  reserved_minor:reserved.toString(),committed_minor:committed.toString(),pending_payment_minor:(committed-BigInt(payouts.paid)).toString(),paid_minor:payouts.paid as string,matured_minor:matured.toString()};
}
export async function requestMarketPayout(tenant:string,user:string,raw:Record<string,unknown>,requestId:string) {
 const amount=marketMoney(raw.amount_minor,100000000),key=marketKey(raw.idempotency_key);
 if(amount<1||raw.accepted!==true)throw new TemplateMarketError('market_payout_acceptance_required');
 const fee=Math.floor((amount+50)/100),net=amount-fee;
 if(net<1)throw new TemplateMarketError('invalid_market_amount');
 return transaction(async c=>{
  await member(c,tenant,user);await sellerLock(c,tenant);
  const replay=(await c.query(`SELECT * FROM template_market_payouts WHERE seller_tenant_id=$1 AND idempotency_key=$2`,[tenant,key])).rows[0];
  if(replay){if(replay.amount_minor!==amount)throw new TemplateMarketError('market_idempotency_conflict');return {...replay,idempotent_replay:true};}
  const payee=(await c.query(`SELECT payee_id FROM template_market_payees WHERE tenant_id=$1 AND status='verified'`,[tenant])).rows[0];
  if(!payee)throw new TemplateMarketError('market_verified_payee_required');
  const funds=await sellerFunds(c,tenant);
  if(BigInt(funds.debt_minor)>0n)throw new TemplateMarketError('market_seller_debt');
  if(BigInt(funds.available_minor)<BigInt(amount))throw new TemplateMarketError('market_payout_insufficient');
  const row=(await c.query(`INSERT INTO template_market_payouts(seller_tenant_id,requested_by,idempotency_key,amount_minor,fee_bps,fee_minor,net_minor,payee_id) VALUES($1,$2,$3,$4,100,$5,$6,$7) RETURNING *`,[tenant,user,key,amount,fee,net,payee.payee_id])).rows[0];
  await walletAudit(c,tenant,user,'market.payout_requested',row.payout_id,requestId);return {...row,idempotent_replay:false};
 });
}
export async function marketPayouts(actor:string,tenant:string|null,offset=0) {
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new TemplateMarketError('invalid_market_page');
 return transaction(async c=>{
  if(tenant)await member(c,tenant,actor);else await administrator(c,actor);
  const rows=(await c.query(`SELECT payout_id,seller_tenant_id,amount_minor,fee_minor,net_minor,status,created_at,review_note,payment_reference,payee_id
   FROM template_market_payouts WHERE ($1::text IS NULL OR seller_tenant_id=$1)
   ORDER BY created_at DESC,payout_id DESC LIMIT 21 OFFSET $2`,[tenant,offset])).rows;
  return {items:rows.slice(0,20),next_offset:rows.length>20?offset+20:null};
 });
}
// Approval commits the reserved amount before any external manual transfer. Approved
// amounts remain committed through later refunds; recording the receipt cannot debit twice.
export async function reviewMarketPayout(admin:string,id:string,action:'approve'|'reject'|'paid',note:string,reference:unknown,requestId:string,confirmedUnpaid=false) {
 const reason=marketText(note,10,500);
 if(!['approve','reject','paid'].includes(action))throw new TemplateMarketError('invalid_market_action');
 const receipt=action==='paid'?marketText(reference,5,200):null;
 return transaction(async c=>{
  const role=await administrator(c,admin);
  const found=(await c.query(`SELECT seller_tenant_id FROM template_market_payouts WHERE payout_id=$1`,[id])).rows[0];
  if(!found)throw new TemplateMarketError('market_payout_missing');
  await sellerLock(c,found.seller_tenant_id);
  const row=(await c.query(`SELECT * FROM template_market_payouts WHERE payout_id=$1 FOR UPDATE`,[id])).rows[0];
  const status=action==='approve'?'approved':action==='reject'?'rejected':'paid';
  if(row.status===status){if(status==='paid'&&row.payment_reference!==receipt)throw new TemplateMarketError('market_receipt_conflict');return {...row,idempotent_replay:true};}
  if(!(row.status==='requested'&&action!=='paid')&&!(row.status==='approved'&&action!=='approve'))throw new TemplateMarketError('market_payout_conflict');
  if(row.status==='approved'&&action==='reject'&&confirmedUnpaid!==true)throw new TemplateMarketError('market_confirm_unpaid_required');
  if(action==='approve'){
   if(!row.payee_id||!(await c.query(`SELECT 1 FROM template_market_payees WHERE payee_id=$1 AND tenant_id=$2 AND status='verified'`,[row.payee_id,found.seller_tenant_id])).rowCount)throw new TemplateMarketError('market_verified_payee_required');
   const funds=await sellerFunds(c,found.seller_tenant_id);
   if(BigInt(funds.debt_minor)>0n||BigInt(funds.matured_minor)<BigInt(funds.committed_minor)+BigInt(funds.reserved_minor))throw new TemplateMarketError('market_payout_recheck_failed');
  }
  // Rejecting an approved request is an explicit operator assertion that no transfer
  // occurred. The HTTP/UI layer must require that assertion before exposing this action.
  const updated=(await c.query(`UPDATE template_market_payouts SET status=$2,reviewed_by=$3,review_note=$4,payment_reference=$5,updated_at=NOW() WHERE payout_id=$1 RETURNING *`,[id,status,admin,reason,receipt])).rows[0];
  await adminAudit(c,admin,role,'market.payout_'+status,id,reason,{amount_minor:row.amount_minor,fee_minor:row.fee_minor,net_minor:row.net_minor,payment_reference:receipt},requestId);
  return {...updated,idempotent_replay:false};
 });
}
export async function submitMarketTemplate(tenant:string,user:string,raw:Record<string,unknown>,requestId:string) {
 const title=marketText(raw.title,1,120),summary=marketText(raw.summary,5,1000),source=marketText(raw.source_note,5,2000),license=marketText(raw.license_text,10,4000);
 const category=String(raw.category),kind=String(raw.kind),content=marketContent(kind,raw.content),price=marketMoney(raw.price_minor);
 if(kind==='quick_replies'&&content.some(i=>i.title.length>80))throw new TemplateMarketError('market_title_too_long_for_reply');
 if(!['saas','education','ecommerce','email','wechat','general'].includes(category)||raw.rights_confirmed!==true)throw new TemplateMarketError('invalid_market_submission');
 return walletTransaction(tenant,async c=>{
  await member(c,tenant,user);
  const count=await c.query(`SELECT listing_id FROM template_market_listings WHERE seller_tenant_id=$1 AND status='pending' LIMIT 20`,[tenant]);
  if(count.rowCount===20)throw new TemplateMarketError('market_submission_limit');
  const row=(await c.query(`INSERT INTO template_market_listings(seller_tenant_id,created_by,title,summary,category,kind,content,price_minor,license_text,source_note)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING listing_id,status`,[tenant,user,title,summary,category,kind,JSON.stringify(content),price,license,source])).rows[0];
  await walletAudit(c,tenant,user,'market.template_submitted',row.listing_id,requestId);return row;
 });
}
export async function reviewMarketTemplate(admin:string,listing:string,action:'publish'|'reject'|'withdraw',note:string,requestId:string) {
 const reason=marketText(note,5,500);if(!['publish','reject','withdraw'].includes(action))throw new TemplateMarketError('invalid_market_action');
 return transaction(async c=>{
  const role=await administrator(c,admin),row=(await c.query(`SELECT * FROM template_market_listings WHERE listing_id=$1 FOR UPDATE`,[listing])).rows[0];
  if(!row||row.status!==(action==='withdraw'?'published':'pending'))throw new TemplateMarketError('market_review_conflict');
  const status=action==='publish'?'published':action==='reject'?'rejected':'withdrawn';
  await c.query(`UPDATE template_market_listings SET status=$2,reviewed_by=$3,review_note=$4,reviewed_at=NOW() WHERE listing_id=$1`,[listing,status,admin,reason]);
  await adminAudit(c,admin,role,'market.template_'+status,listing,reason,{status,price_minor:row.price_minor},requestId);return {listing_id:listing,status};
 });
}
export async function setMarketFee(admin:string,bps:unknown,expectedVersion:unknown,note:string,requestId:string) {
 const rate=marketMoney(bps,10000),version=marketMoney(expectedVersion,2147483647),reason=marketText(note,5,500);
 return transaction(async c=>{
  const role=await administrator(c,admin);
  const row=(await c.query(`UPDATE template_market_policy SET fee_bps=$1,version=version+1,updated_at=NOW() WHERE id=1 AND version=$2 RETURNING *`,[rate,version])).rows[0];
  if(!row)throw new TemplateMarketError('market_policy_conflict');
  await adminAudit(c,admin,role,'market.fee_updated','policy',reason,row,requestId);return row;
 });
}
export async function buyMarketTemplate(tenant:string,user:string,raw:Record<string,unknown>,requestId:string) {
 const key=marketKey(raw.idempotency_key),listing=marketText(raw.listing_id,36,36),expected=marketMoney(raw.expected_price_minor);
 if(raw.accepted!==true)throw new TemplateMarketError('market_acceptance_required');
 return walletTransaction(tenant,async c=>{
  await member(c,tenant,user);
  const replay=(await c.query(`SELECT * FROM template_market_orders WHERE buyer_tenant_id=$1 AND idempotency_key=$2`,[tenant,key])).rows[0];
  if(replay){if(replay.listing_id!==listing||replay.amount_minor!==expected)throw new TemplateMarketError('market_idempotency_conflict');return {...replay,idempotent_replay:true};}
  const item=(await c.query(`SELECT * FROM template_market_listings WHERE listing_id=$1 AND status='published' FOR SHARE`,[listing])).rows[0];
  if(!item)throw new TemplateMarketError('market_template_unavailable');
  if(item.seller_tenant_id===tenant)throw new TemplateMarketError('market_self_purchase');
  await sellerLock(c,item.seller_tenant_id);
  if(item.price_minor!==expected)throw new TemplateMarketError('market_price_changed');
  if((await c.query(`SELECT 1 FROM template_market_orders WHERE buyer_tenant_id=$1 AND listing_id=$2`,[tenant,listing])).rowCount)throw new TemplateMarketError('market_already_acquired');
  const policy=(await c.query(`SELECT * FROM template_market_policy WHERE id=1 FOR SHARE`)).rows[0],quote=marketQuote(expected,policy.fee_bps);
  const balance=await walletFunds(c,tenant);
  if(balance.available_cash_minor<expected)throw new TemplateMarketError('market_cash_insufficient');
  const order=(await c.query(`INSERT INTO template_market_orders(listing_id,buyer_tenant_id,seller_tenant_id,idempotency_key,created_by,amount_minor,fee_bps,fee_minor,seller_minor,policy_version)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[listing,tenant,item.seller_tenant_id,key,user,expected,quote.fee_bps,quote.fee_minor,quote.seller_minor,policy.version])).rows[0];
  if(expected)await postLedgerInTransaction(c,tenant,{transaction_type:'charge',currency:'CNY',idempotency_key:`market-buy:${order.order_id}`,source_type:'template_market',source_id:order.order_id,occurred_at:order.created_at.toISOString(),metadata:{policy_version:policy.version},entries:[{account:'cash',direction:'debit',amount_minor:expected},{account:'clearing',direction:'credit',amount_minor:expected}]},{actor_id:user,request_id:requestId});
  await c.query(`INSERT INTO template_market_journal(order_id,event,amount_minor,seller_minor,fee_minor) VALUES($1,'sale',$2,$3,$4)`,[order.order_id,expected,quote.seller_minor,quote.fee_minor]);
  await walletAudit(c,tenant,user,'market.template_acquired',order.order_id,requestId);return {...order,idempotent_replay:false};
 });
}
export async function marketWorkspace(tenant:string,user:string,view:string,offset=0,kind?:string) {
 if(kind!==undefined)marketKind(kind);
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!['submitted','acquired'].includes(view))throw new TemplateMarketError('invalid_market_page');
 return transaction(async c=>{await member(c,tenant,user);
  const rows=view==='submitted'?(await c.query(`SELECT listing_id,title,kind,price_minor,status,review_note,created_at FROM template_market_listings WHERE seller_tenant_id=$1 AND ($3::text IS NULL OR kind=$3) ORDER BY created_at DESC,listing_id DESC LIMIT 21 OFFSET $2`,[tenant,offset,kind??null])).rows:
   (await c.query(`SELECT o.order_id,l.title,l.kind,o.amount_minor,r.status AS refund_status,i.order_id IS NOT NULL AS imported FROM template_market_orders o JOIN template_market_listings l USING(listing_id) LEFT JOIN template_market_refunds r USING(order_id) LEFT JOIN template_market_imports i USING(order_id) WHERE o.buyer_tenant_id=$1 AND ($3::text IS NULL OR l.kind=$3) ORDER BY o.created_at DESC,o.order_id DESC LIMIT 21 OFFSET $2`,[tenant,offset,kind??null])).rows;
  return {items:rows.slice(0,20),next_offset:rows.length>20?offset+20:null};
 });
}
export async function marketReviewQueue(admin:string,offset=0) {
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new TemplateMarketError('invalid_market_page');
 return transaction(async c=>{await administrator(c,admin);
  const rows=(await c.query(`SELECT listing_id,title,summary,kind,price_minor,created_at FROM template_market_listings WHERE status='pending' ORDER BY created_at,listing_id LIMIT 21 OFFSET $1`,[offset])).rows;
  return {items:rows.slice(0,20),next_offset:rows.length>20?offset+20:null,policy:(await c.query('SELECT * FROM template_market_policy WHERE id=1')).rows[0]};
 });
}
export async function marketRefundQueue(admin:string,offset=0) {
 if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new TemplateMarketError('invalid_market_page');
 return transaction(async c=>{await administrator(c,admin);
  const rows=(await c.query(`SELECT r.order_id,r.reason,r.created_at,o.amount_minor,o.fee_minor,o.seller_minor,l.title,o.buyer_tenant_id,o.seller_tenant_id
   FROM template_market_refunds r JOIN template_market_orders o USING(order_id) JOIN template_market_listings l USING(listing_id)
   WHERE r.status='requested' ORDER BY r.created_at,r.order_id LIMIT 21 OFFSET $1`,[offset])).rows;
  return {items:rows.slice(0,20),next_offset:rows.length>20?offset+20:null};
 });
}
export async function marketReviewDetail(admin:string,listing:string) {
 return transaction(async c=>{await administrator(c,admin);return (await c.query(`SELECT * FROM template_market_listings WHERE listing_id=$1`,[listing])).rows[0]??null;});
}
export async function importMarketReplies(tenant:string,user:string,orderId:string,requestId:string) {
 return walletTransaction(tenant,async c=>{
  await member(c,tenant,user);
  const item=(await c.query(`SELECT l.*,o.order_id FROM template_market_orders o JOIN template_market_listings l USING(listing_id) LEFT JOIN template_market_refunds r USING(order_id)
   WHERE o.order_id=$1 AND o.buyer_tenant_id=$2 AND (r.status IS NULL OR r.status='rejected') FOR UPDATE OF o`,[orderId,tenant])).rows[0];
  if(!item)throw new TemplateMarketError('market_import_unavailable');
  const old=(await c.query('SELECT imported_ids FROM template_market_imports WHERE order_id=$1',[orderId])).rows[0];if(old)return {...old,idempotent_replay:true};
  const content=marketContent(item.kind,item.content);if(item.kind==='quick_replies'&&content.some(i=>i.title.length>80))throw new TemplateMarketError('market_title_too_long_for_reply');
  if(item.kind==='knowledge')await lockKnowledgeCapacity(c,tenant,content.reduce((n,row)=>n+Buffer.byteLength(row.body,'utf8'),0));
  const ids:string[]=[];
  for(const [index,row] of content.entries()) {
   const shortcut=`mt-${orderId.replaceAll('-','').slice(0,24)}-${index}`;
   if(item.kind==='quick_replies') {
    const result=await c.query(`INSERT INTO tenant_quick_replies(tenant_id,shortcut,title,content,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$5) RETURNING quick_reply_id`,[tenant,shortcut,row.title,row.body,user]);ids.push(result.rows[0].quick_reply_id);
   }else if(item.kind==='studio') {
    if(process.env.EXTENSION_BUILDER_ENABLED!=='true')throw new TemplateMarketError('extensions_disabled');
    const definition=validateDefinition(JSON.parse(row.body));
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`extensions:${tenant}`]);
    if(Number((await c.query('SELECT count(*) AS n FROM tenant_extensions WHERE tenant_id=$1',[tenant])).rows[0].n)>=20)throw new TemplateMarketError('extension_limit');
    const app=(await c.query('INSERT INTO tenant_extensions(tenant_id,name) VALUES($1,$2) RETURNING extension_id',[tenant,definition.name])).rows[0].extension_id;
    await c.query('INSERT INTO tenant_extension_versions(tenant_id,extension_id,version,definition,definition_hash,created_by,runtime_metadata) VALUES($1,$2,1,$3::jsonb,$4,$5,$6::jsonb)',[tenant,app,JSON.stringify(definition),definitionHash(definition),user,JSON.stringify(definition.code?codePolicy:{})]);ids.push(app);
   }else {
    const result=await c.query(`INSERT INTO knowledge_documents(tenant_id,title,source_type,status,content,content_format,content_checksum,file_size,ingestion_status)
     VALUES($1,$2,'knowledge','draft',$3,'text',$4,$5,'ready') RETURNING document_id`,[tenant,`${row.title} [模板 ${orderId}-${index}]`,row.body,contentChecksum(row.body),Buffer.byteLength(row.body,'utf8')]);ids.push(result.rows[0].document_id);
   }
  }
  await c.query(`INSERT INTO template_market_imports(order_id,tenant_id,created_by,imported_ids,license_text,source_note) VALUES($1,$2,$3,$4,$5,$6)`,[orderId,tenant,user,JSON.stringify(ids),item.license_text,item.source_note]);
  await walletAudit(c,tenant,user,item.kind==='studio'?'market.studio_draft_imported':item.kind==='knowledge'?'market.knowledge_drafts_imported':'market.replies_imported',orderId,requestId);return {imported_ids:ids,idempotent_replay:false,kind:item.kind};
 });
}
export async function requestMarketRefund(tenant:string,user:string,orderId:string,note:string,requestId:string) {
 const reason=marketText(note,5,500);
 return walletTransaction(tenant,async c=>{
  await member(c,tenant,user);
  const order=(await c.query(`SELECT * FROM template_market_orders WHERE order_id=$1 AND buyer_tenant_id=$2 FOR UPDATE`,[orderId,tenant])).rows[0];
  if(!order||order.amount_minor===0)throw new TemplateMarketError('market_order_not_refundable');
  await sellerLock(c,order.seller_tenant_id);
  const old=(await c.query(`SELECT * FROM template_market_refunds WHERE order_id=$1`,[orderId])).rows[0];
  if(old)return old;
  const row=(await c.query(`INSERT INTO template_market_refunds(order_id,reason,requested_by) VALUES($1,$2,$3) RETURNING *`,[orderId,reason,user])).rows[0];
  await walletAudit(c,tenant,user,'market.refund_requested',orderId,requestId);return row;
 });
}
export async function reviewMarketRefund(admin:string,orderId:string,action:'approve'|'reject',note:string,requestId:string) {
 const reason=marketText(note,5,500);if(!['approve','reject'].includes(action))throw new TemplateMarketError('invalid_market_action');
 // Orders are immutable. Only the buyer identity is read outside the wallet transaction.
 const found=(await pool.query(`SELECT buyer_tenant_id FROM template_market_orders WHERE order_id=$1`,[orderId])).rows[0];
 if(!found)throw new TemplateMarketError('market_order_missing');
 return walletTransaction(found.buyer_tenant_id,async c=>{
  const role=await administrator(c,admin),order=(await c.query(`SELECT * FROM template_market_orders WHERE order_id=$1 FOR UPDATE`,[orderId])).rows[0];
  await sellerLock(c,order.seller_tenant_id);
  const refund=(await c.query(`SELECT * FROM template_market_refunds WHERE order_id=$1 FOR UPDATE`,[orderId])).rows[0],status=action==='approve'?'approved':'rejected';
  if(!refund)throw new TemplateMarketError('market_refund_missing');
  if(refund.status===status)return {order_id:orderId,status,idempotent_replay:true};
  if(refund.status!=='requested')throw new TemplateMarketError('market_refund_conflict');
  if(action==='approve'){
   await postLedgerInTransaction(c,found.buyer_tenant_id,{transaction_type:'refund',currency:'CNY',idempotency_key:`market-refund:${orderId}`,source_type:'template_market_refund',source_id:orderId,occurred_at:new Date().toISOString(),entries:[{account:'clearing',direction:'debit',amount_minor:order.amount_minor},{account:'cash',direction:'credit',amount_minor:order.amount_minor}]},{actor_id:admin,request_id:requestId});
   await c.query(`INSERT INTO template_market_journal(order_id,event,amount_minor,seller_minor,fee_minor) VALUES($1,'refund',$2,$3,$4)`,[orderId,order.amount_minor,order.seller_minor,order.fee_minor]);
  }
  await c.query(`UPDATE template_market_refunds SET status=$2,reviewed_by=$3,review_note=$4,reviewed_at=NOW() WHERE order_id=$1`,[orderId,status,admin,reason]);
  await adminAudit(c,admin,role,'market.refund_'+status,orderId,reason,{amount_minor:order.amount_minor,fee_minor:order.fee_minor,seller_minor:order.seller_minor},requestId);
  return {order_id:orderId,status,idempotent_replay:false};
 });
}
export async function marketEarnings(tenant:string,user:string) {
 return transaction(async c=>{
  await member(c,tenant,user);
  await sellerLock(c,tenant);
  const row=(await c.query(`SELECT COALESCE(SUM(o.seller_minor) FILTER(WHERE r.status IS DISTINCT FROM 'approved'),0)::text total_minor,
    COALESCE(SUM(o.seller_minor) FILTER(WHERE r.status IS DISTINCT FROM 'approved' AND (o.available_at>NOW() OR r.status='requested')),0)::text frozen_minor,
    COALESCE(SUM(o.seller_minor) FILTER(WHERE o.available_at<=NOW() AND (r.status IS NULL OR r.status='rejected')),0)::text matured_minor
    FROM template_market_orders o LEFT JOIN template_market_refunds r USING(order_id) WHERE o.seller_tenant_id=$1`,[tenant])).rows[0];
  return {...row,...await sellerFunds(c,tenant),withdrawals_enabled:false};
 });
}
export async function acquiredMarketContent(tenant:string,user:string,order:string) {
 return transaction(async c=>{
  await member(c,tenant,user);
  const row=(await c.query(`SELECT l.kind,l.title,l.content,l.license_text,l.source_note FROM template_market_orders o JOIN template_market_listings l USING(listing_id)
    LEFT JOIN template_market_refunds r USING(order_id) WHERE o.buyer_tenant_id=$1 AND o.order_id=$2 AND (r.status IS NULL OR r.status='rejected')`,[tenant,order])).rows[0];
  if(!row)throw new TemplateMarketError('market_content_unavailable');return row;
 });
}
