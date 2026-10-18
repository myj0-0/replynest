import type {PoolClient} from 'pg';
import type {AuthContext} from './business-api.js';
import {pool} from './database.js';
import {ExtensionError,exactObject,validateDefinition,type StudioAction} from './extension-core.js';
import {encryptWebhookSecret,decryptWebhookSecret} from './notification-webhook-crypto.js';
import {postPublicWebhook,publicIpv4} from './public-webhook-transport.js';
import {isIP} from 'node:net';
import {createMessageCampaign,CampaignError} from './message-campaigns.js';
import {normalizeCampaignInput} from './message-campaign-core.js';
import {tenantCampaignAccess} from './campaign-access.js';

type Tx=<T>(fn:(c:PoolClient)=>Promise<T>)=>Promise<T>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function studioEndpoint(raw:unknown){
 if(typeof raw!=='string'||raw.length>2048)throw new ExtensionError('invalid_http_endpoint');
 let url:URL;try{url=new URL(raw);}catch{throw new ExtensionError('invalid_http_endpoint');}
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||(url.port&&url.port!=='443')||url.hostname.includes(':')||
  url.hostname==='localhost'||!url.hostname.includes('.')||isIP(url.hostname)&&!publicIpv4(url.hostname))throw new ExtensionError('invalid_http_endpoint');
 return url;
}
export function actionPayload(action:StudioAction,data:Record<string,unknown>){
 if(action.kind==='http')return Object.fromEntries(action.fields.filter(f=>Object.hasOwn(data,f)).map(f=>[f,data[f]]));
 try{
  const tag=action.audience_tag_field?data[action.audience_tag_field]:null;
  if(action.audience_tag_field&&(typeof tag!=='string'||!tag.trim()))throw Error('invalid_tag');
  return normalizeCampaignInput({name:data[action.name_field],content:data[action.content_field],channel:'wechat_official_account',
   audience_filter:action.audience_tag_field?{mode:'tags_any',tags:[tag]}:{mode:'all',tags:[]}});
 }catch{throw new ExtensionError('invalid_campaign_fields');}
}
export async function handleStudioActions(auth:AuthContext,id:string,method:string,body:Record<string,unknown>,requestId:string,tx:Tx,
 ports={post:postPublicWebhook,campaign:createMessageCampaign}){
 if(!uuid.test(id))throw new ExtensionError('not_found',404);
 const app=async(c:PoolClient,version:unknown)=>{
  if(!Number.isSafeInteger(version))throw new ExtensionError('invalid_version');
  const v=(await c.query(`SELECT e.enabled,e.active_version,v.definition FROM tenant_extensions e JOIN tenant_extension_versions v USING(tenant_id,extension_id)
   WHERE e.tenant_id=$1 AND e.extension_id=$2 AND v.version=$3 FOR SHARE OF e`,[auth.tenant_id,id,version])).rows[0];
  if(!v)throw new ExtensionError('not_found',404);return {enabled:v.enabled as boolean,active_version:v.active_version as number,definition:validateDefinition(v.definition)};
 };
 if(method==='GET')return tx(async c=>({bindings:(await c.query(`SELECT version,action_key,endpoint,enabled,binding_id,token_ciphertext IS NOT NULL has_token
  FROM studio_http_bindings WHERE tenant_id=$1 AND extension_id=$2 ORDER BY version DESC,action_key LIMIT 200`,[auth.tenant_id,id])).rows}));
 if(method!=='POST')throw new ExtensionError('not_found',404);
 if(body.operation==='bind')return tx(async c=>{
  exactObject(body,['operation','version','action_key','endpoint','bearer_token','confirm','enabled']);
  const v=await app(c,body.version),action=v.definition.actions?.find(a=>a.key===body.action_key&&a.kind==='http');
  if(!action)throw new ExtensionError('action_not_found',404);
  if(body.enabled===false){await c.query('UPDATE studio_http_bindings SET enabled=false,updated_at=NOW() WHERE tenant_id=$1 AND extension_id=$2 AND version=$3 AND action_key=$4',[auth.tenant_id,id,body.version,action.key]);return {enabled:false};}
  if(process.env.STUDIO_HTTP_ENABLED!=='true')throw new ExtensionError('studio_http_disabled',503);
  if(body.confirm!==true)throw new ExtensionError('permission_confirmation_required',403);
  const endpoint=studioEndpoint(body.endpoint).href;
  const token=body.bearer_token;
  if(token!==undefined&&(typeof token!=='string'||token.length>2048||/[\r\n\0]/.test(token)))throw new ExtensionError('invalid_http_token');
  // Every replacement issues a new identity; stale approvals cannot silently follow a new URL.
  await c.query(`INSERT INTO studio_http_bindings(tenant_id,extension_id,version,action_key,endpoint,token_ciphertext,approved_by)
   VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,extension_id,version,action_key) DO UPDATE
   SET endpoint=EXCLUDED.endpoint,token_ciphertext=EXCLUDED.token_ciphertext,approved_by=EXCLUDED.approved_by,enabled=true,binding_id=gen_random_uuid(),updated_at=NOW()`,
   [auth.tenant_id,id,body.version,action.key,endpoint,token?encryptWebhookSecret(token as string):null,auth.actor_id]);
  await c.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
   VALUES($1,'platform_user',$2,'studio.http_bound','tenant_extension',$3,$4,$5)`,[auth.tenant_id,auth.actor_id,id,JSON.stringify({version:body.version,action_key:action.key,fields:(action as Extract<StudioAction,{kind:'http'}>).fields}),requestId]);
  return {enabled:true};
 });
 exactObject(body,['operation','version','record_id','action_key','binding_id','confirm']);
 if(body.operation!=='run'||body.confirm!==true||typeof body.record_id!=='string'||!uuid.test(body.record_id))throw new ExtensionError('permission_confirmation_required',403);
 const prepared=await tx(async c=>{
  const v=await app(c,body.version);if(!v.enabled||v.active_version!==body.version)throw new ExtensionError('extension_not_active',409);
  const action=v.definition.actions?.find(a=>a.key===body.action_key);if(!action)throw new ExtensionError('action_not_found',404);
  if(process.env[action.kind==='http'?'STUDIO_HTTP_ENABLED':'STUDIO_CAMPAIGNS_ENABLED']!=='true')throw new ExtensionError('studio_action_disabled',503);
  const record=(await c.query('SELECT data FROM tenant_extension_records WHERE tenant_id=$1 AND extension_id=$2 AND version=$3 AND record_id=$4',[auth.tenant_id,id,body.version,body.record_id])).rows[0];
  if(!record)throw new ExtensionError('not_found',404);
  const payload=actionPayload(action,record.data);
  if(action.kind==='campaign'){const access=await tenantCampaignAccess(auth.tenant_id,c);if(!access.eligible)throw new ExtensionError(access.reason!,403);}
  if(Buffer.byteLength(JSON.stringify(payload))>24000)throw new ExtensionError('request_too_large',413);
  const binding=action.kind==='http'?(await c.query(`SELECT b.* FROM studio_http_bindings b JOIN tenant_memberships m ON m.tenant_id=b.tenant_id AND m.platform_user_id=b.approved_by
   JOIN platform_users u USING(platform_user_id) WHERE b.tenant_id=$1 AND b.extension_id=$2 AND b.version=$3 AND b.action_key=$4
   AND b.enabled AND m.status='active' AND m.role='tenant_admin' AND u.status='active' FOR SHARE OF b`,[auth.tenant_id,id,body.version,action.key])).rows[0]:null;
  if(action.kind==='http'&&(!binding||binding.binding_id!==body.binding_id))throw new ExtensionError('http_binding_changed',409);
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`studio-actions:${auth.tenant_id}`]);
  const existing=(await c.query('SELECT run_id,status,campaign_id FROM studio_action_runs WHERE tenant_id=$1 AND record_id=$2 AND action_key=$3',[auth.tenant_id,body.record_id,action.key])).rows[0];
  if(existing)return {existing};
  if(Number((await c.query("SELECT count(*)::int n FROM studio_action_runs WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '1 minute'",[auth.tenant_id])).rows[0].n)>=20)throw new ExtensionError('action_rate_limited',429);
  const run=(await c.query("INSERT INTO studio_action_runs(tenant_id,record_id,action_key,status,actor_id) VALUES($1,$2,$3,'sending',$4) RETURNING run_id",[auth.tenant_id,body.record_id,action.key,auth.actor_id])).rows[0];
  return {action,payload,binding,run_id:run.run_id};
 });
 if(prepared.existing)return {...prepared.existing,replayed:true,no_resend:true};
 let status='uncertain',campaignId:string|null=null;
 try{
  await tx(async c=>{
   const current=await app(c,body.version);
   if(!current.enabled||current.active_version!==body.version||process.env[prepared.action!.kind==='http'?'STUDIO_HTTP_ENABLED':'STUDIO_CAMPAIGNS_ENABLED']!=='true')throw new ExtensionError('studio_action_disabled',503);
   if(prepared.binding&&!(await c.query(`SELECT 1 FROM studio_http_bindings b JOIN tenant_memberships m ON m.tenant_id=b.tenant_id AND m.platform_user_id=b.approved_by
    JOIN platform_users u USING(platform_user_id) WHERE b.tenant_id=$1 AND b.extension_id=$2 AND b.version=$3 AND b.action_key=$4
    AND b.enabled AND b.binding_id=$5 AND m.status='active' AND m.role='tenant_admin' AND u.status='active'`,[auth.tenant_id,id,body.version,body.action_key,prepared.binding.binding_id])).rowCount)throw new ExtensionError('http_binding_changed',409);
  });
  // No database connection is held across external transport. Never retry a
  // potentially side-effecting POST whose outcome is uncertain.
  if(prepared.action!.kind==='http'){
   const token=prepared.binding.token_ciphertext?decryptWebhookSecret(prepared.binding.token_ciphertext):null;
   await ports.post(studioEndpoint(prepared.binding.endpoint),JSON.stringify(prepared.payload),{'content-type':'application/json','x-replynest-action-id':prepared.run_id,...(token?{authorization:`Bearer ${token}`}:{})},false);
  }else{
   const campaign=await ports.campaign(auth.tenant_id,prepared.payload! as Record<string,unknown>,`studio:${prepared.run_id}`,{actor_type:'console_session',actor_id:auth.actor_id,request_id:requestId});campaignId=campaign.campaign_id;
  }
  status='succeeded';
 }catch(error){
  if(error instanceof ExtensionError)throw error;
  if(error instanceof CampaignError)throw new ExtensionError(error.code,error.status);
 }finally{
  await pool.query('UPDATE studio_action_runs SET status=$4,campaign_id=$5,completed_at=NOW() WHERE tenant_id=$1 AND record_id=$2 AND action_key=$3',[auth.tenant_id,body.record_id,body.action_key,status,campaignId]);
  await pool.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
   VALUES($1,'platform_user',$2,'studio.action_result','tenant_extension',$3,$4,$5)`,[auth.tenant_id,auth.actor_id,id,JSON.stringify({run_id:prepared.run_id,version:body.version,action_key:body.action_key,status,campaign_id:campaignId}),requestId]);
 }
 return {run_id:prepared.run_id,status,campaign_id:campaignId,no_resend:true};
}
