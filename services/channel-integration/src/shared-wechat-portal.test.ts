import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import pg from "pg";
import {handleSharedWechatPortal,migrateSharedWechatPortal,escapePortalHtml,portalAuthorizeUrl,safeWechatAvatar,clearSharedWechatProfile} from "./shared-wechat-portal.js";
test("portal URLs pin callback origin and request profile consent",()=>{
  const u=new URL(portalAuthorizeUrl("test","state"));
  assert.equal(u.searchParams.get("redirect_uri"),"https://replynest.cn/wechat/merchants/callback");
  assert.equal(u.searchParams.get("scope"),"snsapi_userinfo");
  assert.equal(escapePortalHtml('<script>"&'),"&lt;script&gt;&quot;&amp;");
  assert.equal(safeWechatAvatar('https://evil.example/avatar'),'');
  assert.equal(safeWechatAvatar('https://thirdwx.qlogo.cn/a'),'https://thirdwx.qlogo.cn/a');
});
test("portal OAuth is browser-bound, one-time, CSRF protected and association-scoped",{skip:!process.env.SHARED_WECHAT_TEST_DATABASE_URL},async()=>{
  const setup=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL});await setup.query("CREATE SCHEMA portal_test");await setup.end();
  const db=new pg.Pool({connectionString:process.env.SHARED_WECHAT_TEST_DATABASE_URL,options:"-c search_path=portal_test"});
  const originalFetch=globalThis.fetch;
  const server=createServer(async(req,res)=>{await handleSharedWechatPortal(req,res,new URL(req.url!,"http://local"),db,{appId:"app",appSecret:"secret-test",token:"token-test"});});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const a=server.address();assert(a&&typeof a!=="string");
  const base=`http://127.0.0.1:${a.port}/public/shared-wechat-portal`;
  try {
    await migrateSharedWechatPortal(db);
    await db.query(`CREATE TABLE tenants(tenant_id TEXT,name TEXT,status TEXT);
      CREATE TABLE shared_wechat_accounts(app_id TEXT,enabled BOOLEAN);
      CREATE TABLE shared_wechat_enrollments(app_id TEXT,tenant_id TEXT,enabled BOOLEAN);
      CREATE TABLE shared_wechat_merchant_profiles(tenant_id TEXT,introduction TEXT,website TEXT);
      CREATE TABLE shared_wechat_routing_states(app_id TEXT,open_id TEXT,state JSONB,updated_at TIMESTAMPTZ);
      INSERT INTO tenants VALUES('a','Merchant A','test'),('b','Merchant B','test'),('c','SECRET MERCHANT','test');
      INSERT INTO shared_wechat_accounts VALUES('app',TRUE);
      INSERT INTO shared_wechat_enrollments VALUES('app','a',TRUE),('app','b',TRUE),('app','c',TRUE);`);
    await db.query("INSERT INTO shared_wechat_routing_states VALUES('app','user',$1,NOW())",[{appId:'app',openId:'user',associations:[{tenantId:'a',name:'Merchant A'},{tenantId:'b',name:'Merchant B'}],version:1,lastTransitionAt:0}]);
    const start=await fetch(`${base}/start`,{redirect:"manual"});
    const state=new URL(start.headers.get("location")!).searchParams.get("state")!;
    const oauthCookie=start.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await fetch(`${base}/callback?code=test&state=${state}`,{redirect:'manual'})).status,400);
    globalThis.fetch=async(input,init)=>String(input).startsWith('https://api.weixin.qq.com/sns/userinfo')?new Response(JSON.stringify({openid:'user',nickname:'Test nickname',headimgurl:'https://thirdwx.qlogo.cn/a'})):String(input).startsWith('https://api.weixin.qq.com/')?new Response(JSON.stringify({openid:'user',scope:'snsapi_userinfo',access_token:'not-persisted'})):originalFetch(input,init);
    const callback=await fetch(`${base}/callback?code=test&state=${state}`,{headers:{cookie:oauthCookie},redirect:'manual'});
    assert.equal(callback.status,303);const sessionCookie=callback.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await db.query('SELECT nickname FROM shared_wechat_authorized_profiles')).rows[0].nickname,'Test nickname');
    assert.equal((await fetch(`${base}/callback?code=test&state=${state}`,{headers:{cookie:oauthCookie},redirect:'manual'})).status,400);
    const home=await fetch(`${base}/`,{headers:{cookie:sessionCookie}});const html=await home.text();
    assert.match(html,/Merchant A/);assert.match(html,/Merchant B/);assert(!html.includes('SECRET MERCHANT'));assert(!html.includes('not-persisted'));
    const csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)![1];
    async function select(merchant:string,csrfValue=csrf,origin='https://replynest.cn') {return fetch(`${base}/select`,{method:'POST',headers:{cookie:sessionCookie,origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({merchant,csrf:csrfValue}),redirect:'manual'});}
    assert.equal((await select('a','invalid')).status,400);
    assert.equal((await select('a',csrf,'https://evil.example')).status,400);
    assert.equal((await select('c')).status,400);
    assert.equal((await select('b')).status,303);
    const selected=(await db.query("SELECT state FROM shared_wechat_routing_states")).rows[0].state;
    assert.equal(selected.selected.tenantId,'b');assert.equal(selected.version,2);
    await db.query("UPDATE shared_wechat_enrollments SET enabled=FALSE WHERE tenant_id='b'");
    assert.equal((await select('b')).status,400);
    const single=await (await fetch(`${base}/`,{headers:{cookie:sessionCookie}})).text();
    assert.match(single,/商家详情/);assert.match(single,/左上角/);assert(!single.includes('切换至此商家'));
    await clearSharedWechatProfile(db,'app','user');
    assert.equal((await db.query('SELECT * FROM shared_wechat_authorized_profiles')).rowCount,0);
    assert.equal((await db.query('SELECT * FROM shared_wechat_portal_sessions')).rowCount,0);
  } finally {globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await db.end();}
});
