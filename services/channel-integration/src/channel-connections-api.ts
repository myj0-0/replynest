import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { pool } from "./database.js";
import { readBody, sendJson } from "./shared.js";
import { assertCapacity,EntitlementLimitError } from "./subscriptions.js";
import { readWeChatCredentialMaterial } from "./wechat-connection.js";
import { writeWeChatCredential } from "./wechat-channel-secret-store.js";

type Auth = { tenant_id: string; role: "tenant_admin" | "supervisor" | "agent"; platform_user_id: string | null };

export async function handleChannelConnectionsApi(request: IncomingMessage, response: ServerResponse, url: URL, auth: Auth, requestId: string): Promise<boolean> {
  if (!url.pathname.startsWith("/api/v1/channels")) return false;
  if (request.method === "GET" && url.pathname === "/api/v1/channels") {
    const connections = await pool.query(
      `SELECT connection_id,channel_type,display_name,status,external_account_id,callback_key,credential_ref,configuration,last_checked_at,last_error_code,updated_at
         FROM channel_connections WHERE tenant_id=$1 ORDER BY created_at`, [auth.tenant_id]
    );
    const publicOrigin=(process.env.WECHAT_CALLBACK_PUBLIC_ORIGIN??"https://api.replynest.cn").replace(/\/$/,"");
    const data=await Promise.all(connections.rows.map(async row=>{
      const {credential_ref,...safe}=row as typeof row&{credential_ref:string|null};
      if(auth.role!=="tenant_admin"||!credential_ref||!row.callback_key)return safe;
      try{const material=await readWeChatCredentialMaterial(credential_ref);return{...safe,setup:{callback_url:`${publicOrigin}/webhooks/wechat-official/${row.callback_key}`,token:material.token,encoding_aes_key:material.encoding_aes_key}};}catch{return safe;}
    }));
    sendJson(response, 200, { request_id: requestId, data });
    return true;
  }
  if(request.method==="POST"&&url.pathname==="/api/v1/channels/wechat-official-account/draft"){
    if(auth.role!=="tenant_admin"||!auth.platform_user_id){sendJson(response,403,{request_id:requestId,error:{code:"forbidden"}});return true}
    const existing=await pool.query<{connection_id:string;callback_key:string;credential_ref:string}>(`SELECT connection_id,callback_key,credential_ref FROM channel_connections WHERE tenant_id=$1 AND channel_type='wechat_official_account' AND status='draft' AND configuration->>'mode'='live_setup' ORDER BY created_at DESC LIMIT 1`,[auth.tenant_id]);
    let connectionId=existing.rows[0]?.connection_id;let callbackKey=existing.rows[0]?.callback_key;let credentialRef=existing.rows[0]?.credential_ref;
    const token=randomBytes(16).toString("hex");const aes=randomBytes(32).toString("base64url");callbackKey=callbackKey??`rnwc_${randomBytes(16).toString("hex")}`;
    credentialRef=await writeWeChatCredential(`${callbackKey}.json`,{app_id:"",app_secret:"",token,encoding_aes_key:aes});
    const client=await pool.connect();try{await client.query("BEGIN");if(connectionId){await client.query(`UPDATE channel_connections SET credential_ref=$3,configuration=configuration||'{"mode":"live_setup","callback_verified":false}'::jsonb,last_error_code=NULL,updated_at=NOW() WHERE tenant_id=$1 AND connection_id=$2`,[auth.tenant_id,connectionId,credentialRef]);}else{const inserted=await client.query<{connection_id:string}>(`INSERT INTO channel_connections(tenant_id,channel_type,display_name,status,credential_ref,configuration,callback_key) VALUES($1,'wechat_official_account','微信公众号','draft',$2,'{"mode":"live_setup","callback_verified":false}'::jsonb,$3) RETURNING connection_id`,[auth.tenant_id,credentialRef,callbackKey]);connectionId=inserted.rows[0].connection_id;}await client.query(`INSERT INTO channel_connection_events(tenant_id,connection_id,event_type,result,detail) VALUES($1,$2,'setup_credentials_generated','succeeded','{}'::jsonb)`,[auth.tenant_id,connectionId]);await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'channel.wechat.setup_generated','channel_connection',$3,jsonb_build_object('callback_key',$4::text),$5)`,[auth.tenant_id,auth.platform_user_id,connectionId,callbackKey,requestId]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
    sendJson(response,201,{request_id:requestId,data:{connection_id:connectionId,status:"draft"}});return true;
  }
  const rotateCallbackMatch=url.pathname.match(/^\/api\/v1\/channels\/wechat-official-account\/([0-9a-f-]{36})\/callback-credentials$/i);
  if(request.method==="POST"&&rotateCallbackMatch){
    if(auth.role!=="tenant_admin"||!auth.platform_user_id){sendJson(response,403,{request_id:requestId,error:{code:"forbidden"}});return true}
    const connection=await pool.query<{connection_id:string;callback_key:string;credential_ref:string}>(`SELECT connection_id,callback_key,credential_ref FROM channel_connections WHERE tenant_id=$1 AND connection_id=$2 AND channel_type='wechat_official_account' AND status<>'disabled'`,[auth.tenant_id,rotateCallbackMatch[1]]);
    if(!connection.rows[0]?.callback_key||!connection.rows[0].credential_ref){sendJson(response,404,{request_id:requestId,error:{code:"channel_not_found"}});return true}
    const current=await readWeChatCredentialMaterial(connection.rows[0].credential_ref);const token=randomBytes(16).toString("hex"),aes=randomBytes(32).toString("base64url");
    const credentialRef=await writeWeChatCredential(`${connection.rows[0].callback_key}.json`,{...current,token,encoding_aes_key:aes});
    const client=await pool.connect();try{await client.query("BEGIN");await client.query(`UPDATE channel_connections SET credential_ref=$3,configuration=configuration||'{"callback_verified":false}'::jsonb,last_error_code=NULL,updated_at=NOW() WHERE tenant_id=$1 AND connection_id=$2`,[auth.tenant_id,rotateCallbackMatch[1],credentialRef]);await client.query(`INSERT INTO channel_connection_events(tenant_id,connection_id,event_type,result,detail) VALUES($1,$2,'callback_credentials_rotated','succeeded','{}'::jsonb)`,[auth.tenant_id,rotateCallbackMatch[1]]);await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'channel.wechat.callback_credentials_rotated','channel_connection',$3,'{"callback_verified":false}'::jsonb,$4)`,[auth.tenant_id,auth.platform_user_id,rotateCallbackMatch[1],requestId]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
    sendJson(response,200,{request_id:requestId,data:{connection_id:rotateCallbackMatch[1],status:"rotated"}});return true;
  }
  const credentialsMatch=url.pathname.match(/^\/api\/v1\/channels\/wechat-official-account\/([0-9a-f-]{36})\/credentials$/i);
  if(request.method==="POST"&&credentialsMatch){
    if(auth.role!=="tenant_admin"||!auth.platform_user_id){sendJson(response,403,{request_id:requestId,error:{code:"forbidden"}});return true}
    let input:Record<string,unknown>;try{input=JSON.parse((await readBody(request)).toString("utf8")) as Record<string,unknown>}catch{sendJson(response,400,{request_id:requestId,error:{code:"invalid_json"}});return true}
    const displayName=String(input.display_name??"").trim(),appId=String(input.app_id??"").trim(),appSecret=String(input.app_secret??"").trim();
    if(!displayName||displayName.length>80||!/^wx[A-Za-z0-9]{16}$/.test(appId)||!/^[A-Fa-f0-9]{32}$/.test(appSecret)){sendJson(response,400,{request_id:requestId,error:{code:"invalid_wechat_credentials"}});return true}
    const connection=await pool.query<{connection_id:string;callback_key:string;credential_ref:string;status:string}>(`SELECT connection_id,callback_key,credential_ref,status FROM channel_connections WHERE tenant_id=$1 AND connection_id=$2 AND channel_type='wechat_official_account' AND status<>'disabled'`,[auth.tenant_id,credentialsMatch[1]]);
    if(!connection.rows[0]){sendJson(response,404,{request_id:requestId,error:{code:"channel_not_found"}});return true}
    if(connection.rows[0].status!=="ready"){const count=await pool.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM channel_connections WHERE tenant_id=$1 AND status='ready' AND COALESCE(configuration->>'mode','')<>'synthetic'`,[auth.tenant_id]);try{await assertCapacity(auth.tenant_id,"channel_limit",count.rows[0].count)}catch(error){if(error instanceof EntitlementLimitError){sendJson(response,409,{request_id:requestId,error:{code:"entitlement_limit_reached",metric:error.metric,limit:error.limit,used:error.used}});return true}throw error}}
    const duplicate=await pool.query(`SELECT 1 FROM channel_connections WHERE tenant_id=$1 AND channel_type='wechat_official_account' AND external_account_id=$2 AND connection_id<>$3`,[auth.tenant_id,appId,credentialsMatch[1]]);if(duplicate.rows[0]){sendJson(response,409,{request_id:requestId,error:{code:"wechat_app_already_connected"}});return true}
    const current=await readWeChatCredentialMaterial(connection.rows[0].credential_ref);const credentialRef=await writeWeChatCredential(`${connection.rows[0].callback_key}.json`,{...current,app_id:appId,app_secret:appSecret});
    const client=await pool.connect();try{await client.query("BEGIN");await client.query(`UPDATE channel_connections SET display_name=$3,status='ready',external_account_id=$4,credential_ref=$5,configuration=configuration||'{"mode":"live","authorization":"app_secret","callback_verified":false}'::jsonb,last_error_code=NULL,updated_at=NOW() WHERE tenant_id=$1 AND connection_id=$2`,[auth.tenant_id,credentialsMatch[1],displayName,appId,credentialRef]);await client.query(`INSERT INTO channel_connection_events(tenant_id,connection_id,event_type,result,detail) VALUES($1,$2,'credentials_saved','succeeded',jsonb_build_object('app_id',$3::text))`,[auth.tenant_id,credentialsMatch[1],appId]);await client.query(`INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id) VALUES($1,'platform_user',$2,'channel.wechat.credentials_saved','channel_connection',$3,jsonb_build_object('app_id',$4::text),$5)`,[auth.tenant_id,auth.platform_user_id,credentialsMatch[1],appId,requestId]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
    sendJson(response,200,{request_id:requestId,data:{connection_id:credentialsMatch[1],status:"ready",app_id:appId}});return true;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/channels/wechat-official-account/synthetic-validate") {
    if (auth.role !== "tenant_admin" || !auth.platform_user_id) { sendJson(response, 403, { request_id: requestId, error: { code: "forbidden" } }); return true; }
    const existing=await pool.query(`SELECT 1 FROM channel_connections WHERE tenant_id=$1 AND channel_type='wechat_official_account' AND status<>'disabled'`,[auth.tenant_id]);
    if(!existing.rows[0]){const count=await pool.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM channel_connections WHERE tenant_id=$1 AND status='ready' AND COALESCE(configuration->>'mode','')<>'synthetic'`,[auth.tenant_id]);try{await assertCapacity(auth.tenant_id,"channel_limit",count.rows[0].count)}catch(error){if(error instanceof EntitlementLimitError){sendJson(response,409,{request_id:requestId,error:{code:"entitlement_limit_reached",metric:error.metric,limit:error.limit,used:error.used}});return true}throw error}}
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let connection = await client.query<{ connection_id: string }>(
        `UPDATE channel_connections SET status='ready',
             configuration='{"mode":"synthetic","authorization":"mock_oauth","callback_verified":true}'::jsonb,
             last_checked_at=NOW(),last_error_code=NULL,updated_at=NOW()
          WHERE tenant_id=$1 AND channel_type='wechat_official_account'
            AND external_account_id IS NULL AND configuration->>'mode'='synthetic'
        RETURNING connection_id`, [auth.tenant_id]
      );
      if (!connection.rows[0]) {
        connection = await client.query<{ connection_id: string }>(
          `INSERT INTO channel_connections(tenant_id,channel_type,display_name,status,configuration,last_checked_at)
           VALUES ($1,'wechat_official_account','合成微信公众号','ready','{"mode":"synthetic","authorization":"mock_oauth","callback_verified":true}'::jsonb,NOW())
           RETURNING connection_id`, [auth.tenant_id]
        );
      }
      await client.query(
        `INSERT INTO channel_connection_events(tenant_id,connection_id,event_type,result,detail)
         VALUES ($1,$2,'synthetic_validation','succeeded','{"oauth":"mock","callback":"verified","message_roundtrip":"covered_by_phase2"}'::jsonb)`,
        [auth.tenant_id, connection.rows[0].connection_id]
      );
      await client.query(
        `INSERT INTO audit_logs(tenant_id,actor_type,actor_id,action,resource_type,resource_id,after_data,request_id)
         VALUES ($1,'platform_user',$2,'channel.synthetic_validated','channel_connection',$3,'{"channel":"wechat_official_account"}'::jsonb,$4)`,
        [auth.tenant_id, auth.platform_user_id, connection.rows[0].connection_id, requestId]
      );
      await client.query("COMMIT");
      sendJson(response, 200, { request_id: requestId, data: { connection_id: connection.rows[0].connection_id, status: "ready", mode: "synthetic" } });
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return true;
  }
  sendJson(response, 404, { request_id: requestId, error: { code: "not_found" } });
  return true;
}
