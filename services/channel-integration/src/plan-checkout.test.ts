import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createServer } from 'node:http';
import { pool } from './database.js';
import { planCheckoutSchema } from './plan-checkout-schema.js';
import { planPricingSchema } from './plan-pricing-schema.js';
import { publishPlanPricing } from './plan-pricing.js';
import { paymentRefundSchema } from './payment-refund-schema.js';
import { walletSchema } from './wallet-schema.js';
import { aiPointsSchema } from './ai-points-schema.js';
import { checkoutEnabled, createPlanCheckout, fulfillPlanPurchase, validateCheckoutInput } from './plan-checkout.js';
import { recordAlipaySettlement } from './alipay-settlement.js';
import { processPaymentLedgerOutbox } from './payment-ledger-outbox.js';
import { ledgerBalances } from './ledger.js';
import { listPaymentOrders } from './payment-operations.js';
import { effectiveEntitlement } from './subscriptions.js';
import { runPaymentReconciliation } from './payment-reconciliation.js';
import { handleBillingApi } from './billing-api.js';
import { requestPaymentRefund,approvePaymentRefund,executePaymentRefund } from './payment-refunds.js';
import { processPaymentQueries } from './payment-query.js';

test('checkout rejects client price/tenant/provider and defaults closed',()=>{
  delete process.env.PLAN_CHECKOUT_ENABLED;
  assert.equal(checkoutEnabled(),false);
  const input={plan_version_id:randomUUID(),idempotency_key:randomUUID(),device:'desktop'};
  assert.deepEqual(validateCheckoutInput(input),{...input,billing_period:"monthly"});
  for(const field of ['amount_minor','tenant_id','provider','return_url'])assert.throws(()=>validateCheckoutInput({...input,[field]:'evil'}));
});

test('checkout API rejects supervisors, API keys, embedded sessions and impersonation before database access',async()=>{
  const auth={tenant_id:'a',role:'tenant_admin' as 'tenant_admin'|'supervisor'|'agent',actor_id:'test',auth_kind:'console_session',session_scope:'console',impersonation_id:null as string|null};
  const server=createServer((req,res)=>{void handleBillingApi(req,res,new URL(req.url!,'http://localhost'),auth,randomUUID());});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  try {
    for(const override of [{role:'supervisor'},{role:'agent'},{auth_kind:'api_key'},{session_scope:'copilot_embed'},{impersonation_id:randomUUID()}]) {
      const before={...auth};Object.assign(auth,override);
      const response=await fetch(`http://127.0.0.1:${address.port}/api/v1/billing/checkout`,{method:'POST',body:'{}'});
      assert.equal(response.status,403);Object.assign(auth,before);
    }
    delete process.env.PLAN_CHECKOUT_ENABLED;
    const retired=await fetch(`http://127.0.0.1:${address.port}/api/v1/billing/checkout`,{method:'POST',body:'{}'});
    assert.equal(retired.status,409);
    assert.equal((await retired.json() as {error:{code:string}}).error.code,'wallet_checkout_required');
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});

test('plan checkout and fulfillment with production SQL constraints', {skip:!process.env.ALIPAY_TEST_DATABASE_URL}, async t=>{
  const schema='checkout_'+randomUUID().replaceAll('-','');
  const setup=new pg.Pool({connectionString:process.env.ALIPAY_TEST_DATABASE_URL});await setup.query(`CREATE SCHEMA ${schema}`);await setup.end();
  const db=new pg.Pool({connectionString:process.env.ALIPAY_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const originalQuery=pool.query,originalConnect=pool.connect;
  pool.query=db.query.bind(db) as typeof pool.query;pool.connect=db.connect.bind(db) as typeof pool.connect;
  const keys=['PLAN_CHECKOUT_ENABLED','PAYMENT_PROVIDER','PAYMENT_LIVE_ENABLED','ALIPAY_NOTIFY_ENABLED','PAYMENT_MODE','ALIPAY_APP_ID','ALIPAY_SELLER_ID','ALIPAY_PRIVATE_KEY','ALIPAY_PUBLIC_KEY','ALIPAY_NOTIFY_URL','ALIPAY_RETURN_URL','ALIPAY_REFUND_ENABLED','PAYMENT_ORDER_QUERY_ENABLED'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    const source=await readFile(new URL('../src/database.ts',import.meta.url),'utf8');
    // Referral growth has its own full-schema isolated suite; this fixture only exercises direct checkout.
    const chunk=(start:string,end:string)=>source.slice(source.indexOf(start),source.indexOf(end)).replace(/\$\{(?:extensionSchema|automationRuleSchema|openPlatformSchema|growthPolicySchema|subscriptionMailSchema)\}/g,'');
    await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY); INSERT INTO tenants VALUES('a'),('b'),('c'),('d'),('e'),('f'),('g');
      CREATE TABLE audit_logs(tenant_id TEXT,actor_type TEXT,actor_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,after_data JSONB,request_id UUID);
      CREATE TABLE trial_entitlements(tenant_id TEXT,status TEXT,entitlement_id UUID DEFAULT gen_random_uuid(),ends_at TIMESTAMPTZ,grace_ends_at TIMESTAMPTZ,benefit_snapshot JSONB,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());`);
    await db.query(chunk('CREATE TABLE IF NOT EXISTS billing_accounts (','CREATE TABLE IF NOT EXISTS payment_repair_requests ('));
    await db.query(chunk('CREATE TABLE IF NOT EXISTS payment_order_query_jobs (','CREATE TABLE IF NOT EXISTS growth_campaigns ('));
    await db.query(chunk('CREATE TABLE IF NOT EXISTS plan_catalog_versions (','CREATE TABLE IF NOT EXISTS usage_events (').replace('${planPricingSchema}',()=>planPricingSchema).replace('${planCheckoutSchema}',()=>planCheckoutSchema).replace('${paymentRefundSchema}',()=>paymentRefundSchema).replace('${walletSchema}',()=>walletSchema).replace('${aiPointsSchema}',()=>aiPointsSchema));
    const rules={seat_limit:5,channel_limit:3,customer_limit:1000,ai_actions_monthly:100,knowledge_bytes:1000,automation_rule_limit:2,qr_code_limit:5,audit_retention_days:30,features:['web.chat']};
    const plans:Record<string,string>={};
    for(const code of ['free','starter','professional']){
      plans[code]=(await db.query(`INSERT INTO plan_catalog_versions(plan_code,version,status,name,billing_period,price_minor,currency,entitlement_rules,effective_from)
        VALUES($1,1,'active',$1,$2,$3,'CNY',$4,NOW()) RETURNING plan_version_id`,[code,code==='free'?'none':'monthly',code==='free'?0:9900,JSON.stringify(rules)])).rows[0].plan_version_id;
    }
    const app=generateKeyPairSync('rsa',{modulusLength:2048}),alipay=generateKeyPairSync('rsa',{modulusLength:2048});
    Object.assign(process.env,{PLAN_CHECKOUT_ENABLED:'true',PAYMENT_PROVIDER:'alipay',PAYMENT_LIVE_ENABLED:'true',ALIPAY_NOTIFY_ENABLED:'true',PAYMENT_MODE:'live',ALIPAY_APP_ID:'2021000000000001',ALIPAY_SELLER_ID:'2088000000000001',ALIPAY_PRIVATE_KEY:app.privateKey.export({format:'pem',type:'pkcs8'}).toString(),ALIPAY_PUBLIC_KEY:alipay.publicKey.export({format:'pem',type:'spki'}).toString(),ALIPAY_NOTIFY_URL:'https://api.replynest.cn/webhooks/alipay',ALIPAY_RETURN_URL:'https://console.replynest.cn/billing'});
    const buy=(tenant='a',plan='starter',key=randomUUID())=>createPlanCheckout(tenant,'test-admin',{plan_version_id:plans[plan],idempotency_key:key,device:'desktop'},randomUUID());
    const settle=async(order:any)=>{const trade='20260922'+String(Math.floor(Math.random()*1e12)).padStart(12,'0');const e={orderNumber:order.order_number,tradeNumber:trade,amountMinor:9900,paidAt:new Date().toISOString(),eventId:`alipay:paid:${trade}`};await Promise.all([recordAlipaySettlement(e),recordAlipaySettlement(e)]);};
    let first:any;
    await t.test('server-priced order, concurrent idempotency, tenant scoping and pending protection',async()=>{
      const key=randomUUID(),results=await Promise.all([buy('a','starter',key),buy('a','starter',key)]);
      first=results[0];assert.equal(results[0].payment_order_id,results[1].payment_order_id);assert.equal(first.amount_minor,'9900');
      await assert.rejects(buy('a'),/checkout_in_progress/);
      await assert.rejects(buy('a','professional',key),/checkout_conflict/);
      assert.equal((await listPaymentOrders('b',{page:1,limit:20})).data.length,0);
      assert.equal(await fulfillPlanPurchase(first.payment_order_id),false);
      assert.equal((await db.query('SELECT * FROM tenant_subscriptions')).rowCount,0);
    });
    await t.test('replayed notification + parallel fulfillment grants once and never credits wallet',async()=>{
      await db.query(`INSERT INTO trial_entitlements(tenant_id,status,ends_at,grace_ends_at) VALUES('a','active',NOW()+INTERVAL '7 days',NOW()+INTERVAL '8 days')`);
      await settle(first);
      assert.equal(await fulfillPlanPurchase(first.payment_order_id),false); // ledger must post first
      assert.equal((await processPaymentLedgerOutbox()).succeeded,1);
      await Promise.all([fulfillPlanPurchase(first.payment_order_id),fulfillPlanPurchase(first.payment_order_id)]);
      assert.equal((await db.query('SELECT * FROM subscription_events')).rowCount,1);
      assert.equal((await db.query(`SELECT status FROM trial_entitlements WHERE tenant_id='a'`)).rows[0].status,'converted');
      assert.equal((await effectiveEntitlement('a')).plan.code,'starter');
      assert.equal((await ledgerBalances('a')).accounts.find(a=>a.account==='cash')?.balance_minor,'0');
      assert.equal((await runPaymentReconciliation()).difference_count,0);
      assert.equal((await listPaymentOrders('a',{page:1,limit:20})).data[0].fulfillment.status,'fulfilled');
      await assert.rejects(db.query(`UPDATE plan_payment_purchases SET amount_minor=1 WHERE payment_order_id=$1`,[first.payment_order_id]),/immutable/);
    });
    await t.test('same-plan renewal appends one month; cross-plan purchase blocked; expiry returns free',async()=>{
      await assert.rejects(buy('a','professional'),/plan_change_requires_review/);
      const before=(await db.query(`SELECT * FROM tenant_subscriptions WHERE tenant_id='a' AND status='active'`)).rows[0];
      const renewal=await buy();await settle(renewal);await processPaymentLedgerOutbox();await fulfillPlanPurchase(renewal.payment_order_id);
      const after=(await db.query(`SELECT * FROM tenant_subscriptions WHERE tenant_id='a' AND status='active'`)).rows[0];
      assert.equal(before.subscription_id,after.subscription_id);assert.ok(after.current_period_end>before.current_period_end);
      assert.equal((await db.query(`SELECT * FROM subscription_events WHERE tenant_id='a'`)).rowCount,2);
      await db.query(`UPDATE tenant_subscriptions SET current_period_start=NOW()-INTERVAL '2 months',current_period_end=NOW()-INTERVAL '1 day' WHERE subscription_id=$1`,[after.subscription_id]);
      assert.equal((await effectiveEntitlement('a')).plan.code,'free');
    });
    await t.test('changed subscription between checkout and payment enters review without overriding it',async()=>{
      const order=await buy('b');
      await db.query(`INSERT INTO tenant_subscriptions(tenant_id,plan_version_id,status,source,current_period_start,entitlement_snapshot) VALUES('b',$1,'active','manual',NOW(),$2)`,[plans.professional,JSON.stringify(rules)]);
      await settle(order);await processPaymentLedgerOutbox();await fulfillPlanPurchase(order.payment_order_id);
      assert.equal((await db.query(`SELECT status FROM plan_payment_purchases WHERE payment_order_id=$1`,[order.payment_order_id])).rows[0].status,'review');
      assert.equal((await effectiveEntitlement('b')).source,'manual');
    });
    await t.test('sandbox settlement cannot grant production entitlements',async()=>{
      process.env.PAYMENT_MODE='sandbox';const order=await buy('c');await settle(order);await processPaymentLedgerOutbox();await fulfillPlanPurchase(order.payment_order_id);
      assert.equal((await effectiveEntitlement('c')).plan.code,'free');
      assert.equal((await db.query(`SELECT review_reason FROM plan_payment_purchases WHERE payment_order_id=$1`,[order.payment_order_id])).rows[0].review_reason,'sandbox_no_production_entitlements');
    });
    await t.test('fulfillment failure rolls back subscription and retries without duplicate grant',async()=>{
      process.env.PAYMENT_MODE='live';const order=await buy('d');await settle(order);await processPaymentLedgerOutbox();
      await db.query(`CREATE FUNCTION fail_fulfillment_test() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test_storage_failure'; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_fulfillment_test BEFORE INSERT ON subscription_events FOR EACH ROW EXECUTE FUNCTION fail_fulfillment_test();`);
      await assert.rejects(fulfillPlanPurchase(order.payment_order_id),/test_storage_failure/);
      assert.equal((await db.query(`SELECT * FROM tenant_subscriptions WHERE tenant_id='d'`)).rowCount,0);
      assert.equal((await db.query(`SELECT status FROM plan_payment_purchases WHERE payment_order_id=$1`,[order.payment_order_id])).rows[0].status,'pending');
      await db.query('DROP TRIGGER fail_fulfillment_test ON subscription_events');
      assert.equal(await fulfillPlanPurchase(order.payment_order_id),true);
      assert.equal(await fulfillPlanPurchase(order.payment_order_id),false);
    });
    await t.test('missed notification reconciles from query; late notification never duplicates settlement',async()=>{
      process.env.PAYMENT_ORDER_QUERY_ENABLED='true';const order=await buy('e');
      await db.query(`INSERT INTO payment_order_query_jobs(tenant_id,payment_order_id,provider,slot_started_at) VALUES('e',$1,'alipay',NOW())`,[order.payment_order_id]);
      const trade='202609222200000000009999';const paidAt=new Date().toISOString();
      const result=await processPaymentQueries({alipay:{query:async()=>({provider:'alipay',state:'paid',merchant_order_number:order.order_number,provider_order_id:trade,provider_transaction_id:trade,amount_minor:9900,currency:'CNY',paid_at:paidAt})}});
      assert.equal(result.succeeded,1);
      await recordAlipaySettlement({orderNumber:order.order_number,tradeNumber:trade,amountMinor:9900,paidAt,eventId:`alipay:paid:${trade}`});
      assert.equal((await db.query('SELECT * FROM payment_ledger_outbox WHERE payment_order_id=$1',[order.payment_order_id])).rowCount,1);
      await processPaymentLedgerOutbox();await fulfillPlanPurchase(order.payment_order_id);
      assert.equal((await effectiveEntitlement('e')).plan.code,'starter');
    });
    await t.test('refund allows single admin, independent switch, one execution and revokes purchased term',async()=>{
      const order=(await db.query(`SELECT * FROM payment_orders WHERE tenant_id='d'`)).rows[0];
      const firstAdmin=randomUUID(),secondAdmin=randomUUID();
      const refund=await requestPaymentRefund(order.payment_order_id,firstAdmin,'customer requested refund for acceptance test');
      assert.equal(Number(refund.amount_minor),9801);
      await approvePaymentRefund(refund.refund_request_id,firstAdmin);
      await assert.rejects(buy('d'),/refund_in_progress/);
      let calls=0;const adapter={refund:async()=>{calls++;return{amount_minor:9801,occurred_at:'2026-09-22T12:00:00.000Z'};}};
      delete process.env.ALIPAY_REFUND_ENABLED;assert.equal(await executePaymentRefund(refund.refund_request_id,adapter),false);assert.equal(calls,0);
      process.env.ALIPAY_REFUND_ENABLED='true';
      await Promise.all([executePaymentRefund(refund.refund_request_id,adapter),executePaymentRefund(refund.refund_request_id,adapter)]);
      assert.equal(calls,1);assert.equal((await effectiveEntitlement('d')).plan.code,'free');
      assert.equal((await db.query('SELECT status FROM payment_orders WHERE payment_order_id=$1',[order.payment_order_id])).rows[0].status,'partially_refunded');
      assert.equal(await executePaymentRefund(refund.refund_request_id,adapter),false);
      await processPaymentLedgerOutbox();assert.equal((await ledgerBalances('d')).accounts.find(a=>a.account==='cash')?.balance_minor,'0');
      assert.equal((await runPaymentReconciliation()).difference_count,0);
    });
    await t.test('ambiguous refund keeps entitlements until confirmation and resumes same durable request',async()=>{
      const order=await buy('g');await settle(order);await processPaymentLedgerOutbox();await fulfillPlanPurchase(order.payment_order_id);
      const refund=await requestPaymentRefund(order.payment_order_id,randomUUID(),'customer requested full refund for retry test');await approvePaymentRefund(refund.refund_request_id,randomUUID());
      let calls=0;const numbers:string[]=[];
      const adapter={refund:async(_order:unknown,number:string)=>{numbers.push(number);if(++calls===1)throw new Error('timeout with sensitive SDK data');return{amount_minor:9801,occurred_at:'2026-09-22T13:00:00.000Z'};}};
      assert.equal(await executePaymentRefund(refund.refund_request_id,adapter),false);
      assert.equal((await effectiveEntitlement('g')).plan.code,'starter');
      const pending=(await db.query('SELECT * FROM payment_refund_requests WHERE refund_request_id=$1',[refund.refund_request_id])).rows[0];assert.equal(pending.status,'retry');assert.equal(pending.last_error_code,'refund_unconfirmed');
      await db.query('UPDATE payment_refund_requests SET available_at=NOW() WHERE refund_request_id=$1',[refund.refund_request_id]);
      assert.equal(await executePaymentRefund(refund.refund_request_id,adapter),true);assert.equal(numbers[0],numbers[1]);
      assert.equal((await effectiveEntitlement('g')).plan.code,'free');
    });
    await t.test('refunding a renewal preserves the earlier paid period',async()=>{
      const first=await buy('f');await settle(first);await processPaymentLedgerOutbox();await fulfillPlanPurchase(first.payment_order_id);
      const before=(await db.query(`SELECT current_period_end FROM tenant_subscriptions WHERE tenant_id='f'`)).rows[0].current_period_end;
      const next=await buy('f');await settle(next);await processPaymentLedgerOutbox();await fulfillPlanPurchase(next.payment_order_id);
      const refund=await requestPaymentRefund(next.payment_order_id,randomUUID(),'customer requested latest renewal refund');await approvePaymentRefund(refund.refund_request_id,randomUUID());
      assert.equal(await executePaymentRefund(refund.refund_request_id,{refund:async()=>({amount_minor:9801,occurred_at:'2026-09-22T14:00:00.000Z'})}),true);
      assert.equal((await db.query(`SELECT current_period_end FROM tenant_subscriptions WHERE tenant_id='f'`)).rows[0].current_period_end.toISOString(),before.toISOString());
      assert.equal((await effectiveEntitlement('f')).plan.code,'starter');
    });
    await t.test('publishing prices preserves old orders and permits same-entitlement renewal at new price',async()=>{
      const original=(await db.query(`SELECT amount_minor FROM payment_orders WHERE payment_order_id=$1`,[first.payment_order_id])).rows[0].amount_minor;
      const admin=randomUUID();
      await assert.rejects(publishPlanPricing({plan_code:'starter',expected_version:1,price_yuan:'79',list_price_yuan:'59',reason:'invalid original price for test'},admin),/invalid/);
      const next=await publishPlanPricing({plan_code:'starter',expected_version:1,price_yuan:'79',list_price_yuan:'99',reason:'publish new standard and offer prices'},admin);
      assert.equal(next.version,2);
      await assert.rejects(publishPlanPricing({plan_code:'starter',expected_version:1,price_yuan:'89',reason:'stale browser version should fail'},admin),/version_changed/);
      assert.equal((await db.query(`SELECT amount_minor FROM payment_orders WHERE payment_order_id=$1`,[first.payment_order_id])).rows[0].amount_minor,original);
      const before=(await db.query(`SELECT * FROM tenant_subscriptions WHERE tenant_id='f' AND status='active'`)).rows[0];
      const order=await createPlanCheckout('f','test-admin',{plan_version_id:next.plan_version_id,idempotency_key:randomUUID(),device:'desktop',billing_period:'annual'},randomUUID());
      assert.equal(order.amount_minor,'63200');
      const trade='202609222200000000001234';
      await recordAlipaySettlement({orderNumber:order.order_number,tradeNumber:trade,amountMinor:63200,paidAt:new Date().toISOString(),eventId:`alipay:paid:${trade}`});
      await processPaymentLedgerOutbox();assert.equal(await fulfillPlanPurchase(order.payment_order_id),true);
      const purchase=(await db.query('SELECT * FROM plan_payment_purchases WHERE payment_order_id=$1',[order.payment_order_id])).rows[0];
      assert.equal(purchase.subscription_id,before.subscription_id);assert.equal(purchase.period_start.toISOString(),before.current_period_end.toISOString());
      const days=(purchase.period_end.getTime()-purchase.period_start.getTime())/86400000;assert.ok(days===365||days===366);
      assert.equal((await db.query('SELECT price_minor_snapshot FROM tenant_subscriptions WHERE subscription_id=$1',[before.subscription_id])).rows[0].price_minor_snapshot,before.price_minor_snapshot);
      await assert.rejects(db.query('UPDATE plan_price_publications SET reason=$1',['changed']),/immutable/);
      await assert.rejects(db.query('UPDATE plan_payment_purchases SET refund_policy_version=NULL WHERE payment_order_id=$1',[order.payment_order_id]),/immutable/);
    });
  } finally {
    for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
    pool.query=originalQuery;pool.connect=originalConnect;await db.end();
  }
});
