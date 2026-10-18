import type {IncomingMessage,ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {pool} from './database.js';
import {secretValue} from './secret-value.js';
import {sendJson} from './shared.js';
import {safeActivityRoute,shouldRecordOperation,verifiedMetadata,securityFilters} from './tenant-security-core.js';
type Auth={tenant_id:string;platform_user_id:string|null;actor_id:string;role:string;auth_kind:string;impersonation_id:string|null;session_scope:string|null};
type DB={query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,any>[]} >};
export const securityLogsEnabled=()=>process.env.TENANT_SECURITY_LOGS_ENABLED==='true';
let queued=0,failures=0,dropped=0,active=0;
const pending:Array<()=>Promise<void>>=[];
const drained:Array<()=>void>=[];
export function drainSecurityCaptures(){return queued?new Promise<void>(resolve=>drained.push(resolve)):Promise.resolve();}
function drainCapture(){while(active<2&&pending.length){const task=pending.shift()!;active++;void task().catch(()=>{failures++;console.error('tenant_security_capture_failed')}).finally(()=>{active--;queued--;drainCapture();if(!queued)for(const resolve of drained.splice(0))resolve();});}}
export function securityCaptureHealth(){return{queued,failures,dropped};}
export async function recordSecurityEvent(request:IncomingMessage,input:{tenant_id:string;actor_id:string;actor_type:'platform_user'|'tenant_api_key';category:'login'|'operation';action:string;path:string;status:number;request_id:string;impersonated?:boolean},db:DB=pool){
 if(!securityLogsEnabled())return;
 const m=verifiedMetadata(request.headers,request.method??'POST',input.path,secretValue('CONSOLE_ACTIVITY_SIGNING_KEY'));
 await db.query(`INSERT INTO tenant_security_events(tenant_id,actor_type,actor_id,category,action,route,method,http_status,client_ip,user_agent,ip_source,impersonated,request_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,$10,$11,$12,$13) ON CONFLICT(tenant_id,request_id,action) DO NOTHING`,[input.tenant_id,input.actor_type,input.actor_id,input.category,input.action,safeActivityRoute(input.path),request.method??'POST',input.status,m.client_ip,m.user_agent,m.ip_source,input.impersonated??false,input.request_id]);
}
export function captureSecurityOperation(request:IncomingMessage,response:ServerResponse,url:URL,auth:Auth,requestId:string){
 if(!securityLogsEnabled()||!shouldRecordOperation(request.method??'GET',url.pathname)||auth.session_scope==='copilot_embed')return;
 response.once('finish',()=>{
  if(queued>=100){dropped++;console.error('tenant_security_capture_overloaded');return;}queued++;
  pending.push(()=>recordSecurityEvent(request,{tenant_id:auth.tenant_id,actor_id:auth.actor_id,actor_type:auth.auth_kind==='console_session'?'platform_user':'tenant_api_key',category:'operation',action:`${request.method} ${safeActivityRoute(url.pathname)}`,path:url.pathname,status:response.statusCode,request_id:requestId,impersonated:Boolean(auth.impersonation_id)}));drainCapture();
 });
}
export async function recordSecurityLogin(request:IncomingMessage,userId:string,status:number,path='/api/v1/auth/login',action?:string){
 if(!securityLogsEnabled())return;
 try{
 // Resolve tenant membership on the server; never use a submitted tenant/email.
 const tenants=(await pool.query<{tenant_id:string}>(`SELECT tenant_id FROM tenant_memberships WHERE platform_user_id=$1 AND status='active' ORDER BY tenant_id`,[userId])).rows;
 const requestId=randomUUID();for(const t of tenants){try{await recordSecurityEvent(request,{tenant_id:t.tenant_id,actor_id:userId,actor_type:'platform_user',category:action?'operation':'login',action:action??(status<400?'identity.login_succeeded':'identity.login_failed'),path,status,request_id:requestId})}catch{failures++;console.error('tenant_security_login_capture_failed')}}
 }catch{failures++;console.error('tenant_security_login_capture_failed')}
}
export async function listTenantSecurityEvents(auth:Auth,params:URLSearchParams,db:DB=pool){
 if(auth.auth_kind!=='console_session'||!auth.platform_user_id||auth.impersonation_id||auth.session_scope==='copilot_embed'||!['tenant_admin','supervisor','agent'].includes(auth.role))throw Error('security_identity_required');
 const f=securityFilters(params),personal=auth.role==='tenant_admin'?null:auth.platform_user_id,pattern='%'+f.q.replace(/[\\%_]/g,'\\$&')+'%';
 const rows=(await db.query(`SELECT e.event_id,e.actor_type,e.actor_id,u.display_name AS actor_name,u.email AS actor_email,e.category,e.action,e.route,e.method,e.http_status,
 host(e.client_ip) AS client_ip,e.user_agent,e.ip_source,e.impersonated,e.request_id,e.created_at
 FROM tenant_security_events e LEFT JOIN platform_users u ON e.actor_type='platform_user' AND u.platform_user_id::text=e.actor_id
 WHERE e.tenant_id=$1 AND e.created_at>=NOW()-INTERVAL '6 months' AND ($2::text IS NULL OR (e.actor_type='platform_user' AND e.actor_id=$2))
 AND ($3='all' OR e.category=$3) AND ($4='all' OR ($4='success' AND e.http_status<400) OR ($4='failure' AND e.http_status>=400))
 AND ($5='' OR e.action ILIKE $6 OR host(e.client_ip) ILIKE $6 OR u.email ILIKE $6 OR u.display_name ILIKE $6)
 AND ($7::timestamptz IS NULL OR (e.created_at,e.event_id)<($7::timestamptz,$8::uuid))
 ORDER BY e.created_at DESC,e.event_id DESC LIMIT 21`,[auth.tenant_id,personal,f.category,f.result,f.q,pattern,f.before?.at??null,f.before?.id??null])).rows;
 const items=rows.slice(0,20),last=items.at(-1);return{items,has_more:rows.length>20,next:rows.length>20&&last?Buffer.from(JSON.stringify({at:new Date(last.created_at).toISOString(),id:last.event_id})).toString('base64url'):null,scope:personal?'personal':'tenant',retention_months:6,capture_warning:failures>0||dropped>0};
}
export async function handleTenantSecurityApi(request:IncomingMessage,response:ServerResponse,url:URL,auth:Auth,requestId:string){
 if(url.pathname!=='/api/v1/security/events')return false;
 if(!securityLogsEnabled()){sendJson(response,503,{error:{code:'security_logs_not_enabled'}});return true}
 if(request.method!=='GET'){sendJson(response,405,{error:{code:'method_not_allowed'}});return true}
 try{sendJson(response,200,{request_id:requestId,data:await listTenantSecurityEvents(auth,url.searchParams)})}catch(e){const code=e instanceof Error?e.message:'';sendJson(response,code==='security_identity_required'?403:['invalid_security_filter','invalid_security_cursor'].includes(code)?400:503,{error:{code:['security_identity_required','invalid_security_filter','invalid_security_cursor'].includes(code)?code:'security_logs_unavailable'}})}return true;
}
let cleaning=false;
export async function cleanExpiredSecurityLogs(){if(!securityLogsEnabled()||cleaning)return;cleaning=true;try{const r=await pool.query(`SELECT public.purge_expired_tenant_security_events() AS processed`);if(r.rows[0]?.processed)console.info(JSON.stringify({event:'tenant_security_retention',processed:r.rows[0].processed,months:6}));}catch{console.error('tenant_security_retention_failed')}finally{cleaning=false}}
