import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PoolClient } from 'pg';
import type { AuthContext } from './business-api.js';
import { pool } from './database.js';
import { readBody, sendJson } from './shared.js';
import { encryptWebhookSecret } from './notification-webhook-crypto.js';
import { validateWebhookEndpoint } from './notification-webhook-adapter.js';
import { hashOpenToken, openScopes, OpenError, projectOpenCustomer, validateAppData, validateOpenScopes } from './open-platform-core.js';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const enabled=()=>process.env.OPEN_PLATFORM_ENABLED==='true';
async function bodyOf(req:IncomingMessage){const raw=await readBody(req);if(raw.length>20000)throw new OpenError('request_too_large',413);try{return JSON.parse(raw.toString()) as Record<string,unknown>;}catch{throw new OpenError('invalid_json');}}
async function audit(c:PoolClient,tenant:string,actor:string,action:string,id:string,requestId:string){await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,request_id) VALUES($1,'external_app',$2,$3,'external_app',$4,$5)`,[tenant,actor,`open.${action}`,id,requestId]);}
function failure(res:ServerResponse,e:unknown,id:string){sendJson(res,e instanceof OpenError?e.status:503,{request_id:id,error:{code:e instanceof OpenError?e.code:'open_platform_unavailable'}});}

export async function handleOpenAppManagement(req:IncomingMessage,res:ServerResponse,url:URL,auth:AuthContext,requestId:string){
  if(!url.pathname.startsWith('/api/v1/open-apps'))return false;
  res.setHeader('Cache-Control','no-store');
  const c=await pool.connect();
  try{
    if(!enabled())throw new OpenError('open_platform_disabled',503);
    if(auth.auth_kind!=='console_session'||auth.session_scope!=='console'||auth.impersonation_id||auth.role!=='tenant_admin')throw new OpenError('forbidden',403);
    const path=url.pathname.slice('/api/v1/open-apps'.length).split('/').filter(Boolean);
    if(path.length>2||path[0]&&!uuid.test(path[0]))throw new OpenError('not_found',404);
    const body=req.method==='POST'?await bodyOf(req):{};
    await c.query('BEGIN');
    const access=await c.query(`SELECT 1 FROM console_sessions s JOIN platform_users u USING(platform_user_id) JOIN tenant_memberships m ON m.platform_user_id=s.platform_user_id AND m.tenant_id=s.selected_tenant_id JOIN tenants t ON t.tenant_id=m.tenant_id WHERE s.session_id=$1 AND s.selected_tenant_id=$2 AND s.platform_user_id=$3 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND s.user_session_version=u.session_version AND u.status='active' AND m.status='active' AND m.role='tenant_admin' AND t.status IN ('active','test')`,[auth.key_id,auth.tenant_id,auth.platform_user_id]);
    if(!access.rowCount)throw new OpenError('forbidden',403);
    let data:unknown;
    if(req.method==='GET'&&!path.length){
      const apps=await c.query(`SELECT app_id,name,scopes,created_at,expires_at,revoked_at,(webhook_url_cipher IS NOT NULL) AS webhook_enabled FROM external_apps WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`,[auth.tenant_id]);
      data={apps:apps.rows,available_scopes:openScopes};
    }else if(req.method==='POST'&&!path.length){
      if(Object.keys(body).some(k=>!['name','scopes','confirmed_scopes','webhook_url'].includes(k)))throw new OpenError('invalid_fields');
      if(typeof body.name!=='string'||!body.name.trim()||body.name.length>60)throw new OpenError('invalid_name');
      const scopes=validateOpenScopes(body.scopes);
      if(JSON.stringify(validateOpenScopes(body.confirmed_scopes))!==JSON.stringify(scopes))throw new OpenError('consent_required',403);
      let endpoint:string|null=null;
      if(body.webhook_url){if(typeof body.webhook_url!=='string')throw new OpenError('invalid_webhook');try{endpoint=validateWebhookEndpoint('custom',body.webhook_url).href;}catch{throw new OpenError('invalid_webhook');}}
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`open-apps:${auth.tenant_id}`]);
      if(Number((await c.query('SELECT count(*) AS n FROM external_apps WHERE tenant_id=$1',[auth.tenant_id])).rows[0].n)>=100)throw new OpenError('app_limit',429);
      const token=`rn_app_${randomBytes(32).toString('hex')}`, signingSecret=endpoint?randomBytes(32).toString('hex'):null;
      const app=(await c.query(`INSERT INTO external_apps(tenant_id,name,scopes,token_hash,created_by,expires_at,webhook_url_cipher,webhook_secret_cipher) VALUES($1,$2,$3::jsonb,$4,$5,NOW()+INTERVAL '90 days',$6,$7) RETURNING app_id,name,scopes,expires_at`,[auth.tenant_id,body.name.trim(),JSON.stringify(scopes),hashOpenToken(token),auth.platform_user_id,endpoint?encryptWebhookSecret(endpoint):null,signingSecret?encryptWebhookSecret(signingSecret):null])).rows[0];
      await audit(c,auth.tenant_id,auth.actor_id,'created',app.app_id,requestId);
      data={...app,token,webhook_signing_secret:signingSecret};
    }else if(req.method==='POST'&&path[1]==='revoke'){
      if(Object.keys(body).length)throw new OpenError('invalid_fields');
      const found=await c.query('UPDATE external_apps SET revoked_at=COALESCE(revoked_at,NOW()) WHERE tenant_id=$1 AND app_id=$2 RETURNING app_id',[auth.tenant_id,path[0]]);
      if(!found.rowCount)throw new OpenError('not_found',404);
      await c.query("UPDATE external_app_events SET status='cancelled' WHERE tenant_id=$1 AND app_id=$2 AND status='pending'",[auth.tenant_id,path[0]]);
      await audit(c,auth.tenant_id,auth.actor_id,'revoked',path[0],requestId);data={revoked:true};
    }else if(req.method==='GET'&&path[1]==='deliveries'){
      data=(await c.query(`SELECT event_id,status,attempts,created_at,next_attempt_at FROM external_app_events WHERE tenant_id=$1 AND app_id=$2 ORDER BY created_at DESC LIMIT 100`,[auth.tenant_id,path[0]])).rows;
    }else throw new OpenError('not_found',404);
    await c.query('COMMIT');sendJson(res,200,{request_id:requestId,data});
  }catch(e){await c.query('ROLLBACK');failure(res,e,requestId);}finally{c.release();}
  return true;
}

/** Separate token namespace: these keys never enter the legacy tenant-admin API. */
export async function handleExternalApi(req:IncomingMessage,res:ServerResponse,url:URL){
  if(!url.pathname.startsWith('/api/v1/open/'))return false;
  const requestId=randomUUID();res.setHeader('Cache-Control','no-store');
  const c=await pool.connect();
  try{
    if(!enabled())throw new OpenError('open_platform_disabled',503);
    const token=(req.headers.authorization??'').replace(/^Bearer /,'');
    if(!/^rn_app_[a-f0-9]{64}$/.test(token))throw new OpenError('unauthorized',401);
    // Consume quota in its own committed transaction, including invalid/forbidden calls.
    await c.query('BEGIN');
    const app=(await c.query(`SELECT a.* FROM external_apps a JOIN tenants t USING(tenant_id) WHERE a.token_hash=$1 AND a.revoked_at IS NULL AND a.expires_at>NOW() AND t.status IN ('active','test') FOR UPDATE OF a`,[hashOpenToken(token)])).rows[0];
    if(!app)throw new OpenError('unauthorized',401);
    const rate=(await c.query(`INSERT INTO external_app_rate(tenant_id,app_id,bucket,count) VALUES($1,$2,date_trunc('minute',NOW()),1) ON CONFLICT(tenant_id,app_id) DO UPDATE SET bucket=date_trunc('minute',NOW()),count=CASE WHEN external_app_rate.bucket=date_trunc('minute',NOW()) THEN external_app_rate.count+1 ELSE 1 END RETURNING count`,[app.tenant_id,app.app_id])).rows[0].count;
    await c.query('COMMIT');
    res.setHeader('X-RateLimit-Limit','60');res.setHeader('X-RateLimit-Remaining',String(Math.max(0,60-rate)));
    if(rate>60){res.setHeader('Retry-After','60');throw new OpenError('rate_limited',429);}
    const body=req.method==='POST'?await bodyOf(req):{};
    await c.query('BEGIN');
    if(!(await c.query(`SELECT 1 FROM external_apps a JOIN tenants t USING(tenant_id) WHERE a.tenant_id=$1 AND a.app_id=$2 AND a.revoked_at IS NULL AND a.expires_at>NOW() AND t.status IN ('active','test') FOR UPDATE OF a`,[app.tenant_id,app.app_id])).rowCount)throw new OpenError('unauthorized',401);
    const scopes=app.scopes as string[];
    const requireScope=(s:string)=>{if(!scopes.includes(s))throw new OpenError('insufficient_scope',403);};
    const path=url.pathname.slice('/api/v1/open/'.length).split('/');
    let data:unknown;
    if(req.method==='GET'&&path[0]==='customers'&&path.length<=2){
      if(!scopes.some(s=>s.startsWith('customers.')))throw new OpenError('insufficient_scope',403);
      if(path[1]&&!uuid.test(path[1]))throw new OpenError('not_found',404);
      const after=url.searchParams.get('after');if(after&&!uuid.test(after))throw new OpenError('invalid_cursor');
      const rows=(await c.query(`SELECT customer_id,name,phone,email,support_note,created_at,updated_at FROM customers WHERE tenant_id=$1 AND ($2::uuid IS NULL OR customer_id=$2) AND ($3::uuid IS NULL OR customer_id>$3) ORDER BY customer_id LIMIT 51`,[app.tenant_id,path[1]??null,path[1]?null:after])).rows;
      if(path[1]){if(!rows.length)throw new OpenError('not_found',404);data=projectOpenCustomer(rows[0],scopes);}
      else data={items:rows.slice(0,50).map(r=>projectOpenCustomer(r,scopes)),next_after:rows.length>50?rows[49].customer_id:null};
    }else if(path.length===1&&path[0]==='records'&&req.method==='GET'){
      requireScope('app.records.read');
      const after=url.searchParams.get('after');if(after&&!uuid.test(after))throw new OpenError('invalid_cursor');
      const rows=(await c.query('SELECT record_id,data,created_at FROM external_app_records WHERE tenant_id=$1 AND app_id=$2 AND ($3::uuid IS NULL OR record_id>$3) ORDER BY record_id LIMIT 51',[app.tenant_id,app.app_id,after])).rows;
      data={items:rows.slice(0,50),next_after:rows.length>50?rows[49].record_id:null};
    }else if(path.length===1&&path[0]==='records'&&req.method==='POST'){
      requireScope('app.records.write');
      if(Object.keys(body).some(k=>k!=='data'))throw new OpenError('invalid_fields');
      const value=validateAppData(body.data), key=req.headers['idempotency-key'];
      if(typeof key!=='string'||!uuid.test(key))throw new OpenError('idempotency_key_required');
      const hash=hashOpenToken(JSON.stringify(value));
      const old=(await c.query('SELECT record_id,data,created_at,input_hash FROM external_app_records WHERE tenant_id=$1 AND app_id=$2 AND idempotency_key=$3',[app.tenant_id,app.app_id,key])).rows[0];
      if(old){if(old.input_hash!==hash)throw new OpenError('idempotency_conflict',409);data={record_id:old.record_id,data:old.data,created_at:old.created_at};}
      else{
        if(Number((await c.query('SELECT count(*) AS n FROM external_app_records WHERE tenant_id=$1 AND app_id=$2',[app.tenant_id,app.app_id])).rows[0].n)>=10000)throw new OpenError('record_limit',429);
        const row=(await c.query('INSERT INTO external_app_records(tenant_id,app_id,idempotency_key,input_hash,data) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING record_id,data,created_at',[app.tenant_id,app.app_id,key,hash,JSON.stringify(value)])).rows[0];data=row;
        if(app.webhook_url_cipher){const eventId=randomUUID();await c.query('INSERT INTO external_app_events(tenant_id,app_id,event_id,payload) VALUES($1,$2,$3,$4::jsonb)',[app.tenant_id,app.app_id,eventId,JSON.stringify({id:eventId,type:'app.record.created',api_version:'v1',created_at:new Date().toISOString(),data:{record_id:row.record_id}})]);}
      }
    }else throw new OpenError('not_found',404);
    await audit(c,app.tenant_id,app.app_id,`${req.method?.toLowerCase()}.${path[0]}`,app.app_id,requestId);
    await c.query('COMMIT');sendJson(res,200,{request_id:requestId,data});
  }catch(e){await c.query('ROLLBACK');failure(res,e,requestId);}finally{c.release();}
  return true;
}
