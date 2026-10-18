import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {queueWechatMedia,processWechatMedia,wechatMediaSchema} from './wechat-media-store.js';
const config={appId:'synthetic-app',appSecret:'synthetic-secret',token:'unused'};
const bytes=Buffer.from('89504e470d0a1a0a01','hex');
test('worker refuses infected or changed-account media; lost leases cannot publish blobs',async()=>{
  for(const scenario of ['infected','changed','lost','ready']){
    const updates:string[]=[],removed:string[]=[],stored:string[]=[];let resolves=0;
    const db:any={query:async(sql:string)=>{
      updates.push(sql);
      if(sql.includes('RETURNING m.*'))return {rows:[{media_id:'f4e98bea-a0d3-4bb1-8990-b0762742f632',tenant_id:'test',app_id:config.appId,descriptor:{kind:'image',mediaId:'source'}}],rowCount:1};
      if(sql.includes("SET status='ready'"))return {rows:[],rowCount:scenario==='lost'?0:1};
      return {rows:[],rowCount:1};
    }};
    await processWechatMedia(db,async()=>{resolves++;return scenario==='changed'&&resolves===2?{...config,appId:'other'}:config;},{download:async()=>({bytes,fileName:'图片.png',mimeType:'image/png',extension:'.png'}),scan:async()=>({clean:scenario!=='infected',result:'synthetic'}),store:async(key)=>{stored.push(key);},copy:async(key)=>`${key}.clean`,remove:async(key)=>{removed.push(key);}});
    if(['infected','changed'].includes(scenario)){assert.equal(stored.length,0);assert(!updates.some(s=>s.includes("SET status='ready'")));}
    if(scenario==='lost'){assert(removed.some(s=>s.endsWith('.clean')));assert(updates.some(s=>s.includes("available_at=NOW()+INTERVAL '30 seconds'")));}
    if(scenario==='ready'){assert.equal(stored.length,1);assert.match(stored[0],/[0-9a-f-]{36}-[0-9a-f-]{36}/);assert.equal(removed.length,1);}
  }
});
test('isolated PostgreSQL: simultaneous duplicate media has one stable tenant-scoped attachment',{skip:!process.env.WECHAT_MEDIA_TEST_DATABASE_URL},async()=>{
  const db=new pg.Pool({connectionString:process.env.WECHAT_MEDIA_TEST_DATABASE_URL});const previous=process.env.WECHAT_MEDIA_ENABLED;
  try{
    await db.query(`CREATE TABLE tenants(tenant_id TEXT PRIMARY KEY);CREATE TABLE conversation_attention(tenant_id TEXT);
      CREATE TABLE conversation_resource_mappings(replynest_resource_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id TEXT NOT NULL,resource_type TEXT NOT NULL,chatwoot_account_id TEXT NOT NULL,chatwoot_resource_id TEXT NOT NULL,parent_replynest_resource_id UUID,UNIQUE(tenant_id,resource_type,chatwoot_account_id,chatwoot_resource_id));INSERT INTO tenants VALUES('a'),('b');`);
    await db.query(wechatMediaSchema);process.env.WECHAT_MEDIA_ENABLED='true';
    const input={tenantId:'a',accountId:'11',conversationId:'1',messageId:'123',appId:config.appId,media:{kind:'image' as const,mediaId:'source-id'}};
    await Promise.all(Array.from({length:8},()=>queueWechatMedia(db,input)));
    assert.equal((await db.query('SELECT COUNT(*)::int n FROM wechat_message_media')).rows[0].n,1);
    assert.equal((await db.query("SELECT COUNT(*)::int n FROM conversation_resource_mappings WHERE resource_type='attachment'")).rows[0].n,1);
    await queueWechatMedia(db,{...input,tenantId:'b',accountId:'22'});
    const rows=(await db.query('SELECT tenant_id,account_id,media_id FROM wechat_message_media ORDER BY tenant_id')).rows;
    assert.equal(rows.length,2);assert.notEqual(rows[0].media_id,rows[1].media_id);assert.equal(rows[1].account_id,'22');
    await assert.rejects(db.query("INSERT INTO wechat_message_media(tenant_id,account_id,conversation_id,message_id,conversation_replynest_id,app_id,descriptor,expires_at,status) SELECT tenant_id,account_id,conversation_id,'bad',conversation_replynest_id,app_id,descriptor,expires_at,'unknown' FROM wechat_message_media LIMIT 1"),/check constraint/);
  }finally{if(previous===undefined)delete process.env.WECHAT_MEDIA_ENABLED;else process.env.WECHAT_MEDIA_ENABLED=previous;await db.end();}
});
