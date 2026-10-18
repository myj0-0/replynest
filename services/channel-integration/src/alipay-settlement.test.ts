import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {pool} from './database.js';
import {recordAlipaySettlement} from './alipay-settlement.js';

test('persisted Alipay settlement: duplicate once, amount/transaction mismatch rejected and no tenant from callback',{skip:!process.env.ALIPAY_TEST_DATABASE_URL},async()=>{
 const schema='alipay_'+randomUUID().replaceAll('-','');
 const setup=new pg.Pool({connectionString:process.env.ALIPAY_TEST_DATABASE_URL});await setup.query(`CREATE SCHEMA ${schema}`);await setup.end();
 const db=new pg.Pool({connectionString:process.env.ALIPAY_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 const originalQuery=pool.query,originalConnect=pool.connect;pool.query=db.query.bind(db) as typeof pool.query;pool.connect=db.connect.bind(db) as typeof pool.connect;
 try {
  await db.query(`CREATE TABLE payment_orders(payment_order_id TEXT PRIMARY KEY,tenant_id TEXT,order_number TEXT UNIQUE,product_code TEXT,provider TEXT,provider_order_id TEXT,currency TEXT,amount_minor BIGINT,refunded_minor BIGINT,status TEXT,ledger_transaction_id TEXT,reversal_ledger_transaction_id TEXT,paid_at TIMESTAMPTZ,closed_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW());
   CREATE TABLE payment_events(payment_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT,payment_order_id TEXT,provider TEXT,provider_event_id TEXT,event_type TEXT,amount_minor BIGINT,currency TEXT,payload_hash TEXT,occurred_at TIMESTAMPTZ,received_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(provider,provider_event_id));
   CREATE TABLE payment_order_status_events(tenant_id TEXT,payment_order_id TEXT,payment_event_id UUID,from_status TEXT,to_status TEXT,outcome TEXT,reason TEXT);
   CREATE TABLE payment_ledger_outbox(tenant_id TEXT,payment_order_id TEXT,payment_event_id UUID UNIQUE,operation TEXT,amount_minor BIGINT,currency TEXT);
   CREATE TABLE audit_logs(tenant_id TEXT,actor_type TEXT,actor_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,after_data JSONB,request_id TEXT);
   INSERT INTO payment_orders(payment_order_id,tenant_id,order_number,product_code,provider,currency,amount_minor,refunded_minor,status) VALUES('order-a','tenant-a','RN20260922ABCDEF12','pro.monthly','alipay','CNY',9900,0,'pending_payment');`);
  const event={orderNumber:'RN20260922ABCDEF12',tradeNumber:'202609222200000000000001',amountMinor:9900,paidAt:'2026-09-22T04:34:56.000Z',eventId:'alipay:paid:202609222200000000000001'};
  await assert.rejects(recordAlipaySettlement({...event,amountMinor:1}),/mismatch/);
  await assert.rejects(recordAlipaySettlement({...event,orderNumber:'RNUNKNOWN000'}),/unknown/);
  await Promise.all([recordAlipaySettlement(event),recordAlipaySettlement(event)]);
  await assert.rejects(recordAlipaySettlement({...event,tradeNumber:'202609222200000000000002',eventId:'different'}),/mismatch/);
  const row=(await db.query('SELECT tenant_id,status FROM payment_orders')).rows[0];assert.equal(row.tenant_id,'tenant-a');assert.equal(row.status,'paid');
  assert.equal((await db.query('SELECT * FROM payment_events')).rowCount,1);assert.equal((await db.query('SELECT * FROM payment_ledger_outbox')).rowCount,1);
 }finally{pool.query=originalQuery;pool.connect=originalConnect;await db.end();}
});
