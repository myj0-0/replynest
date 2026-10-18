import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { ensureSharedWechatCustomer } from "./shared-wechat-customer.js";
test("shared profiles backfill independently and preserve tenant edits",{skip:!process.env.SHARED_WECHAT_TEST_DATABASE_URL},async()=>{
  const setup=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL});
  await setup.query("CREATE SCHEMA shared_customer_test"); await setup.end();
  const db=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL,options:"-c search_path=shared_customer_test"});
  try {
    await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY,chatwoot_account_id BIGINT);
      CREATE TABLE shared_wechat_threads(app_id TEXT,tenant_id TEXT,open_id TEXT,account_id BIGINT,conversation_id BIGINT,contact_id BIGINT);
      CREATE TABLE customers(customer_id UUID DEFAULT gen_random_uuid(),tenant_id TEXT,name TEXT);
      CREATE TABLE channel_identities(tenant_id TEXT,customer_id UUID,channel TEXT,external_user_id TEXT,chatwoot_source_id TEXT,chatwoot_conversation_id BIGINT,chatwoot_contact_id BIGINT,UNIQUE(tenant_id,channel,external_user_id));
      INSERT INTO tenants VALUES('a',1),('b',2);
      INSERT INTO shared_wechat_threads VALUES('app','a','same-user',1,1,11),('app','b','same-user',2,1,22);`);
    await Promise.all([ensureSharedWechatCustomer(db,'a','1'),ensureSharedWechatCustomer(db,'a','1'),ensureSharedWechatCustomer(db,'b','1')]);
    assert.equal((await db.query("SELECT * FROM customers")).rowCount,2);
    const identities=await db.query("SELECT * FROM channel_identities ORDER BY tenant_id");
    assert.notEqual(identities.rows[0].customer_id,identities.rows[1].customer_id);
    assert.notEqual(identities.rows[0].external_user_id,identities.rows[1].external_user_id);
    assert.equal(String(identities.rows[0].chatwoot_contact_id),'11');
    assert.equal(String(identities.rows[1].chatwoot_contact_id),'22');
    await db.query("UPDATE customers SET name='Manual name' WHERE tenant_id='a'");
    await ensureSharedWechatCustomer(db,'a','1');
    assert.equal((await db.query("SELECT name FROM customers WHERE tenant_id='a'")).rows[0].name,'Manual name');
    await ensureSharedWechatCustomer(db,'a','999');
    assert.equal((await db.query("SELECT * FROM customers")).rowCount,2);
  } finally {await db.end();}
});
